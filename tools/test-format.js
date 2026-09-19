#!/usr/bin/env node
/* Standalone checks for the PURE helpers in resources/wwand/format.js.
 *
 * format.js is a LuCI module: the file body ends in a top-level `return
 * baseclass.extend({...})` and its `'require x'` lines are directives the LuCI
 * loader consumes, not real imports. So it cannot be `require()`d — but it can
 * be evaluated as a function body with the handful of globals LuCI would have
 * provided. That is all this harness does; it deliberately does not fake a DOM,
 * so only value-returning helpers are testable here (which is why the panel
 * decisions live in format.js as pure functions rather than inline in the view).
 *
 *   node tools/test-format.js
 */
'use strict';

const fs = require('fs');
const path = require('path');

const src = fs.readFileSync(
	path.join(__dirname, '..', 'htdocs', 'luci-static', 'resources', 'wwand', 'format.js'),
	'utf8');

/* drop the loader directives; keep every line number otherwise intact */
const body = src.replace(/^\s*'require [^']*';\s*$/gm, '');

/* LuCI installs String.prototype.format in cbi.js, which this repo does not
 * ship — so every helper that uses it was untestable here, which is why the
 * whole fmtMnc / fmtPlmn / fmtOperator family had no coverage until a review
 * found a wrong MNC in all three. A STUB, deliberately: it covers only the
 * directives format.js actually uses (%s, %d and %0Nd — verified by grep over
 * that file, 2026-09-19) and does no HTML escaping, because nothing asserted
 * here renders markup. A new directive appearing in format.js and not here
 * will show up as a literal in an expected value, not as a silent pass. */
String.prototype.format = function () {
	var args = arguments, i = 0;

	return this.replace(/%(0(\d+))?([sd%])/g, function (m, _pad, width, conv) {
		if (conv == '%')
			return '%';

		var v = args[i++];

		if (conv == 'd') {
			var out = String(Math.trunc(+v) || 0);

			while (width && out.length < +width)
				out = '0' + out;

			return out;
		}

		return String(v);
	});
};

const baseclass = { extend: (o) => o };
const _ = (s) => s;                       /* i18n passthrough */
const E = () => ({});                     /* no DOM here */
const ui = {};

const fmt = new Function('baseclass', '_', 'E', 'ui', body)(baseclass, _, E, ui);

let checks = 0, failures = 0;
function eq(got, want, label) {
	checks++;
	if (got === want)
		return;
	failures++;
	console.log(`FAIL: ${label}\n      got:  ${JSON.stringify(got)}\n      want: ${JSON.stringify(want)}`);
}

/* --- signalNone: the claim must match the registration block --------------- */
eq(fmt.signalNone({ registration: 1 }), 'registered — this modem reports no signal detail',
	'signalNone: registered modem is not called unregistered');
eq(fmt.signalNone({ registration: 0 }), 'no signal (modem not registered)',
	'signalNone: genuinely unregistered');
eq(fmt.signalNone(null), 'no signal (modem not registered)',
	'signalNone: no registration block -> the cautious claim');

/* it must agree with regShort(), which is what the Serving cell panel prints */
for (const reg of [ { registration: 1 }, { registration: 0 }, {} ]) {
	const registered = (fmt.regShort(reg) === 'registered');
	const claimsUnregistered = (fmt.signalNone(reg).indexOf('not registered') >= 0);
	eq(claimsUnregistered, !registered,
		`signalNone agrees with regShort for ${JSON.stringify(reg)}`);
}

/* --- signalSample: what the realtime graphs plot ------------------------- */
const S = (sig) => JSON.stringify(fmt.signalSample(sig));

/* ONE SERIES PER RAT, one GROUP PER QUANTITY. Slots:
     rsrp = [ RSRP LTE, RSRP 5G, RSCP 3G ] · rssi = [ LTE, 3G, 2G, untagged ]
     sinr = [ LTE, 5G ] · rsrq = [ LTE, 5G ] · ecio = [ 3G ]
   A modem flapping between RATs must not draw one line that silently changes
   which carrier it means — and on EN-DC both arrive in the SAME reply, so they
   are not alternatives. */
const NONE = { rsrp: [ null, null, null ], rssi: [ null, null, null, null ],
               sinr: [ null, null ], rsrq: [ null, null ], ecio: [ null ] };
const S_ = (over) => JSON.stringify(Object.assign({}, NONE, over));

eq(S({ nr5g: { rsrp: -106, snr: 160 }, lte: { rsrp: -94, snr: 240, rsrq: -9 } }),
   S_({ rsrp: [ -94, -106, null ], sinr: [ 24, 16 ], rsrq: [ -9, null ] }),
   'signalSample: en-dc keeps LTE and 5G apart');

/* SINR, RSRQ AND EC/IO ARE NOT ONE AXIS even though all three are dB: they
   measure different things and carry different boundaries. Sharing a group had
   a normal -12 dB RSRQ drawn below SINR's "poor" rule. */
eq(S({ lte: { snr: 240, rsrq: -12 }, nr5g: { snr: 160, rsrq: -11 } }),
   S_({ sinr: [ 24, 16 ], rsrq: [ -12, -11 ] }),
   'signalSample: sinr and rsrq are separate groups');

/* NR RSRQ ARRIVES BESIDE nr5g, NOT INSIDE IT — QMI NAS Get Signal Info puts NR
   RSRP/SNR in TLV 0x17 and NR RSRQ in TLV 0x18, so the decoded reply carries a
   top-level `nr5g_rsrq` (codec/schema/nas.uc:110-113). Reading only nr5g.rsrq
   drew an empty 5G RSRQ line, indistinguishable from a modem that does not
   report it. This is the shape an RG650E actually returns. */
eq(S({ lte: { rssi: -66, rsrq: -17, rsrp: -100, snr: 138 },
       nr5g: { rsrp: -32768, snr: -32768 }, nr5g_rsrq: -11 }),
   S_({ rsrp: [ -100, null, null ], rssi: [ -66, null, null, null ], sinr: [ 13.8, null ], rsrq: [ -17, -11 ] }),
   'signalSample: 5G rsrq comes from the top-level nr5g_rsrq');

/* AND IT IS PLAIN dB, not tenths. libqmi prints this TLV as '%d dB' with no
   scaling (qmicli-nas.c:581-584, 1.38.0) while it multiplies the neighbouring
   SNR by 0.1 — so the two sit side by side in one reply in different units. A
   review read the old test's -110 as evidence of a missing divide-by-ten; the
   value was simply unrealistic. -110 dB RSRQ does not exist, and a test whose
   numbers cannot occur invites exactly that misreading. */
eq(S({ nr5g_rsrq: -13 }), S_({ rsrq: [ null, -13 ] }),
   'signalSample: nr5g_rsrq is plain dB, not tenths');

eq(S({ nr5g: { rsrp: -32768, snr: -32768 }, nr5g_rsrq: -32768 }), S_({}),
   'signalSample: an unreported nr5g_rsrq stays a gap');

eq(S({ nr5g: { rsrq: -12 }, nr5g_rsrq: -110 }), S_({ rsrq: [ null, -12 ] }),
   'signalSample: a nested nr5g.rsrq still takes precedence');

/* 2G AND 3G ARE RATs TOO, and a modem falling back to one is exactly the event
   a graph should make visible.

   RSCP AND RSSI ARE NOT ONE SERIES. Both are 3G strength in dBm, but RSCP is
   the serving cell's pilot and RSSI is everything in the carrier; folding them
   with `rscp ?? rssi` gave a line that changed which measure it meant the
   moment a modem stopped reporting RSCP, with nothing on screen saying so. */
eq(S({ wcdma: { rscp: -95, rssi: -80, ecio: -7.5 } }),
   S_({ rsrp: [ null, null, -95 ], rssi: [ null, -80, null, null ], ecio: [ -7.5 ] }),
   'signalSample: 3G plots rscp and rssi as separate lines');
eq(S({ wcdma: { rssi: -80, ecio: -7.5 } }),
   S_({ rsrp: [ null, null, null ], rssi: [ null, -80, null, null ], ecio: [ -7.5 ] }),
   'signalSample: a 3G rssi without rscp stays in the rssi slot');

/* +CESQ calls the same measure `ecno` (atcmd_parse.uc:307) where QMI and ^HCSQ
   call it `ecio` — one quantity, two spellings, and a graph that reads only one
   of them goes blank depending on which parser answered */
eq(S({ wcdma: { rscp: -95, ecno: -9 } }),
   S_({ rsrp: [ null, null, -95 ], ecio: [ -9 ] }),
   'signalSample: ecno is the same measure as ecio');

eq(S({ gsm_rssi: -78 }), S_({ rsrp: [ null, null, null ], rssi: [ null, null, -78, null ] }),
   'signalSample: 2G plots its rssi in its own slot');

/* LTE only: the 5G slot stays null, and that gap is the point — it says 5G was
   not serving, which a single blended line could never show */
eq(S({ lte: { rsrp: -94, snr: 240, rsrq: -9 } }),
   S_({ rsrp: [ -94, null, null ], sinr: [ 24, null ], rsrq: [ -9, null ] }),
   'signalSample: lte-only leaves a gap in the 5G series');

eq(S({ nr5g: { rsrp: -88, snr: 180, rsrq: -11 } }),
   S_({ rsrp: [ null, -88, null ], sinr: [ null, 18 ], rsrq: [ null, -11 ] }),
   'signalSample: standalone 5G leaves a gap in the LTE series');

/* snr is TENTHS of a dB on every backend; plotting it raw draws a graph ten
   times too tall, and nothing about the picture would say so */
eq(S({ lte: { snr: 135 } }), S_({ sinr: [ 13.5, null ] }),
   'signalSample: snr scaled from tenths');

/* THE UNTAGGED SLOT IS ONLY FOR AN UNTAGGED VALUE. A top-level rssi is the
   AT+CSQ floor a NAS 1.0 stack falls back to (HW-seen on the E182E): nothing
   says which radio measured it, so it is drawn without a RAT. */
eq(S({ rssi: -101 }), S_({ rsrp: [ null, null, null ], rssi: [ null, null, null, -101 ] }),
   'signalSample: an untagged rssi plots in the untagged slot');

/* But `lte.rssi` IS tagged, and must not be laundered into that slot. It was:
   `sig.rssi ?? lte.rssi` meant that on a modem with no top-level value — the
   RM520N-GL, HW-observed 2026-09-10 — the line labelled plainly "RSSI" was the
   LTE one and never admitted it. */
eq(S({ lte: { rssi: -84 } }), S_({ rsrp: [ null, null, null ], rssi: [ -84, null, null, null ] }),
   'signalSample: an lte rssi is labelled LTE, not untagged');

/* BOTH PRESENT: the tagged one wins and the untagged slot stays empty. Modems
   really do report the same measurement twice — FM350-GL rssi -101 beside
   lte.rssi -101, E3372 -85 beside -86 (HW-observed 2026-09-10) — and drawing
   both produced a duplicate line distinguished only by claiming to have no
   radio behind it. */
eq(S({ rssi: -101, lte: { rssi: -84 } }),
   S_({ rsrp: [ null, null, null ], rssi: [ -84, null, null, null ] }),
   'signalSample: a tagged rssi suppresses the untagged line');
eq(S({ rssi: -83, gsm_rssi: -78 }),
   S_({ rsrp: [ null, null, null ], rssi: [ null, null, -78, null ] }),
   'signalSample: a 2G rssi suppresses it too');
eq(S({ rssi: -83, lte: { rsrp: -95 } }),
   S_({ rsrp: [ -95, null, null ], rssi: [ null, null, null, -83 ] }),
   'signalSample: an rsrp is not an rssi — the untagged line still shows');

/* RSSI IS NOT ON THE RSRP CANVAS. Its ladder sits 20 dB higher and a strong
   signal reaches -46 dBm, off the top of any scale drawn for RSRP — shared, it
   was pinned to the ceiling and showed nothing (HW screenshot, wwand#14). The
   two groups must therefore stay apart even when both are reported. */
eq(S({ lte: { rsrp: -78, rssi: -46 } }),
   S_({ rsrp: [ -78, null, null ], rssi: [ -46, null, null, null ] }),
   'signalSample: rsrp and rssi are separate groups, not one canvas');

/* A MISSING VALUE MUST STAY null. Zero is a legitimate dB reading and off the
   top of a dBm scale; turning a gap into 0 would draw "signal lost" where the
   modem merely said nothing. */
eq(S({}), S_({}), 'signalSample: nothing reported stays null, never 0');
eq(S(null), S_({}), 'signalSample: no reply at all');
eq(S({ lte: { rsrp: -32768, snr: -32768 } }), S_({}),
   'signalSample: the -32768 sentinel is not a measurement');

/* 0 dB SINR is marginal but real, and must survive as a value */
eq(S({ lte: { snr: 0, rsrp: -100 } }),
   S_({ rsrp: [ -100, null, null ], sinr: [ 0, null ] }),
   'signalSample: 0 dB is a reading, not a gap');

/* A 3-DIGIT MNC IS NOT KNOWABLE FROM THE NUMBER. 310/030 and 310/30 are
 * different operators and both are the integer 30, so padding to a fixed two
 * rendered the first as the second — across the operator line, the scan table
 * and the PLMN editor. The daemon sends `mnc_digits` for exactly this, from
 * the QMI PCS-digit TLVs and from the quoted PLMN id of an AT scan, and
 * nothing here read it. Found by a full review, 2026-09-19. */
eq(fmt.fmtMnc(30, 3), '030', 'fmtMnc: a declared 3-digit MNC keeps its leading zero');
eq(fmt.fmtMnc(30, 2), '30', 'fmtMnc: a declared 2-digit MNC does not gain one');
eq(fmt.fmtMnc(30), '30', 'fmtMnc: undeclared falls back to two');
eq(fmt.fmtMnc(6, 2), '06', 'fmtMnc: 260/06 still pads');
eq(fmt.fmtMnc(260), '260', 'fmtMnc: a value >= 100 settles its own width');
eq(fmt.fmtMnc(260, 2), '260', 'fmtMnc: ...and is never truncated to the declared two');
eq(fmt.fmtMnc(30, 9), '30', 'fmtMnc: a nonsense width is ignored, not looped on');
eq(fmt.fmtMnc(null, 3), '?', 'fmtMnc: nothing reported stays "?"');

eq(fmt.fmtPlmn(310, 30, 3), '310/030', 'fmtPlmn: the width reaches the pair');
eq(fmt.fmtPlmn(310, 30), '310/30', 'fmtPlmn: and its absence is the old behaviour');

/* the operator line takes it off the registration block, and when it falls
 * back to splitting the raw id the id itself states the width */
eq(fmt.fmtOperator({ plmn: { mcc: 310, mnc: 30, mnc_digits: 3, description: 'X' } }),
   'X (310/030)', 'fmtOperator: mnc_digits from the registration');
eq(fmt.fmtOperator({ plmn: { id: '310030', description: 'X' } }),
   'X (310/030)', 'fmtOperator: the raw id states its own width');
eq(fmt.fmtOperator({ plmn: { id: '31030', description: 'X' } }),
   'X (310/30)', 'fmtOperator: ...and the 2-digit one likewise');

/* fmtRegistration renders the same pair with the same hazard — a second
 * hardcoded %02d that fmtOperator's fix did not reach. */
eq(fmt.fmtRegistration({ registration: { registration: 1,
	plmn: { mcc: 310, mnc: 30, mnc_digits: 3 } } }),
   '310/030', 'fmtRegistration: the MNC width reaches this line too');
eq(fmt.fmtRegistration({ registration: { registration: 1,
	plmn: { mcc: 262, mnc: 1 } } }),
   '262/01', 'fmtRegistration: and a 2-digit MNC still pads');

console.log(`test-format: ${checks} checks, ${failures} failures`);
process.exit(failures ? 1 : 0);
