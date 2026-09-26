'use strict';
'require view';
'require rpc';
'require poll';

/* Status -> SIM cards: every SIM card wwand has seen (ubus sim_inventory,
   the daemon's siminventory.uc), by ICCID, and where it is — which modem and
   slot, which eUICC and profile, or which reader (a remote SIM through
   wwand-rsim). Cards that were seen and are gone stay listed as not present,
   with when they were last seen: that is what a later ICCID binding needs to
   know, and what an operator asks after moving cards around. */

var callInventory = rpc.declare({ object: 'wwand', method: 'sim_inventory', expect: { cards: [] } });

function where(c) {
	if (c.reader)
		return _('reader %s').format(c.reader);
	if (c.modem)
		return (c.slot != null) ? _('%s, slot %d').format(c.modem, c.slot) : c.modem;
	return '?';
}

function state(c) {
	if (!c.present)
		return E('span', { 'style': 'opacity:.6' }, _('not present'));
	if (c.active)
		return E('strong', {}, _('in use'));
	return _('present');
}

function esim(c) {
	if (!c.eid)
		return '';
	/* array children throughout: the names come from the card */
	return E('span', {}, [
		_('eUICC'), ' ', E('code', {}, [ c.eid ]),
		c.profile ? ' · ' + _('profile %s').format(c.profile.state || '?') + (c.profile.name ? ' "' + c.profile.name + '"' : '') : '',
	]);
}

return view.extend({
	load: function() {
		return L.resolveDefault(callInventory(), []);
	},

	table: function(cards) {
		if (!cards.length)
			return E('p', {}, E('em', {}, _('No SIM card seen yet.')));

		return E('table', { 'class': 'table' }, [
			E('tr', { 'class': 'tr table-titles' }, [
				E('th', { 'class': 'th' }, _('ICCID')),
				E('th', { 'class': 'th' }, _('Where')),
				E('th', { 'class': 'th' }, _('State')),
				E('th', { 'class': 'th' }, _('IMSI')),
				E('th', { 'class': 'th' }, _('eSIM')),
			]),
		].concat(cards.map(function(c) {
			return E('tr', { 'class': 'tr' }, [
				E('td', { 'class': 'td' }, E('code', {}, [ c.iccid ])),
				E('td', { 'class': 'td' }, [ where(c) ]),
				E('td', { 'class': 'td' }, state(c)),
				E('td', { 'class': 'td' }, [ c.imsi || '—' ]),
				E('td', { 'class': 'td' }, esim(c)),
			]);
		})));
	},

	render: function(cards) {
		var self = this;
		var box = E('div', {}, self.table(cards || []));

		poll.add(function() {
			return L.resolveDefault(callInventory(), []).then(function(c) {
				box.replaceChildren(self.table(c || []));
			});
		}, 10);

		return E([], [
			E('h2', {}, _('SIM cards')),
			E('div', { 'class': 'cbi-map-descr' },
				_('Every SIM card wwand has seen and where it is: in a modem slot, as a profile on an eUICC, or in a reader (remote SIM). A card that was taken out stays listed as not present. On a modem with more than one slot, the cards in the inactive slots appear once the slot list has been read.')),
			box,
		]);
	},

	handleSave: null,
	handleSaveApply: null,
	handleReset: null
});
