'use strict';
'require view';
'require poll';
'require dom';
'require ui';
'require wwand.bands as bands';
'require wwand.rpc as wrpc';
'require wwand.format as fmt';

/* ubus declarations live in the shared wwand.rpc module */
var callStatus = wrpc.status;
var callContexts = wrpc.contexts;
var callSignal = wrpc.signal;
var callCells = wrpc.cells;
var callDatapath = wrpc.datapath;
var callCtxStatus = wrpc.ctxStatus;
var callSlots = wrpc.slots;
var callSwitchSlot = wrpc.switchSlot;

/* value formatters live in the shared wwand.format module */
var fmtList = fmt.fmtList;
var fmtBytes = fmt.fmtBytes;
var fmtDur = fmt.fmtDur;
var fmtRate = fmt.fmtRate;
var dBm = fmt.dBm;
var dB = fmt.dB;
var tbl = fmt.tbl;
var renderWarnings = fmt.renderWarnings;

/* Band/frequency helpers come from the shared wwand.bands module. */



/* Unified cell table: carrier-aggregation carriers and neighbour cells share the
   same columns in the same positions, so CA cells and neighbours can be compared
   at a glance. Each source fills the fields it has; the rest show "—". */
/* translatable headers are marked with literal _() so the i18n scanner picks
   them up (a runtime _(h) on a variable is invisible to it); acronyms stay as-is */
var CELL_HEAD = [ _('Type'), _('Band'), 'EARFCN', _('Frequency'), _('Bandwidth'), 'PCI', 'RSRP', 'RSRQ', _('Lock') ];
function cellHead() {
	return E('tr', { 'class': 'tr table-titles' }, CELL_HEAD.map(function(h) {
		return E('th', { 'class': 'th' }, h);
	}));
}
function cd(v) { return E('td', { 'class': 'td' }, (v == null || v === '') ? '—' : ('' + v)); }
function cellRow(o) {
	return E('tr', { 'class': 'tr' }, [ cd(o.type), cd(o.band), cd(o.earfcn),
		cd(o.freq), cd(o.bw), cd(o.pci), cd(o.rsrp), cd(o.rsrq), cd(o.lock) ]);
}
function cellTable(title, rows) {
	return E('div', { 'class': 'cbi-section' }, [ E('h3', {}, title),
		E('table', { 'class': 'table' }, [ cellHead() ].concat(rows)) ]);
}
function mhz(f) { return f ? f.mhz.toFixed(1) + ' MHz' : null; }

/* peak-hold across polls, per modem, for antenna alignment */
var peak = {};
function trackPeak(name, key, val) {
	if (val == null) return null;
	peak[name] = peak[name] || {};
	if (peak[name][key] == null || val > peak[name][key]) peak[name][key] = val;
	return peak[name][key];
}

/* colour by quality thresholds [good, fair] (higher = better) */
function qcolor(v, good, fair) {
	if (v == null) return '#888';
	if (v >= good) return '#3c3'; if (v >= fair) return '#da3'; return '#e33';
}

/* a labelled bar: value mapped from [min,max] to 0..100% */
function bar(label, val, unit, min, max, good, fair) {
	var pct = (val == null) ? 0 : Math.max(0, Math.min(100, (val - min) / (max - min) * 100));
	var col = qcolor(val, good, fair);
	return E('div', { 'style': 'margin:4px 0' }, [
		E('div', { 'style': 'display:flex;justify-content:space-between' }, [
			E('span', {}, label),
			E('strong', { 'style': 'color:%s'.format(col) },
				(val == null) ? '—' : '%s %s'.format(val, unit))
		]),
		E('div', { 'style': 'background:#eee;border-radius:3px;height:10px;overflow:hidden' },
			E('div', { 'style': 'width:%d%%;height:100%%;background:%s'.format(pct, col) }))
	]);
}

/* Per-context connection detail: IPs, gateways, DNS, MTU — the stuff you
   otherwise only see by digging through ubus / the modem. */
function renderConnections(details) {
	var conns = details.filter(function(d) { return d.st && !d.st.error; });
	if (!conns.length)
		return null;

	var cards = conns.map(function(d) {
		var s = d.st.settings || {}, v4 = s.ipv4, v6 = s.ipv6;
		var st = d.st.state || d.cfg.state || '?';
		var rows = [
			[ _('Interface'), d.cfg.interface + (d.cfg.mux_id ? ' · mux %d'.format(d.cfg.mux_id) : '') ],
			[ _('State'), E('strong', { 'style': 'color:%s'.format(st == 'CONNECTED' ? '#3c3' : '#da3') }, st) ]
		];
		if (v4) {
			rows.push([ _('IPv4'), '%s/%d'.format(v4.addr, v4.prefix) ]);
			rows.push([ _('IPv4 gateway'), v4.gateway || '—' ]);
			rows.push([ _('IPv4 DNS'), fmtList(v4.dns) ]);
		}
		if (v6) {
			rows.push([ _('IPv6'), '%s/%d'.format(v6.addr, v6.plen) ]);
			rows.push([ _('IPv6 gateway'), v6.gateway || '—' ]);
			rows.push([ _('IPv6 DNS'), fmtList(v6.dns) ]);
		}
		if (!v4 && !v6)
			rows.push([ _('IP'), E('em', {}, _('not connected')) ]);
		rows.push([ _('MTU'), '' + (s.mtu || '—') ]);

		if (d.st.uptime != null)
			rows.push([ _('Uptime'), fmtDur(d.st.uptime) ]);
		var dc = d.st.stats;
		if (dc) {
			rows.push([ _('Data'), '\u2193 %s \u00b7 \u2191 %s'.format(fmtBytes(dc.rx_bytes), fmtBytes(dc.tx_bytes)) ]);
			if ((dc.rx_errors||0)+(dc.tx_errors||0)+(dc.rx_dropped||0)+(dc.tx_dropped||0) > 0)
				rows.push([ _('Errors / dropped'),
					'rx %d/%d \u00b7 tx %d/%d'.format(dc.rx_errors||0, dc.rx_dropped||0, dc.tx_errors||0, dc.tx_dropped||0) ]);
		}

		var cr = d.st.channel_rate;
		if (cr && (cr.max_rx_rate || cr.max_tx_rate))
			rows.push([ _('Max rate'),
				'\u2193 %s \u00b7 \u2191 %s'.format(fmtRate(cr.max_rx_rate), fmtRate(cr.max_tx_rate)) ]);

		/* last activation failure (bad password / forbidden APN / …) */
		var le = d.st.last_error;
		if (le && le.text && st != 'CONNECTED')
			rows.push([ _('Last error'), E('span', { 'style': 'color:#e33' },
				'%s%s'.format(le.text, (le.code != null) ? ' (%s %s)'.format(le.type || _('code'), le.code) : '')) ]);

		return E('div', { 'class': 'cbi-section', 'style': 'flex:1;min-width:280px' }, [
			E('h4', { 'style': 'margin:0 0 4px' }, d.cfg.interface), tbl(rows)
		]);
	});

	return E('div', { 'class': 'cbi-section' }, [
		E('h3', {}, _('Active connections')),
		E('div', { 'style': 'display:flex;gap:16px;flex-wrap:wrap' }, cards)
	]);
}

/* Datapath / muxing: the link-layer config wwand applied at datapath setup
   (backend, QMAP aggregation the modem negotiated, endpoint) plus the live
   aggregation seen on the wire — the mean number of packets the modem packs
   into one USB frame (parent frames vs demuxed child packets). */
function fmtProto(p) {
	/* WDA data-aggregation protocol enum */
	return ({ 0: '—', 1: 'none', 2: 'QMAP', 3: 'QMAP', 5: 'QMAPv5' })[p] || ('' + p);
}
function renderDatapath(dp) {
	if (!dp || dp.error || !dp.backend)
		return null;

	var rows = [
		[ _('Backend'), dp.backend + (dp.v5 ? ' · QMAPv5' : '') ],
		[ _('Parent device'), dp.parent || '—' ]
	];
	if (dp.urb_size)
		rows.push([ _('URB / frame size'), fmtBytes(dp.urb_size) ]);

	var wda = dp.wda || {};
	if (wda.dl_max_datagrams != null)
		rows.push([ _('Downlink aggregation (negotiated)'),
			_('%s protocol · up to %d datagrams / %s').format(
				fmtProto(wda.dl_protocol), wda.dl_max_datagrams, fmtBytes(wda.dl_max_size)) ]);
	if (wda.ul_max_datagrams != null)
		rows.push([ _('Uplink aggregation (negotiated)'),
			_('%s protocol · up to %d datagrams / %s').format(
				fmtProto(wda.ul_protocol), wda.ul_max_datagrams, fmtBytes(wda.ul_max_size)) ]);

	/* MBIM/NCM NTB aggregation (cdc_ncm framing) */
	var ntb = dp.ntb;
	if (ntb) {
		if (ntb.rx_max != null)
			rows.push([ _('Downlink NTB (aggregation buffer)'), fmtBytes(ntb.rx_max) ]);
		if (ntb.tx_max != null)
			rows.push([ _('Uplink NTB'),
				fmtBytes(ntb.tx_max) + (ntb.tx_max_datagrams != null ?
					_(' · up to %d datagrams').format(ntb.tx_max_datagrams) : '') ]);
		if (ntb.tx_timer_usecs != null)
			rows.push([ _('Uplink coalescing timer'), ntb.tx_timer_usecs + ' µs' ]);
	}

	/* mux channels */
	(dp.channels || []).forEach(function(c) {
		rows.push([ _('Mux channel %d').format(c.mux_id),
			'%s → %s'.format(c.netdev, c.interface) ]);
	});

	/* live datapath counters (every backend) + the QMAP aggregation ratio
	   (rmnet/qmimux only — on MBIM/NCM the NTB block above is the aggregation
	   indicator; the parent-vs-child packet ratio there is meaningless) */
	var st = dp.stats;
	if (st && st.parent) {
		var p = st.parent, kids = st.children || {};
		var kidRx = 0, kidTx = 0;
		Object.keys(kids).forEach(function(k){ kidRx += (kids[k].rx_packets||0); kidTx += (kids[k].tx_packets||0); });

		if (st.rx_aggregation != null) {
			rows.push([ E('strong', {}, _('Downlink packets / frame')),
				E('strong', { 'style': 'color:%s'.format(st.rx_aggregation >= 2 ? '#3c3' : '#da3') },
					st.rx_aggregation.toFixed(2) + '×') ]);
			rows.push([ _('… based on'),
				_('%d demuxed packets over %d USB frames').format(kidRx, p.rx_packets || 0) ]);
			if (st.tx_aggregation != null)
				rows.push([ _('Uplink packets / frame'),
					'%s× (%d / %d)'.format(st.tx_aggregation.toFixed(2), kidTx, p.tx_packets || 0) ]);
		}

		rows.push([ _('Datapath counters (parent)'),
			'↓ %s · ↑ %s'.format(fmtBytes(p.rx_bytes), fmtBytes(p.tx_bytes)) ]);
	}

	return E('div', { 'class': 'cbi-section' }, [
		E('h3', {}, _('Datapath & muxing')), tbl(rows)
	]);
}

function renderLive(name, modem) {
	return Promise.all([
		L.resolveDefault(callSignal(name), {}),
		L.resolveDefault(callCells(name), {}),
		L.resolveDefault(callContexts(), {}),
		L.resolveDefault(callSlots(name), {}),
		L.resolveDefault(callDatapath(name), {})
	]).then(function(res) {
		var sig = res[0] || {}, cells = (res[1] || {}).cells || {};
		var allCtx = res[2] || {};
		var dpath = res[4] || {};
		var myCtx = Object.keys(allCtx)
			.filter(function(k){ return allCtx[k].modem == name; })
			.map(function(k){ return { name: k, cfg: allCtx[k] }; });

		/* fetch per-context IP settings in parallel, then render everything */
		return Promise.all(myCtx.map(function(c){
			return L.resolveDefault(callCtxStatus(c.cfg.interface), {})
				.then(function(st){ return { name: c.name, cfg: c.cfg, st: st }; });
		})).then(function(ctxDetails){
		var reg = modem.registration || {};
		var lte = sig.lte || {}, nr = sig.nr5g || {};
		var cols = [];

		/* --- signal panel (alignment) --- */
		var sigRows = [];
		if (fmt.hasSignal(lte.rsrp)) {
			sigRows.push(bar(_('LTE RSRP'), lte.rsrp, 'dBm', -120, -70, -90, -105));
			sigRows.push(bar(_('LTE RSRQ'), lte.rsrq, 'dB', -20, -3, -10, -15));
			sigRows.push(bar(_('LTE SINR'), (lte.snr/10), 'dB', -5, 30, 13, 0));
			var pk = trackPeak(name, 'rsrp', lte.rsrp);
			var pkq = trackPeak(name, 'sinr', lte.snr/10);
			sigRows.push(E('div', { 'style': 'margin-top:6px;color:#666;font-size:90%' },
				_('Peak: RSRP %s dBm · SINR %s dB').format(pk, (pkq != null) ? pkq.toFixed(1) : '—')));
		}
		if (fmt.hasSignal(nr.rsrp)) {
			sigRows.push(E('hr'));
			sigRows.push(bar(_('5G RSRP'), nr.rsrp, 'dBm', -120, -70, -90, -105));
			sigRows.push(bar(_('5G SINR'), (nr.snr/10), 'dB', -5, 30, 13, 0));
		}
		if (!sigRows.length)
			sigRows.push(E('em', {}, _('no signal (modem not registered)')));

		cols.push(E('div', { 'class': 'cbi-section', 'style': 'flex:1;min-width:280px' }, [
			E('h3', {}, _('Signal — aim the antenna for the highest RSRP/SINR')),
			E('div', {}, sigRows)
		]));

		/* --- serving/registration panel --- */
		var lc = cells.lte_intra;
		var ef = lc ? bands.lteEarfcn(lc.earfcn) : null;
		var plmn = reg.plmn;
		var srvRows = [
			[ _('State'), modem.state || '?' ],
			[ _('Registration'), fmt.regShort(reg) ]
		];
		/* why registration is stuck: EMM reject cause / limited service */
		var rd = modem.registration_detail;
		if (rd && (rd.reject_text || rd.reject_cause != null || rd.limited)) {
			var msg = rd.reject_text ||
				(rd.reject_cause != null ? _('reject cause %d').format(rd.reject_cause) : _('limited service'));
			if (rd.limited && (rd.reject_text || rd.reject_cause != null))
				msg += ' · ' + _('limited service');
			srvRows.push([ _('Problem'), E('span', { 'style': 'color:#c00;font-weight:bold' }, msg) ]);
		}
		var opLine = fmt.fmtOperator(reg);
		if (opLine) srvRows.push([ _('Operator'), opLine ]);
		if (modem.iccid)  srvRows.push([ _('ICCID'), modem.iccid ]);
		if (modem.imsi)   srvRows.push([ _('IMSI'), modem.imsi ]);
		if (modem.msisdn) srvRows.push([ _('MSISDN'), modem.msisdn ]);
		if (cells.temperature && cells.temperature.celsius != null)
			srvRows.push([ _('Temperature'), '%d °C'.format(cells.temperature.celsius) ]);
		if (lc) {
			var dsd = cells.dsd, svl = (cells.serving||{}).lte;
			var tech = 'LTE' + ((fmt.hasSignal(nr.rsrp) || (cells.serving||{}).nr) ? ' + 5G NR' : '');
			if (dsd && dsd.mode && dsd.mode != 'LTE') tech += ' · ' + dsd.mode;
			srvRows.push([ _('Technology'), tech ]);
			srvRows.push([ _('Band'), (svl && svl.band != null) ? ('B'+svl.band) : (ef ? ef.band : '—') ]);
			srvRows.push([ _('Frequency'), (ef ? ef.mhz.toFixed(1)+' MHz' : '—') +
				((svl && svl.bandwidth_mhz) ? ' · ' + svl.bandwidth_mhz + ' MHz' : '') ]);
			srvRows.push([ _('EARFCN / PCI'), '%d / %d'.format(lc.earfcn, lc.serving_cell_id) ]);
			srvRows.push([ _('TAC / Cell ID'), '%d / %d'.format(lc.tac, lc.global_cell_id) ]);
		}
		var nc = cells.nr5g_cell, sn = (cells.serving||{}).nr;
		var narfcn = (sn && sn.arfcn) || cells.nr5g_arfcn;
		var nf = narfcn ? bands.nrArfcn(narfcn) : null;
		if (nc || sn) {
			var nband = (sn && sn.band != null) ? ('n'+sn.band) : (nf && nf.band ? nf.band : '?');
			var npci = (sn && sn.pci != null) ? sn.pci : (nc ? nc.pci : '?');
			var nbw = (sn && sn.bandwidth_mhz) ? ' · ' + sn.bandwidth_mhz + ' MHz' : '';
			srvRows.push([ _('5G cell'), '%s · %s MHz%s · PCI %s'.format(
				nband, nf ? nf.mhz.toFixed(1) : '?', nbw, npci) ]);
		}

		cols.push(E('div', { 'class': 'cbi-section', 'style': 'flex:1;min-width:280px' }, [
			E('h3', {}, _('Serving cell')), tbl(srvRows)
		]));

		/* --- SIM slots (multi-slot devices; hidden when unsupported) --- */
		var slots = (res[3] || {}).slots || [];
		if (slots.length) {
			var slotRows = slots.map(function(sl) {
				/* shared row renderer (wwand.format) */
				return fmt.simSlotRow(sl, function(physical) {
					return callSwitchSlot(name, physical);
				});
			});
			cols.push(E('div', { 'class': 'cbi-section', 'style': 'flex:1;min-width:280px' }, [
				E('h3', {}, _('SIM slots')), E('div', {}, slotRows)
			]));
		}

		var out = [];

		/* --- configuration warnings (if the daemon reports any) --- */
		var warns = renderWarnings(modem.config_warnings);
		if (warns) out.push(warns);

		out.push(E('div', { 'style': 'display:flex;gap:16px;flex-wrap:wrap' }, cols));

		/* --- active connections (per context) --- */
		var conns = renderConnections(ctxDetails);
		if (conns) out.push(conns);

		/* --- datapath & muxing (aggregation) --- */
		var dpanel = renderDatapath(dpath);
		if (dpanel) out.push(dpanel);

		/* --- carrier aggregation (active carriers) --- unified cell columns --- */
		if (cells.ca && cells.ca.length) {
			out.push(cellTable(_('Carrier aggregation'), cells.ca.map(function(c){
				var isNR = ('' + c.role).indexOf('NR') >= 0;
				var cf = isNR ? bands.nrArfcn(c.earfcn) : bands.lteEarfcn(c.earfcn);
				return cellRow({
					type: c.role,
					band: cf ? cf.band : null,
					earfcn: c.earfcn,
					freq: mhz(cf),
					bw: c.bandwidth_mhz ? c.bandwidth_mhz + ' MHz' : null,
					pci: c.pci,
					rsrp: dBm(c.rsrp),
					rsrq: dB(c.rsrq),
					lock: null
				});
			})));
		}

		/* --- intra-frequency neighbour cells --- same columns as CA --- */
		if (lc && lc.cells && lc.cells.length > 1) {
			var neigh = lc.cells.filter(function(c){ return c.pci != lc.serving_cell_id; });
			out.push(cellTable(_('LTE neighbour cells (intra-frequency)'), neigh.map(function(c){
				return cellRow({
					type: _('neighbour'),
					band: ef ? ef.band : null,
					earfcn: lc.earfcn,
					freq: mhz(ef),
					bw: null,
					pci: c.pci,
					rsrp: dBm(c.rsrp),
					rsrq: dB(c.rsrq),
					lock: '%d:%d'.format(lc.earfcn, c.pci)
				});
			})));
		}

		/* --- inter-frequency neighbour cells --- same columns as CA --- */
		var li = cells.lte_inter;
		var interRows = [];
		if (li && li.freqs)
			li.freqs.forEach(function(fr){
				var fef = bands.lteEarfcn(fr.earfcn);
				(fr.cells || []).forEach(function(c){
					interRows.push(cellRow({
						type: _('neighbour'),
						band: fef ? fef.band : null,
						earfcn: fr.earfcn,
						freq: mhz(fef),
						bw: null,
						pci: c.pci,
						rsrp: dBm(c.rsrp),
						rsrq: dB(c.rsrq),
						lock: '%d:%d'.format(fr.earfcn, c.pci)
					}));
				});
			});
		if (interRows.length)
			out.push(cellTable(_('LTE neighbour cells (inter-frequency)'), interRows));

		/* --- 5G NR neighbour cells (AT+QENG only — QMI reports no NR neighbours;
		   same columns as CA/LTE so all cell tables line up) --- */
		var nn = cells.nr5g_neigh;
		if (nn && nn.length) {
			out.push(cellTable(_('5G NR neighbour cells'), nn.map(function(c){
				var nf = (c.arfcn != null) ? bands.nrArfcn(c.arfcn) : null;
				return cellRow({
					type: _('neighbour'),
					band: nf ? nf.band : null,
					earfcn: c.arfcn,           /* NR-ARFCN in the shared column */
					freq: mhz(nf),
					bw: null,
					pci: c.pci,
					rsrp: dBm(c.rsrp),
					rsrq: dB(c.rsrq),
					lock: (c.arfcn != null ? c.arfcn + ':' : '') + c.pci
				});
			})));
		}

		return E('div', {}, out);
		});
	});
}

return view.extend({
	load: function() {
		return L.resolveDefault(callStatus(), {});
	},

	render: function(modems) {
		/* deep link from the Modems overview: ?modem=<name> preselects */
		var current = null;
		try { current = new URLSearchParams(window.location.search).get('modem'); } catch(e) {}
		var selWrap = E('span', {});   // filled with a modem selector when >1
		var live = E('div', { 'id': 'wwand-live' }, E('em', {}, _('loading…')));

		/* Rebuild the modem dropdown only when the set of modems actually
		   changes; otherwise the 1s poll would recreate the <select> under the
		   user every second, making it flicker and impossible to open. The last
		   signature is stashed on selWrap so no extra closure state is needed. */
		function buildSelector(ms) {
			var names = Object.keys(ms || {});
			if (names.length < 2) {
				if (selWrap._sig !== '') { dom.content(selWrap, ''); selWrap._sig = ''; }
				return;
			}
			var sig = names.map(function(n){
				return n + ':' + (ms[n].netdev || '') + ':' + (ms[n].model || '');
			}).join('|');
			if (sig === selWrap._sig) return;
			selWrap._sig = sig;
			var sel = E('select', { 'class': 'cbi-input-select',
				'change': function(ev){ current = ev.target.value; peak[current] = {}; refresh(); } },
				names.map(function(n){
					var m = ms[n];
					return E('option', { 'value': n,
						'selected': (n == current) ? 'selected' : null },
						'%s (%s)'.format(m.netdev || n, m.model || '?'));
				}));
			dom.content(selWrap, [ _('Modem') + ': ', sel ]);
		}

		function refresh() {
			return callStatus().then(function(ms) {
				ms = ms || {};
				var names = Object.keys(ms);
				var el = document.getElementById('wwand-live');
				if (!el) return;

				if (!names.length) {
					current = null;
					dom.content(selWrap, '');
					dom.content(el, E('em', {}, _('wwand is not running or no modem present yet.')));
					return;
				}

				if (!current || !ms[current]) current = names[0];
				buildSelector(ms);
				return renderLive(current, ms[current]).then(function(node){
					var e2 = document.getElementById('wwand-live');
					if (e2) dom.content(e2, node);
				});
			});
		}

		var resetBtn = E('button', { 'class': 'btn cbi-button', 'click': function(){
			if (current) peak[current] = {}; refresh();
		} }, _('Reset peak'));

		poll.add(refresh, 1);
		refresh();

		return E('div', { 'class': 'cbi-map' }, [
			E('h2', {}, _('Modem Status')),
			E('div', { 'class': 'cbi-map-descr' },
				_('Live cellular signal and cell environment — updates about once per second. Aim the antenna for the highest RSRP / SINR; the peak values below help while turning it.')),
			E('div', { 'class': 'cbi-section', 'style': 'display:flex;gap:12px;align-items:center' },
				[ selWrap, resetBtn ]),
			live
		]);
	},

	handleSaveApply: null,
	handleSave: null,
	handleReset: null
});
