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

/* --- signalKind: what the panel can draw ---------------------------------- */
eq(fmt.signalKind({ lte: { rsrp: -98 } }), 'lte', 'signalKind: LTE RSRP wins');
eq(fmt.signalKind({ nr5g: { rsrp: -90 } }), 'nr', 'signalKind: 5G RSRP');
eq(fmt.signalKind({ lte: { rsrp: -98 }, nr5g: { rsrp: -90 } }), 'lte',
	'signalKind: LTE takes precedence over 5G');

/* The case from the field: FM350-GL on NCM reports rssi and nothing else
   (sponsor box, 2026-09-10). The EG06 on native MBIM does the same
   (telemetry_mbim.uc:42), as does a QMI modem camped on 2G/3G. */
eq(fmt.signalKind({ rssi: -101 }), 'rssi', 'signalKind: bare rssi is still signal');
eq(fmt.signalKind({ lte: {}, rssi: -101 }), 'rssi',
	'signalKind: an empty lte block does not mask the rssi');
eq(fmt.signalKind({}), 'none', 'signalKind: nothing at all');
eq(fmt.signalKind(null), 'none', 'signalKind: missing reply');

/* -32768 is the "not measured" sentinel, not a reading */
eq(fmt.signalKind({ rssi: -32768 }), 'none', 'signalKind: sentinel is not a value');
eq(fmt.signalKind({ lte: { rsrp: -32768 }, rssi: -101 }), 'rssi',
	'signalKind: a sentinel RSRP falls through to rssi');

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

console.log(`test-format: ${checks} checks, ${failures} failures`);
process.exit(failures ? 1 : 0);
