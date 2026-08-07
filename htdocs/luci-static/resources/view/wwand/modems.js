'use strict';
'require view';
'require form';
'require uci';
'require ui';
'require dom';
'require wwand.modemopts as modemopts';
'require wwand.simlist as simlist';
'require wwand.rpc as wrpc';
'require wwand.format as fmt';

/* Network → Modems: interfaces-style overview. One row per configured
   wwand_modem with live status columns (state, SIM, registration, signal) and
   per-row actions: Config (the modal uci editor, shared wwand.modemopts) and
   Tools (jumps to the Modem Tools page for that modem). Detected-but-
   unconfigured control devices (ubus modem_probe `present` without
   `managed_by`) are listed below with a one-click Configure. The per-ICCID/IMSI
   wwand_sim override list (shared wwand.simlist) closes the page. */

/* ubus declarations live in the shared wwand.rpc module */
var callStatus = wrpc.status;
var callProbe = wrpc.probe;
var callSignal = wrpc.signal;

/* compact registration/SIM mappings live in the shared wwand.format module */
var fmtReg = fmt.fmtRegistration;
var fmtSim = fmt.fmtSim;

function fmtSignal(sig) {
	var parts = [];

	if (sig && sig.lte && sig.lte.rsrp != null && sig.lte.rsrp > -32768)
		parts.push('LTE %d dBm'.format(sig.lte.rsrp));

	if (sig && sig.nr5g && sig.nr5g.rsrp != null && sig.nr5g.rsrp > -32768)
		parts.push('NR %d dBm'.format(sig.nr5g.rsrp));

	return parts.length ? parts.join(' / ') : '-';
}

function fmtState(mi) {
	if (!mi)
		return _('not running');

	return mi.state + (mi.control_note ? ' (' + mi.control_note + ')' : '');
}

return view.extend({
	load: function() {
		return Promise.all([
			uci.load('network'),
			L.resolveDefault(callStatus(), {}),
			L.resolveDefault(callProbe(), {}),
		]).then(function(r) {
			var status = r[1] || {};
			var names = Object.keys(status);

			return Promise.all(names.map(function(n) {
				return L.resolveDefault(callSignal(n), {});
			})).then(function(sigs) {
				var signals = {};
				names.forEach(function(n, i) { signals[n] = sigs[i] || {}; });
				return { status: status, probe: r[2] || {}, signals: signals };
			});
		});
	},

	render: function(data) {
		var status = data.status || {};
		var signals = data.signals || {};

		var m = new form.Map('network', _('Mobile Modems'),
			_('Cellular modems managed by wwand. Each modem is referenced from an interface (Network → Interfaces, protocol "Cellular / 5G") by its name; several interfaces can share one modem through different mux channels. "Config" edits the modem, "Tools" opens band/operator/SIM/eSIM/SMS tools for it.'));

		var s = m.section(form.GridSection, 'wwand_modem', _('Modems'),
			_('Add a modem here, then point an interface at it with the "Modem" field on the interface page.'));
		s.addremove = true;
		s.anonymous = false;
		s.addbtntitle = _('Add modem');
		s.nodescriptions = false;
		s.modaltitle = function(section_id) { return _('Modem') + ' ' + section_id; };

		s.tab('modem', _('Modem & SIM'), _('Which modem, and its SIM.'));
		s.tab('radio', _('Radio & Cell'), _('Radio technology, manual operator selection and cell lock.'));
		s.tab('resilience', _('Resilience'), _('Recovery, watchdogs and telemetry cadence.'));

		/* on this page the edited section IS the wwand_modem — direct storage */
		var direct = function(o) { return o; };

		s.taboption('modem', form.Value, 'device', _('Modem device'),
			_('Network device name (e.g. wwan0), a mux parent, or a control node (/dev/cdc-wdm0). Leave empty and set only the USB path to bind purely by topology.'));

		modemopts.addModemSim(s, 'modem', direct);
		modemopts.addRadio(s, 'radio', direct);
		modemopts.addCellLock(s, 'radio', direct);
		modemopts.addResilience(s, 'resilience', direct);

		/* the whole config form lives in the Config modal — keep the table to
		   the live status columns added below */
		s.children.forEach(function(o) { o.modalonly = true; });

		var col = function(name, title, fn) {
			var o = s.option(form.DummyValue, name, title);
			o.modalonly = false;
			o.write = function() {};
			o.remove = function() {};
			o.cfgvalue = function(section_id) { return fn(section_id); };
			return o;
		};

		col('_dev', _('Device'), function(sid) {
			var mi = status[sid];
			var dev = (mi && mi.netdev) || uci.get('network', sid, 'device') || '?';
			return dev + ((mi && mi.model) ? ' (' + mi.model + ')' : '');
		});
		col('_state', _('State'), function(sid) { return fmtState(status[sid]); });
		col('_sim', _('SIM'), function(sid) { return fmtSim(status[sid]); });
		col('_reg', _('Registration'), function(sid) { return fmtReg(status[sid]); });
		col('_sig', _('Signal'), function(sid) { return fmtSignal(signals[sid]); });

		/* row actions: Config (the native modal editor) + Status/Tools jumps */
		s.renderRowActions = function(section_id) {
			var td = form.GridSection.prototype.renderRowActions.call(this, section_id, _('Config'));
			var box = td.firstElementChild || td;

			var jump = function(label, title, url) {
				return E('button', {
					'class': 'btn cbi-button cbi-button-neutral',
					'title': title,
					'click': function(ev) {
						ev.preventDefault();
						window.location = url + '?modem=' + encodeURIComponent(section_id);
					},
				}, label);
			};

			var extra = [
				jump(_('Status'), _('Live status page (signal, cells, connection) for this modem'),
					L.url('admin/status/wwand')),
				jump(_('Tools'), _('Band, operator, SIM, eSIM and SMS tools for this modem'),
					L.url('admin/network/wwand-tools')),
			];

			/* between Config and the trailing Delete button when present */
			extra.forEach(function(b) {
				if (box.lastElementChild)
					box.insertBefore(b, box.lastElementChild);
				else
					box.appendChild(b);
			});

			return td;
		};

		/* per-ICCID/IMSI SIM overrides (PIN/APN), shared wwand.simlist */
		simlist.addSimList(m, {});

		/* detected control devices without a wwand_modem section — offer a
		   one-click Configure that stages a prefilled section (saved with the
		   page's Save & Apply; wwand adopts the modem on config reload) */
		var present = (data.probe && data.probe.present) || [];
		var loose = present.filter(function(p) { return !p.managed_by; });

		var detected = '';

		if (loose.length) {
			var nextName = function() {
				var i = 0;
				while (uci.get('network', 'wwmodem' + i))
					i++;
				return 'wwmodem' + i;
			};

			detected = E('div', { 'class': 'cbi-section' }, [
				E('h3', {}, _('Detected modems (unconfigured)')),
				E('p', {}, _('Control devices present on the system without a modem configuration. Configure stages a prefilled modem section — press Save & Apply afterwards, then attach an interface to it (or let autosetup handle it on an unconfigured system).')),
				E('table', { 'class': 'table' },
					[ E('tr', { 'class': 'tr table-titles' }, [
						E('th', { 'class': 'th' }, _('Type')),
						E('th', { 'class': 'th' }, _('Device')),
						E('th', { 'class': 'th' }, _('Path')),
						E('th', { 'class': 'th' }, _('Serial')),
						E('th', { 'class': 'th' }, ''),
					]) ].concat(loose.map(function(p) {
						var dev = p.device || p.netdev || '?';
						var path = p.path || p.usb_path;
						return E('tr', { 'class': 'tr' }, [
							E('td', { 'class': 'td' }, (p.protocol || p.kind || '?').toUpperCase()),
							E('td', { 'class': 'td' }, dev),
							E('td', { 'class': 'td' }, path || '-'),
							E('td', { 'class': 'td' }, p.serial || '-'),
							E('td', { 'class': 'td' },
								E('button', { 'class': 'btn cbi-button cbi-button-apply',
									'click': function(ev) {
										var name = nextName();
										uci.add('network', 'wwand_modem', name);
										/* bind by stable sysfs path (survives
										   USB enumeration order); device name
										   only as last resort */
										if (path)
											uci.set('network', name, 'path', path);
										else
											uci.set('network', name, 'device', dev);
										ev.target.disabled = true;
										ev.target.textContent = _('added — Save & Apply');
										return m.save(null, true);
									} }, _('Configure'))),
						]);
					}))),
			]);
		}

		return m.render().then(function(mapNode) {
			return E('div', {}, [ mapNode, detected ]);
		});
	},
});
