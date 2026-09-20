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
	/* structural where it matters: several helpers answer with a list, and
	   `===` on two arrays is always false — which reports a failure whose
	   "got" and "want" print identically and sends the reader hunting */
	if (got === want ||
	    (got && want && typeof got == 'object' && typeof want == 'object' &&
	     JSON.stringify(got) === JSON.stringify(want)))
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

/* --- the one eUICC rule ---------------------------------------------------
 *
 * Three call sites used to answer "which slot's eSIM can be read" for
 * themselves, and two of them disagreed. The rule includes `active` because the
 * APDU channel belongs to the active card — an eUICC in the other slot is not
 * addressable without switching first. */
eq(fmt.euiccReadable({ is_euicc: true, active: true, card: 'present', physical: 1 }),
   true, 'euicc: an active, present eUICC is readable');
eq(fmt.euiccReadable({ is_euicc: true, active: false, card: 'present', physical: 2 }),
   false, 'euicc: ...one in the inactive slot is not');
eq(fmt.euiccReadable({ is_euicc: true, active: true, card: 'absent', physical: 1 }),
   false, 'euicc: ...nor an empty slot');
eq(fmt.euiccReadable({ is_euicc: false, active: true, card: 'present', physical: 1 }),
   false, 'euicc: ...nor a plain SIM');
/* 0 is not a slot: slots are 1-based everywhere the daemon builds them, and 0
 * was the value that slipped through its `?? 1` and addressed a non-slot */
eq(fmt.euiccReadable({ is_euicc: true, active: true, card: 'present', physical: 0 }),
   false, 'euicc: ...nor physical slot 0');
eq(fmt.euiccReadable(null), false, 'euicc: ...and no slot at all is not readable');

eq(fmt.euiccSlot([
	{ is_euicc: false, active: true, card: 'present', physical: 1 },
	{ is_euicc: true, active: true, card: 'present', physical: 2 },
]).physical, 2, 'euicc: the readable slot is found in a mixed list');
eq(fmt.euiccSlot([ { is_euicc: true, active: false, card: 'present', physical: 2 } ]),
   null, 'euicc: an unreachable eUICC yields null, not a slot to guess with');
eq(fmt.euiccSlot([]), null, 'euicc: an empty slot list yields null');
eq(fmt.euiccSlot(undefined), null, 'euicc: ...and so does a missing one');

/* --- collapsing a scan ----------------------------------------------------
 *
 * The identity of an operator includes the WIDTH of its MNC: 310/030 and
 * 310/30 are two of them. Collapsing on the bare number merged the pair into
 * one row which then inherited the other's status and technologies. */
(function () {
	var out = fmt.collapseScan([
		{ mcc: 310, mnc: 30, mnc_digits: 2, status: 'available', rats: [ 'LTE' ] },
		{ mcc: 310, mnc: 30, mnc_digits: 3, status: 'forbidden', rats: [ 'GSM' ] },
	]);

	eq(out.length, 2, 'collapseScan: 310/30 and 310/030 stay two operators');
	eq(out[0].status, 'available', 'collapseScan: ...each keeping its own status');
	eq(out[1].status, 'forbidden', 'collapseScan: ...and the other keeping its own');

	/* the collapse it IS supposed to do: one operator listed per RAT */
	var same = fmt.collapseScan([
		{ mcc: 262, mnc: 1, mnc_digits: 2, status: 'available', rats: [ 'LTE' ] },
		{ mcc: 262, mnc: 1, mnc_digits: 2, status: 'current', rats: [ 'NR5G' ] },
	]);

	eq(same.length, 1, 'collapseScan: one operator listed twice becomes one row');
	eq(same[0].status, 'current', 'collapseScan: ...keeping the strongest status');
	eq(Object.keys(same[0]._rats).sort(), [ 'LTE', 'NR5G' ],
		'collapseScan: ...and the union of its technologies');

	/* a scan that reports no width at all still collapses by PLMN, rather than
	   splitting every entry apart on an undefined */
	var nodig = fmt.collapseScan([
		{ mcc: 262, mnc: 2, status: 'available', rats: [ 'LTE' ] },
		{ mcc: 262, mnc: 2, status: 'available', rats: [ 'GSM' ] },
	]);

	eq(nodig.length, 1, 'collapseScan: entries without mnc_digits still collapse');
	eq(fmt.collapseScan(undefined), [], 'collapseScan: no list is an empty list');
})();

/* --- MBIMEx data subclass / frequency range -------------------------------
 *
 * Both are BITMASKS, and the data subclass is the authoritative answer to a
 * question the rest of the page infers: 5G on an LTE anchor (ENDC) versus
 * standalone. Values from libmbim 1.32.0 mbim-enums.h:1867-1872 and :1627-1629.
 */
eq(fmt.fmtDataSubclass(1 << 0), 'ENDC', 'subclass: bit 0 is ENDC — 5G NSA');
eq(fmt.fmtDataSubclass(1 << 1), '5G NR', 'subclass: bit 1 is standalone');
eq(fmt.fmtDataSubclass((1 << 0) | (1 << 3)), 'ENDC + ELTE',
   'subclass: it is a mask, so several can be set at once');
/* an unknown bit says so rather than vanishing: a modem setting one is telling
   us something this table does not know yet */
eq(fmt.fmtDataSubclass(1 << 20), '0x100000', 'subclass: an unknown bit is reported as itself');
/* ...INCLUDING BESIDE A KNOWN ONE. The first version fell back to hex only when
 * nothing was recognised, so 0x21 came back as a bare "ENDC" and the bit this
 * table does not know vanished — the one case where silence is worst. */
eq(fmt.fmtDataSubclass(0x21), 'ENDC + 0x20',
   'subclass: an unknown bit survives next to a known one');
eq(fmt.fmtDataSubclass(0), null, 'subclass: zero means the modem said nothing');
eq(fmt.fmtDataSubclass(null), null, 'subclass: ...and so does an absent field');

/* SPELLED OUT by default: "FR1" is 3GPP's name and means nothing to a reader
   who has not looked it up, and the whole reason to show the row is that the
   two ranges behave completely differently. */
eq(fmt.fmtFrequencyRange(1), 'FR1 (sub-6 GHz)', 'range: FR1 is resolved, not left as a code');
eq(fmt.fmtFrequencyRange(2), 'FR2 (mmWave, 24 GHz and above)', 'range: ...and so is FR2');
eq(fmt.fmtFrequencyRange(3), 'FR1 (sub-6 GHz) + FR2 (mmWave, 24 GHz and above)',
   'range: aggregation can span both');
/* the bare form stays available for places with no room for the gloss */
eq(fmt.fmtFrequencyRange(1, false), 'FR1', 'range: the short form is still reachable');
eq(fmt.fmtFrequencyRange(1 << 5), '0x20', 'range: an unknown bit is reported as itself');
eq(fmt.fmtFrequencyRange(5), 'FR1 (sub-6 GHz) + 0x4',
   'range: ...and survives next to a known one');
eq(fmt.fmtFrequencyRange(0), null, 'range: zero is absent, not "unknown"');
eq(fmt.fmtFrequencyRange(null), null, 'range: and so is null');

/* --- carrierSample: the aggregation picture is STACKED ---------------------
 *
 * The second series is the TOTAL, not the 5G count on its own. Drawn
 * absolutely, "LTE 2 + 5G 1" put lines at 2 and 1, which reads as the 5G leg
 * being the smaller half of a link carrying 2 — rather than the third carrier
 * of a link carrying 3.
 */
(function () {
	/* EN-DC: two LTE carriers plus one 5G carrier on the same link */
	var ca = fmt.carrierSample({
		ca: [ { role: 'PCC', bandwidth_mhz: 20 },
		      { role: 'SCC', state: 2, bandwidth_mhz: 10 },
		      { role: 'PCC', rat: 'nr', bandwidth_mhz: 100 } ],
		dsd: { nr: true },
	});
	eq(ca.ca, [ 2, 3 ], 'carrierSample: LTE 2, total 3 — the upper line is the sum');
	eq(ca.bw, [ 30, 130 ], 'carrierSample: ...and the bandwidth stacks the same way');

	/* LTE only: ONE line, not two identical ones. A total that merely repeats
	   the anchor says nothing and doubles the ink. */
	var lte = fmt.carrierSample({
		ca: [ { role: 'PCC', bandwidth_mhz: 20 } ],
	});
	eq(lte.ca, [ 1, null ], 'carrierSample: with no 5G leg the total line is absent');
	eq(lte.bw, [ 20, null ], 'carrierSample: ...for bandwidth too');

	/* A 5G band that is VISIBLE but not serving must not draw a line — the
	   RG502QEA reports a neighbouring NR band while parked on LTE
	   (format.js, HW note 2026-09-12). `dsd.nr` is the gate. */
	var parked = fmt.carrierSample({
		serving: { lte: { bandwidth_mhz: 10 }, nr: { bandwidth_mhz: 100 } },
		dsd: { nr: false },
	});
	eq(parked.ca, [ 1, null ], 'carrierSample: a visible-but-not-serving 5G band draws nothing');

	/* ...and when it IS serving, the serving cell supplies the floor */
	var serving = fmt.carrierSample({
		serving: { lte: { bandwidth_mhz: 10 }, nr: { bandwidth_mhz: 100 } },
		dsd: { nr: true },
	});
	eq(serving.ca, [ 1, 2 ], 'carrierSample: a serving 5G leg lifts the total to 2');

	/* a deconfigured SCC is not a carrier (QmiNasScellState 0/1) */
	var deconf = fmt.carrierSample({
		ca: [ { role: 'PCC' }, { role: 'SCC', state: 0 } ],
	});
	eq(deconf.ca, [ 1, null ], 'carrierSample: an unactivated SCC is still not counted');
})();

console.log(`test-format: ${checks} checks, ${failures} failures`);
process.exit(failures ? 1 : 0);
