'use strict';
'require baseclass';
'require ui';

/* Shared formatting/rendering helpers for the wwand LuCI packages (status
   page, settings page, Modems overview and the proto handler). Single source
   so the value formatters and the small table/warning renderers are not
   copy-pasted across resources. */

return baseclass.extend({
	fmtList: function(a) { return (a && a.length) ? a.join(', ') : '—'; },

	/* a technical term with a mouse-over explanation: dotted underline +
	   help cursor signal that hovering reveals the description (title attr) */
	term: function(label, desc) {
		return E('span', { 'title': desc,
			'style': 'cursor:help;text-decoration:underline dotted;text-underline-offset:2px' },
			label);
	},

	/* MNC as a zero-padded code: the leading zero is significant (260/06 is not
	   260/6). QMI hands us a bare integer (digit count lost), so pad to 2 digits
	   minimum; genuine 3-digit MNCs (>=100) keep all three. */
	fmtMnc: function(mnc) {
		if (mnc == null || mnc === '')
			return '?';
		return '%02d'.format(+mnc);
	},

	/* registered operator line — "Name (mcc/mnc) · roaming" — from the modem's
	   `registration` block; shared by the status page and the proto handler */
	fmtOperator: function(reg) {
		var plmn = reg && reg.plmn;
		if (!plmn)
			return null;
		return '%s (%s/%s)%s'.format((plmn.description || '').trim(),
			plmn.mcc, this.fmtMnc(plmn.mnc),
			(reg && reg.roaming) ? ' \u00b7 ' + _('roaming') : '');
	},

	/* one SIM-slot row (status page + SIM/eSIM tools panel): identity line
	   plus a "Switch now" button on an inactive present slot. `extras` =
	   page-specific buttons rendered before it (e.g. "Set as primary");
	   `onSwitch(physical)` runs after the shared confirm. */
	simSlotRow: function(sl, onSwitch, extras) {
		var line = [
			E('strong', {}, _('Slot %d').format(sl.physical) +
				(sl.is_euicc ? ' (eSIM)' : '') + (sl.active ? ' \u2713' : '')),
			' \u2014 ' + sl.card + (sl.iccid ? (', ICCID ' + sl.iccid) : '') +
				(sl.eid ? (', EID ' + sl.eid) : '')
		];
		(extras || []).forEach(function(b) { line.push(b); });
		if (!sl.active && sl.card == 'present' && onSwitch)
			line.push(E('button', { 'class': 'btn cbi-button cbi-button-apply',
				'style': 'margin-left:4px',
				'click': ui.createHandlerFn(null, function() {
					if (!confirm(_('Switch to SIM slot %d? The connection will drop and re-establish.').format(sl.physical)))
						return;
					return onSwitch(sl.physical);
				}) }, _('Switch now')));
		return E('div', { 'style': 'margin-bottom:4px' }, line);
	},

	fmtBytes: function(n) {
		if (n == null) return '—';
		var u = ['B','KB','MB','GB','TB'], i = 0;
		while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
		return (i ? n.toFixed(2) : n) + ' ' + u[i];
	},

	fmtDur: function(s) {
		if (s == null) return '—';
		var d = Math.floor(s/86400); s -= d*86400;
		var h = Math.floor(s/3600);  s -= h*3600;
		var m = Math.floor(s/60),  sec = s - m*60;
		if (d) return '%dd %dh %dm'.format(d, h, m);
		if (h) return '%dh %dm'.format(h, m);
		if (m) return '%dm %ds'.format(m, sec);
		return '%ds'.format(sec);
	},

	fmtRate: function(bps) {
		if (bps == null || bps <= 0) return '—';
		return (bps >= 1e9) ? (bps/1e9).toFixed(2) + ' Gbps' : (bps/1e6).toFixed(1) + ' Mbps';
	},

	dBm: function(v) { return (v != null) ? (v / 10).toFixed(1) + ' dBm' : null; },
	dB:  function(v) { return (v != null) ? (v / 10).toFixed(1) + ' dB' : null; },

	/* signal values use -32768 as the "not measured" sentinel */
	hasSignal: function(v) { return v != null && v > -32768; },

	/* frequency in MHz (plain number, NOT tenths) -> "1234.5 MHz" */
	mhz: function(v) { return (v != null) ? v.toFixed(1) + ' MHz' : null; },

	/* one-word registration state for status rows/columns */
	regShort: function(reg) {
		return (reg && reg.registration == 1) ? _('registered') : _('searching');
	},

	/* two-column label/value table; widthPercent = width of the label column
	   (default 30 — the proto handler uses 33). */
	tbl: function(rows, widthPercent) {
		var w = (widthPercent || 30) + '%';
		return E('table', { 'class': 'table' }, rows.map(function(r) {
			return E('tr', { 'class': 'tr' }, [
				E('td', { 'class': 'td left', 'width': w }, r[0]),
				E('td', { 'class': 'td left' }, r[1]) ]);
		}));
	},

	/* status().config_warnings for a modem (added by the daemon). Absent/empty
	   -> null so nothing is rendered. Inline-styled — no external CSS needed. */
	renderWarnings: function(warns) {
		if (!warns || !warns.length)
			return null;
		var items = warns.map(function(w) {
			var warn = (w.severity == 'warn');
			var det = [];
			if (w.expected != null) det.push(_('expected') + ': ' + w.expected);
			if (w.actual != null)   det.push(_('actual') + ': ' + w.actual);
			return E('div', { 'style': 'display:flex;gap:9px;align-items:flex-start;padding:8px 12px;' +
				'border-radius:6px;margin:5px 0;' +
				(warn ? 'background:rgba(192,57,43,.12);color:#b3271a' : 'background:rgba(11,111,194,.11);color:#0b6fc2') }, [
				E('span', { 'style': 'font-size:1.15em;flex:none' }, warn ? '⚠' : 'ℹ'),
				E('div', {}, [
					E('div', {}, [ w.check ? E('strong', {}, w.check + ': ') : '', w.message || '' ]),
					det.length ? E('div', { 'style': 'opacity:.85;font-size:.9em;margin-top:2px' }, det.join(' · ')) : '' ]) ]);
		});
		return E('div', { 'class': 'cbi-section' },
			[ E('h3', {}, _('Configuration warnings')) ].concat(items));
	},

	/* Canonical COMPACT one-line mappings of a modem-info object's
	   registration / SIM state (as used by the Modems overview table). The
	   status page and the proto handler render richer views on purpose and do
	   not use these. */
	fmtRegistration: function(mi) {
		var reg = mi && mi.registration;

		if (!reg)
			return '-';

		if (reg.registration == 1) {
			var op = (reg.plmn && (reg.plmn.description ||
				('%d/%02d'.format(reg.plmn.mcc, reg.plmn.mnc)))) || _('registered');
			return op + (reg.roaming ? ' ' + _('(roaming)') : '');
		}

		var det = mi.registration_detail;

		if (det && det.reject_text)
			return _('rejected: %s').format(det.reject_text);

		return _('searching…');
	},

	fmtSim: function(mi) {
		if (!mi)
			return '-';

		if (mi.sim_block)
			return _('blocked (%s)').format(mi.sim_block.reason || '?');

		if (mi.state == 'WAITING_MODEM' || mi.state == 'UNRESOLVED')
			return '-';

		if (mi.pin1)
			return mi.pin1.enabled ? _('ready, PIN enabled') : _('ready');

		return '-';
	}
});
