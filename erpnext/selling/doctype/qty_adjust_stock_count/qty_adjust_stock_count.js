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
					me.refresh_qty_warining_color();
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
		var me = this;

		this.frm.doc.total_actual_qty = 0;
		this.frm.doc.total_po_qty = 0;
		this.frm.doc.total_available_qty = 0;
		this.frm.doc.total_so_qty = 0;
		this.frm.doc.total_short_excess = 0;
		this.frm.doc.total_physical_stock = 0;
		this.frm.doc.total_ppk = 0;
		this.frm.doc.total_net_short_excess = 0;

		$.each(this.frm.doc.items || [], function (i, d) {
			d.net_short_excess = flt(d.physical_stock) + flt(d.total_selected_po_qty) - flt(d.total_selected_so_qty) - flt(d.ppk);

			me.frm.doc.total_actual_qty += flt(d.actual_qty);
			me.frm.doc.total_po_qty += flt(d.total_selected_po_qty);
			me.frm.doc.total_available_qty += flt(d.total_available_qty);
			me.frm.doc.total_so_qty += flt(d.total_selected_so_qty);
			me.frm.doc.total_short_excess += flt(d.short_excess);
			me.frm.doc.total_physical_stock += flt(d.physical_stock);
			me.frm.doc.total_ppk += flt(d.ppk);
			me.frm.doc.total_net_short_excess += flt(d.net_short_excess);

			me.set_qty_warning_color(d);
		});

		this.frm.refresh_fields();
	},

	refresh_qty_warining_color: function () {
		var me = this;
		$.each(this.frm.doc.items || [], function (i, d) {
			me.set_qty_warning_color(d);
		});
	},

	set_qty_warning_color: function(item) {
		var warn = flt(item.net_short_excess) < 0;
		var grid_row = this.frm.get_field("items").grid.get_grid_row(item.name);
		if (grid_row) {
			$("[data-fieldname='net_short_excess']", grid_row.wrapper)
				.css("color", warn ? "red" : "inherit");
		}
	},
});

$.extend(cur_frm.cscript, new erpnext.selling.QtyAdjustStockCountController({frm: cur_frm}));
