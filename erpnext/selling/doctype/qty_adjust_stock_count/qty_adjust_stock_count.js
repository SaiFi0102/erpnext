// Copyright (c) 2019, Frappe Technologies Pvt. Ltd. and contributors
// For license information, please see license.txt

frappe.provide("erpnext.selling");

erpnext.selling.QtyAdjustStockCountController = frappe.ui.form.Controller.extend({
	setup: function() {
		this.remove_sidebar();
		this.frm.doc.from_date = get_url_arg("from_date");
		this.frm.doc.to_date = get_url_arg("to_date");

		if (!this.frm.doc.from_date) {
			this.frm.doc.from_date = frappe.datetime.get_today();
		}
		if (!this.frm.doc.to_date) {
			this.frm.doc.to_date = frappe.datetime.add_days(frappe.datetime.get_today(), 1);
		}
	},

	refresh: function() {
		this.frm.add_custom_button(__('Qty Adjust Report'), function() {
			frappe.set_route('query-report', 'Qty Adjust');
		});
	},

	get_items: function () {
		var me = this;
		return me.frm.call({
			method: "get_items",
			doc: me.frm.doc,
			freeze: true,
			callback: function(r) {
				if(!r.exc) {
					me.frm.dirty();
				}
			}
		});
	},

	ppk: function () {
		this.calculate_totals();
	},

	physical_stock: function () {
		this.calculate_totals();
	},

	calculate_totals: function () {
		$.each(this.frm.doc.items || [], function (i, d) {
			d.net_short_excess = flt(d.physical_stock) + flt(d.ppk) + flt(d.total_selected_po_qty) - flt(d.total_selected_so_qty);
		});

		this.frm.doc.total_actual_qty = frappe.utils.sum((this.frm.doc.items || []).map(d => d.actual_qty));
		this.frm.doc.total_po_qty = frappe.utils.sum((this.frm.doc.items || []).map(d => d.total_selected_po_qty));
		this.frm.doc.total_available_qty = frappe.utils.sum((this.frm.doc.items || []).map(d => d.total_available_qty));
		this.frm.doc.total_so_qty = frappe.utils.sum((this.frm.doc.items || []).map(d => d.total_selected_so_qty));
		this.frm.doc.total_short_excess = frappe.utils.sum((this.frm.doc.items || []).map(d => d.short_excess));
		this.frm.doc.total_physical_stock = frappe.utils.sum((this.frm.doc.items || []).map(d => d.physical_stock));
		this.frm.doc.total_ppk = frappe.utils.sum((this.frm.doc.items || []).map(d => d.ppk));
		this.frm.doc.total_net_short_excess = frappe.utils.sum((this.frm.doc.items || []).map(d => d.net_short_excess));

		this.frm.refresh_fields();
	},
});

$.extend(cur_frm.cscript, new erpnext.selling.QtyAdjustStockCountController({frm: cur_frm}));
