// Copyright (c) 2016, Frappe Technologies Pvt. Ltd. and contributors
// For license information, please see license.txt
/* eslint-disable */

frappe.query_reports["Qty Adjust"] = {
	"filters": [
		{
			fieldname: "date",
			label: __("From Date"),
			fieldtype: "Date",
			default: frappe.datetime.get_today(),
			reqd: 1
		},
		{
			fieldname: "selected_to_date",
			label: __("To Date"),
			fieldtype: "Date",
			default: frappe.datetime.add_days(frappe.datetime.get_today(), 1)
		},
		{
			fieldname: "item_code",
			label: __("Item"),
			fieldtype: "Link",
			options:"Item",
		},
		{
			fieldname: "item_group",
			label: __("Item Group"),
			fieldtype: "Link",
			options:"Item Group",
			default: frappe.defaults.get_user_default("Item Group") || ''
		},
		{
			fieldname: "brand",
			label: __("Brand"),
			fieldtype: "Link",
			options:"Brand",
		},
	],
	onChange: function(new_value, column, data, rowIndex) {
		if (["ppk", "physical_stock"].includes(column.fieldname)) {
			var row = frappe.query_report.datatable.datamanager.data[rowIndex];
			row[column.fieldname] = flt(new_value);
			row.net_short_excess = flt(row.physical_stock) + flt(row.total_selected_po_qty) - flt(row.total_selected_so_qty) - flt(row.ppk);

			frappe.query_report.datatable.datamanager.rowCount = 0;
			frappe.query_report.datatable.datamanager.columns = [];
			frappe.query_report.datatable.datamanager.rows = [];

			frappe.query_report.datatable.datamanager.prepareColumns();
			frappe.query_report.datatable.datamanager.prepareRows();
			frappe.query_report.datatable.datamanager.prepareTreeRows();
			frappe.query_report.datatable.datamanager.prepareRowView();
			frappe.query_report.datatable.datamanager.prepareNumericColumns();

			frappe.query_report.datatable.bodyRenderer.render();
		}
	},
	formatter: function(value, row, column, data, default_formatter) {
		var options = {
			css: {},
			link_target: "_blank"
		};

		if (data) {
			if (['draft_so_qty', 'total_po_qty', 'actual_qty', 'total_selected_po_qty', 'total_selected_so_qty',
					'total_available_qty', 'short_excess'].includes(column.fieldname)) {
				options.css['font-weight'] = "bold";
			}

			if (column.is_so_qty) {
				options.css['color'] = "#0a0157";
				options.link_href = encodeURI("desk#Form/Qty Adjust/Qty Adjust" +
					"?item_code=" + data.item_code + "&from_date=" + column.from_date + "&to_date=" + column.to_date);
			}

			if (column.is_po_qty) {
				options.link_href = encodeURI("desk#query-report/Purchase Order Items To Be Received" +
					"?item_code=" + data.item_code + "&from_date=" + column.from_date + "&to_date=" + column.to_date);
			}

			if (column.fieldname == 'short_excess' && flt(value) < 0) {
				options.css['color'] = 'red';
			}
		}

		return default_formatter(value, row, column, data, options);
	},

	onload: function(report) {
		report.page.add_inner_button(__("Qty Adjust Stock Count"), function() {
			frappe.set_route('List', 'Qty Adjust Stock Count');
		});
	}
};
