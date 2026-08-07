'use strict';
'require view';
'require ui';
'require uci';
'require wwand.bands as bands';
'require wwand.rpc as wrpc';
'require wwand.format as fmt';
'require wwand.modemsid as modemsid';
'require wwand.esim as esim';
'require wwand.netsel as netsel';

// wwand modem settings editor. All values go through the daemon's now
// protocol-neutral ubus methods (QMI NAS, MBIM QMI-over-MBIM passthrough, or an
// AT fallback on NCM); band preferences travel as band-number lists (u64 masks
// would lose precision in JS numbers). The ubus declarations live in the
// shared wwand.rpc module; the SIM/eSIM and network-selection panels are the
// shared wwand.esim / wwand.netsel modules.

var callStatus = wrpc.status;
var callGet = wrpc.getSettings;
var callSet = wrpc.setSettings;
var callPlmn = wrpc.plmn;
var callSlots = wrpc.slots;
var callSmsList = wrpc.smsList;
var callSmsDelete = wrpc.smsDelete;
var callModemReset = wrpc.modemReset;
var callEsim = wrpc.esim;

var renderWarnings = fmt.renderWarnings;

// Some modems (e.g. MeiG SLM7xx) apply selection/band changes only after a
// modem reboot: the daemon flags such results `deferred`. Inform the user and
// offer the reset — auto interfaces come back up on their own afterwards.
function notifyDeferred(modem) {
	ui.addNotification(null, E('div', {}, [
		E('p', {}, _('Saved — but this modem applies the change only after a modem restart.')),
		E('button', {
			'class': 'btn cbi-button cbi-button-negative',
			'click': function(ev) {
				ev.target.disabled = true;
				callModemReset(modem).then(function(r) {
					if (r && r.ok === false)
						ui.addNotification(null, E('p', _('Modem reset failed: %s').format(r.error || '?')), 'error');
					else
						ui.addNotification(null, E('p',
							_('Modem is restarting — the connection resumes automatically once it re-registers.')), 'info');
				});
			},
		}, _('Restart modem now')),
	]), 'warning');
}

// after an eSIM profile switch the daemon applies via an automatic SIM
// hot-reset (`applied: 'sim_reset'` — connection re-establishes on its own);
// when no SIM-reset path exists it asks for a full modem restart
// (`apply: 'modem_reset'`). Surface both.
function notifyEsimApply(modem, res) {
	if (res && res.error) {
		ui.addNotification(null, E('p',
			_('Profile switch failed: %s').format(res.error)), 'error');
		return;
	}
	if (res && res.apply == 'modem_reset')
		return notifyDeferred(modem);
	ui.addNotification(null, E('p',
		_('Profile switched — the SIM was reset automatically, the connection re-establishes in a few seconds.')), 'info');
	window.setTimeout(function() { window.location.reload() }, 4000);
}

var MODE_BITS = [
	[ 0x04, 'GSM' ],
	[ 0x08, 'UMTS' ],
	[ 0x10, 'LTE' ],
	[ 0x40, 'NR5G' ],
];

// reset-to-defaults preset: everything the modem supports (it clamps unknown
// band bits itself), data-centric, roaming allowed
var DEFAULTS = {
	mode_preference: 0x50,
	usage_preference: 2,
	roaming_preference: 255,
	lte_bands: [], nr5g_sa_bands: [], nr5g_nsa_bands: [],
};

for (var b = 1; b <= 63; b++) DEFAULTS.lte_bands.push(b);
for (var n = 1; n <= 79; n++) { DEFAULTS.nr5g_sa_bands.push(n); DEFAULTS.nr5g_nsa_bands.push(n); }

function parseBandList(text) {
	var out = [];
	(text || '').split(/[,\s]+/).forEach(function(tok) {
		var n = parseInt(tok, 10);
		if (!isNaN(n) && n > 0 && n <= 512 && out.indexOf(n) < 0)
			out.push(n);
	});
	return out.sort(function(a, b) { return a - b });
}

// Band multi-select built from the shared wwand.bands tables. `known` is a list
// of { num, label }; `selected` is the band-number list currently set. Known
// bands become checkboxes; any selected band the table does not cover survives
// in a raw comma-separated fallback input (so exotic bands are never dropped).
// The returned node carries a _collect() that yields the merged band list.
function bandPicker(known, selected) {
	selected = selected || [];
	var boxes = [], knownNums = {};
	known.forEach(function(b) { knownNums[b.num] = true; });

	var labels = known.map(function(b) {
		var cb = E('input', { 'type': 'checkbox', 'data-band': b.num,
			'checked': (selected.indexOf(b.num) >= 0) ? '' : null });
		boxes.push(cb);
		return E('label', { 'style': 'display:inline-block;min-width:4.5em;margin:1px 10px 1px 0;font-weight:normal' },
			[ cb, ' ' + b.label ]);
	});

	/* Fallback for bands the checkbox table does not cover (exotic / future
	   bands are never silently dropped). Hidden when empty — with the tables
	   complete that is the normal case — behind a small "+ other band" link, so
	   an empty text box does not sit under the checkboxes and confuse. */
	var extra = selected.filter(function(n) { return !knownNums[n]; });
	var rawIn = E('input', { 'type': 'text', 'class': 'cbi-input-text',
		'style': 'width:100%;margin-top:5px' + (extra.length ? '' : ';display:none'),
		'placeholder': _('additional (non-listed) band numbers, comma/space separated'),
		'value': extra.join(',') });
	var moreLink = E('a', { 'href': '#',
		'style': 'font-size:90%;margin-top:4px;display:' + (extra.length ? 'none' : 'inline-block'),
		'click': function(ev) {
			ev.preventDefault();
			rawIn.style.display = '';
			rawIn.focus();
			this.style.display = 'none';
		} }, _('+ add a non-listed band'));

	var node = E('div', {}, [ E('div', {}, labels), rawIn, moreLink ]);
	node._collect = function() {
		var out = [];
		boxes.forEach(function(cb) { if (cb.checked) out.push(+cb.getAttribute('data-band')); });
		parseBandList(rawIn.value).forEach(function(n) { if (out.indexOf(n) < 0) out.push(n); });
		return out.sort(function(a, b) { return a - b });
	};
	return node;
}

function lteKnownBands() {
	return bands.LTE_BANDS.map(function(b) { return { num: b[0], label: 'B' + b[0] }; });
}
function nrKnownBands() {
	return bands.NR_BANDS.map(function(b) {
		return { num: parseInt(('' + b[0]).replace(/^n/, ''), 10), label: b[0] };
	});
}

function plmnTable(title, list, absentHint) {
	if (list == null)
		return E('p', {}, [ E('em', {}, title + ': ' + _('not present on this SIM') +
			(absentHint ? ' — ' + absentHint : '')) ]);

	var rows = list.map(function(e) {
		var rats = [ 'gsm', 'utran', 'eutran', 'ngran' ]
			.filter(function(k) { return e[k] })
			.map(function(k) { return k.toUpperCase() }).join(' ');
		return E('tr', { 'class': 'tr' }, [
			E('td', { 'class': 'td' }, e.mcc + '/' + e.mnc),
			E('td', { 'class': 'td' }, rats),
		]);
	});

	return E('div', {}, [
		E('h4', {}, title + ' (' + list.length + ')'),
		E('table', { 'class': 'table' }, [
			E('tr', { 'class': 'tr table-titles' }, [
				E('th', { 'class': 'th' }, 'PLMN'),
				E('th', { 'class': 'th' }, _('Access technologies')),
			]),
		].concat(rows)),
	]);
}

return view.extend({
	handleSaveApply: null,
	handleSave: null,
	handleReset: null,

	load: function() {
		return Promise.all([ callStatus(), uci.load('network') ]).then(function(r) {
			var names = Object.keys(r[0] || {});

			if (!names.length)
				return { modem: null };

			/* multi-modem: ?modem=<name> selects the modem, default first */
			var picked = null;
			try { picked = new URLSearchParams(window.location.search).get('modem'); } catch(e) {}
			var name = (picked && names.indexOf(picked) >= 0) ? picked : names[0];

			return Promise.all([
				callGet(name),
				callPlmn(name),
				L.resolveDefault(callSlots(name), {}),
				L.resolveDefault(callEsim(name, 'profiles', 0, '', '', ''), {}),
				L.resolveDefault(callEsim(name, 'backend', 0, '', '', ''), {}),
			]).then(function(res) {
				var esimData = res[3] || {};
				esimData.backend = (res[4] || {}).backend;
				return { modem: name, mods: r[0] || {}, info: (r[0] || {})[name] || {},
				         settings: res[0], plmn: res[1],
				         slots: (res[2] || {}).slots || [], esim: esimData };
			});
		});
	},

	// the interface section carrying wwand's per-interface config (SIM slot,
	// cell lock, …). Old-style configs put it on the first wwand interface
	// (proto 'wwand', or the historical 'qmi' alias).
	targetIface: function() {
		var target = null;
		uci.sections('network', 'interface', function(s) {
			if (!target && (s.proto == 'wwand' || s.proto == 'qmi'))
				target = s['.name'];
		});
		return target;
	},

	// network-native model: SIM slot + cell lock live on the interface's
	// wwand_modem section. modemSid() resolves it (null until it exists — reads
	// then fall back to the interface for legacy inline configs); ensureModemSid()
	// creates it + `option modem` on first write, converting to new-style.
	// The resolution/migration logic itself is the shared wwand.modemsid module.
	modemSid: function() {
		var iface = this.targetIface();
		if (!iface) return null;
		return modemsid.modemSid(iface);
	},

	ensureModemSid: function() {
		var iface = this.targetIface();
		if (!iface) return null;
		var sid = this.modemSid();
		if (sid) return sid;
		return modemsid.ensureModemSid(iface);
	},

	simSlotUci: function(slot) {
		var sid = this.ensureModemSid();
		if (!sid)
			return Promise.reject(new Error('no qmi interface'));
		uci.set('network', sid, 'sim_slot', String(slot));
		uci.unset('network', this.targetIface(), 'sim_slot');   // drop legacy inline
		return uci.save().then(function() { return uci.apply() });
	},

	apply: function(modem, settings) {
		return callSet(modem, settings).then(function(res) {
			if (res && res.ok && res.unchanged)
				ui.addNotification(null, E('p', _('No change — the modem already runs these settings.')), 'info');
			else if (res && res.ok && res.deferred)
				notifyDeferred(modem);
			else if (res && res.ok)
				ui.addNotification(null, E('p', _('Modem settings applied.')), 'info');
			else
				ui.addNotification(null, E('p', _('Failed: ') + ((res || {}).error || '?')), 'error');
		});
	},

	// --- Cell lock (protocol-neutral: written to uci on the WAN interface) ---
	// The wwand compat layer / proto handler interpret lock_4g (earfcn:pci list),
	// lock_5g (pci:arfcn:scs:band) and lock_persist regardless of qmi/mbim/ncm.
	renderCellLock: function(data) {
		var self = this;
		var out = [ E('h3', {}, _('Cell lock')) ];

		var sid = this.targetIface();
		if (!sid) {
			out.push(E('p', {}, E('em', {},
				_('No qmi interface found — the cell lock is stored on the modem.'))));
			return out;
		}

		// cell lock lives on the wwand_modem section (radio setting); read it
		// there, falling back to the interface for a legacy inline config.
		var readSid = this.modemSid() || sid;
		var lock4g = uci.get('network', readSid, 'lock_4g') || [];
		if (!Array.isArray(lock4g))
			lock4g = (lock4g != null && lock4g !== '') ? [ lock4g ] : [];
		var lock5g = uci.get('network', readSid, 'lock_5g') || '';
		var persist = uci.get('network', readSid, 'lock_persist') == '1';

		var l4In = E('input', { 'type': 'text', 'class': 'cbi-input-text', 'style': 'width:100%',
			'placeholder': '1300:246 5230:118', 'value': lock4g.join(' ') });
		var l5In = E('input', { 'type': 'text', 'class': 'cbi-input-text', 'style': 'width:100%',
			'placeholder': '242:431070:1:78', 'value': lock5g });
		var persistChk = E('input', { 'type': 'checkbox', 'checked': persist ? '' : null });

		var save = function() {
			// write to the wwand_modem section (new-style), clearing any legacy
			// inline copy on the interface.
			var wsid = self.ensureModemSid();
			var l4 = (l4In.value || '').split(/[\s,]+/).filter(function(x) { return x; });
			if (l4.length) uci.set('network', wsid, 'lock_4g', l4);
			else uci.unset('network', wsid, 'lock_4g');
			uci.unset('network', sid, 'lock_4g');

			var v5 = (l5In.value || '').trim();
			if (v5) uci.set('network', wsid, 'lock_5g', v5);
			else uci.unset('network', wsid, 'lock_5g');
			uci.unset('network', sid, 'lock_5g');

			if (persistChk.checked) uci.set('network', wsid, 'lock_persist', '1');
			else uci.unset('network', wsid, 'lock_persist');
			uci.unset('network', sid, 'lock_persist');

			return uci.save().then(function() { return uci.apply(); }).then(function() {
				ui.addNotification(null, E('p',
					_('Cell lock saved. Reconnect the interface to apply.')), 'info');
			});
		};

		var row = function(label, node, hint) {
			return E('div', { 'class': 'cbi-value' }, [
				E('label', { 'class': 'cbi-value-title' }, label),
				E('div', { 'class': 'cbi-value-field' },
					hint ? [ node, E('div', { 'class': 'cbi-value-description' }, hint) ] : [ node ]),
			]);
		};

		out.push(E('div', { 'class': 'cbi-section' }, [
			row(_('LTE cell lock'), l4In,
				_('Space/comma separated "earfcn:pci" entries (several = a cell list). See Status → Modem for the live cells and their lock values.')),
			row(_('5G NR SA cell lock'), l5In,
				_('A single 5G SA cell as "pci:arfcn:scs:band".')),
			row(_('Persist in modem'),
				E('label', { 'style': 'font-weight:normal' }, [ persistChk, ' ' + _('Store the lock in modem non-volatile memory') ]),
				null),
			E('div', { 'class': 'cbi-page-actions', 'style': 'margin-top:6px' }, [
				E('button', { 'class': 'btn cbi-button cbi-button-apply',
					'click': ui.createHandlerFn(self, save) }, _('Save cell lock')),
				' ',
				E('button', { 'class': 'btn cbi-button cbi-button-reset',
					'click': ui.createHandlerFn(self, function() {
						l4In.value = ''; l5In.value = ''; persistChk.checked = false;
						return save();
					}) }, _('Clear lock')),
			]),
		]));
		return out;
	},

	// SMS inbox: load stored messages on demand (Refresh) from the selected
	// storage; per-row Delete. Concatenated messages are merged and carry every
	// part's storage index so Delete removes all parts.
	renderSms: function(data) {
		var self = this, modem = data.modem;

		var storageSel = E('select', { 'style': 'width:12em' }, [
			E('option', { value: 'SM' }, _('SIM card')),
			E('option', { value: 'ME' }, _('Modem memory')),
		]);

		var body = E('div', { 'style': 'margin-top:6px' },
			E('em', {}, _('Choose a storage and click Load.')));

		function set(node) {
			body.innerHTML = '';
			body.appendChild(node);
		}

		function rows(msgs) {
			if (!msgs || !msgs.length)
				return E('em', {}, _('No messages stored.'));

			var trs = msgs.map(function(m) {
				var idxs = (m.indexes && m.indexes.length) ? m.indexes
					: (m.index != null ? [ m.index ] : []);
				return E('tr', { 'class': 'tr' }, [
					E('td', { 'class': 'td' }, m.sender || '—'),
					E('td', { 'class': 'td', 'style': 'white-space:nowrap' }, m.timestamp || ''),
					E('td', { 'class': 'td', 'style': 'white-space:pre-wrap' },
						(m.text || '') + (m.incomplete ? ' ' + _('(incomplete)') : '')),
					E('td', { 'class': 'td', 'style': 'width:1%' }, E('button', {
						'class': 'btn cbi-button cbi-button-remove',
						click: ui.createHandlerFn(self, function() {
							if (!confirm(_('Delete this message?')))
								return;
							return Promise.all(idxs.map(function(i) {
								return callSmsDelete(modem, storageSel.value, i);
							})).then(load);
						}) }, _('Delete'))),
				]);
			});

			return E('table', { 'class': 'table' }, [
				E('tr', { 'class': 'tr table-titles' }, [
					E('th', { 'class': 'th' }, _('Sender')),
					E('th', { 'class': 'th' }, _('Received')),
					E('th', { 'class': 'th' }, _('Message')),
					E('th', { 'class': 'th', 'style': 'width:1%' }, ''),
				]),
			].concat(trs));
		}

		function load() {
			set(E('em', {}, _('Loading…')));
			return callSmsList(modem, storageSel.value).then(function(res) {
				if (!res || res.ok === false) {
					var e = res && res.error;
					set(E('em', {}, e == 'unsupported_on_backend'
						? _('This modem does not expose SMS access.')
						: _('Could not read messages: %s').format(e || '?')));
					return;
				}
				set(rows(res.messages));
			});
		}

		return [
			E('h3', {}, _('SMS')),
			E('div', { 'class': 'cbi-section' }, [
				E('div', { 'class': 'cbi-value' }, [
					E('label', { 'class': 'cbi-value-title' }, _('Storage')),
					E('div', { 'class': 'cbi-value-field' }, [ storageSel, ' ',
						E('button', { 'class': 'btn cbi-button cbi-button-action',
							click: ui.createHandlerFn(self, load) }, _('Load')) ]),
				]),
				body,
			]),
		];
	},

	render: function(data) {
		if (!data || !data.modem)
			return E('p', {}, _('No modem present.'));

		var self = this;
		var s = data.settings || {};
		var modeBoxes = MODE_BITS.map(function(m) {
			return E('label', { 'style': 'margin-right:1em' }, [
				E('input', { type: 'checkbox', 'data-bit': m[0],
					checked: (s.mode_preference & m[0]) ? '' : null }),
				' ' + m[1],
			]);
		});

		var usageSel = E('select', {}, [
			E('option', { value: 1, selected: s.usage_preference == 1 ? '' : null }, _('voice centric')),
			E('option', { value: 2, selected: s.usage_preference == 2 ? '' : null }, _('data centric')),
		]);

		var roamSel = E('select', {}, [
			E('option', { value: 1,   selected: s.roaming_preference == 1 ? '' : null }, _('off')),
			E('option', { value: 255, selected: s.roaming_preference == 255 ? '' : null }, _('any')),
		]);

		var ltePicker = bandPicker(lteKnownBands(), s.lte_bands || []);
		var saPicker  = bandPicker(nrKnownBands(), s.nr5g_sa_bands || []);
		var nsaPicker = bandPicker(nrKnownBands(), s.nr5g_nsa_bands || []);

		var collect = function() {
			var mode = 0;
			modeBoxes.forEach(function(l) {
				var cb = l.firstElementChild;
				if (cb.checked)
					mode |= +cb.getAttribute('data-bit');
			});
			return {
				mode_preference: mode,
				usage_preference: +usageSel.value,
				roaming_preference: +roamSel.value,
				lte_bands: ltePicker._collect(),
				nr5g_sa_bands: saPicker._collect(),
				nr5g_nsa_bands: nsaPicker._collect(),
			};
		};

		var row = function(label, node) {
			return E('div', { 'class': 'cbi-value' }, [
				E('label', { 'class': 'cbi-value-title' }, label),
				E('div', { 'class': 'cbi-value-field' }, [ node ]),
			]);
		};

		// protocol label (shown if the daemon reports it; graceful if absent)
		var proto = data.info && (data.info.protocol || data.info.proto);
		var head = _('Modem Tools') + ' — ' + data.modem +
			(proto ? ' (' + String(proto).toUpperCase() + ')' : '');

		var warns = renderWarnings(data.info && data.info.config_warnings);

		/* multi-modem: one tab per live modem; a tab reloads the page with
		   ?modem=<name> so every tool section below targets that modem */
		var modNames = Object.keys(data.mods || {});
		var modemSel = (modNames.length < 2) ? '' :
			E('ul', { 'class': 'cbi-tabmenu', 'style': 'margin:0 0 12px' },
				modNames.map(function(n) {
					var m = data.mods[n] || {};
					return E('li', { 'class': (n == data.modem) ? 'cbi-tab' : 'cbi-tab-disabled' },
						E('a', { 'href': window.location.pathname + '?modem=' + encodeURIComponent(n) },
							'%s (%s)'.format(m.netdev || n, m.model || n)));
				}));

		/* callbacks the shared SIM/eSIM + network-selection panels need from
		   this page (uci persistence + the apply notifications) */
		var panelCtx = {
			simSlotUci: function(slot) { return self.simSlotUci(slot); },
			notifyEsimApply: notifyEsimApply,
			notifyDeferred: notifyDeferred,
		};

		return E('div', {}, [
			E('h2', {}, head),
			modemSel,
			warns || '',
			E('div', { 'class': 'cbi-section' }, [
				row(_('Radio technologies'), E('div', {}, modeBoxes)),
				row(_('UE usage'), usageSel),
				row(_('Roaming'), roamSel),
				row(_('LTE bands'), ltePicker),
				row(_('NR5G SA bands'), saPicker),
				row(_('NR5G NSA bands'), nsaPicker),
				E('p', { 'style': 'margin:6px 0 0;color:var(--fg-color-2,#666)' }, E('em', {},
					_('Leave every band unchecked (and the fallback empty) to let the modem use all supported bands.'))),
			]),
			E('div', { 'class': 'cbi-page-actions' }, [
				E('button', { 'class': 'btn cbi-button cbi-button-apply',
					click: ui.createHandlerFn(self, function() {
						return self.apply(data.modem, collect());
					}) }, _('Apply')),
				' ',
				E('button', { 'class': 'btn cbi-button cbi-button-reset',
					click: ui.createHandlerFn(self, function() {
						if (!confirm(_('Reset radio/band/usage/roaming settings to defaults?')))
							return;
						return self.apply(data.modem, DEFAULTS).then(function() {
							window.location.reload();
						});
					}) }, _('Reset to defaults')),
			]),
			netsel.render(panelCtx, data),
		].concat(this.renderCellLock(data)).concat(esim.render(panelCtx, data)).concat([
			E('h3', {}, _('SIM PLMN preference lists')),
			plmnTable(_('User-controlled (EF PLMNwAcT, 6F60)'), (data.plmn || {}).user,
				_('optional SIM file — not provisioned on this SIM, and the device cannot create it')),
			plmnTable(_('Operator-controlled (6F61)'), (data.plmn || {}).operator),
			plmnTable(_('Home PLMN (6F62)'), (data.plmn || {}).home),
		]).concat(this.renderSms(data)));
	},
});
