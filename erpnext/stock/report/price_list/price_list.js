// Copyright (c) 2016, Frappe Technologies Pvt. Ltd. and contributors
// For license information, please see license.txt
/* eslint-disable */

frappe.query_reports["Price List"] = {
	filters: [
		{
			fieldname: "date",
			label: __("Price Effective Date"),
			fieldtype: "Date",
			default: frappe.datetime.nowdate(),
			reqd: 1,
			auto_email_report_ignore: 1
		},
		{
			fieldname: "valid_days",
			label: __("Valid For Days"),
			fieldtype: "Int",
			default: 4,
			auto_email_report_read_only: 1,
			on_change: function () {
				return false;
			}
		},
		{
			fieldname: "previous_price_date",
			label: __("Price Ref Date for Increase/Decrease"),
			fieldtype: "Date",
			auto_email_report_ignore: 1
		},
		{
			fieldname: "po_from_date",
			label: __("PO From Date"),
			default: frappe.datetime.nowdate(),
			fieldtype: "Date",
			hidden: !cint(frappe.defaults.get_default("restrict_amounts_in_report_to_role") && frappe.user.has_role(frappe.defaults.get_default("restrict_amounts_in_report_to_role"))),
			auto_email_report_ignore: 1
		},
		{
			fieldname: "po_to_date",
			label: __("PO To Date"),
			fieldtype: "Date",
			hidden: !cint(frappe.defaults.get_default("restrict_amounts_in_report_to_role") && frappe.user.has_role(frappe.defaults.get_default("restrict_amounts_in_report_to_role"))),
			auto_email_report_ignore: 1
		},
		{
			fieldname: "item_code",
			label: __("Item"),
			fieldtype: "Link",
			options:"Item",
			auto_email_report_ignore: 1
		},
		{
			fieldname: "item_group",
			label: __("Item Group"),
			fieldtype: "Link",
			options:"Item Group",
			default:frappe.defaults.get_default("item_group")
		},
		{
			fieldname: "brand",
			label: __("Brand"),
			fieldtype: "Link",
			options:"Brand",
			auto_email_report_ignore: 1,
			hidden: !cint(frappe.defaults.get_default("restrict_amounts_in_report_to_role") && frappe.user.has_role(frappe.defaults.get_default("restrict_amounts_in_report_to_role")))
		},
		{
			fieldname: "customer",
			label: __("For Customer"),
			fieldtype: "Link",
			options:"Customer",
			auto_email_report_reqd: 1,
			on_change: function () {
				if (!(cur_dialog && cur_dialog.in_auto_repeat) && !frappe.query_report) {
					return false;
				}

				var customer;
				if (cur_dialog && cur_dialog.in_auto_repeat) {
					customer = cur_dialog.get_value('customer');
				} else {
					customer = frappe.query_report.get_filter_value('customer');
				}

				if(customer) {
					frappe.db.get_value("Customer", customer, "default_price_list", function(value) {
						if (cur_dialog && cur_dialog.in_auto_repeat) {
							cur_dialog.set_value('selected_price_list', value["default_price_list"]);
						} else {
							frappe.query_report.set_filter_value('selected_price_list', value["default_price_list"]);
						}
					});
				} else {
					if (cur_dialog && cur_dialog.in_auto_repeat) {
						cur_dialog.set_value('selected_price_list', "");
					} else {
						frappe.query_report.set_filter_value('selected_price_list', '');
					}
				}
			}
		},
		{
			fieldname: "selected_price_list",
			label: __("Selected Price List"),
			fieldtype: "Link",
			options:"Price List"
		},
		{
			fieldname: "filter_items_without_price",
			label: __("Filter Items Without Price"),
			fieldtype: "Check"
		},
		{
			fieldname: "filter_items_without_print",
			label: __("Show Only Items For Print"),
			fieldtype: "Check",
			auto_email_report_default: 1,
			auto_email_report_read_only: 1
		},
		{
			fieldname: "filter_price_list_by",
			label: __("Filter Price List By"),
			fieldtype: "Select",
			options:"Enabled\nDisabled\nAll",
			default:"Enabled",
			auto_email_report_ignore: 1
		},
		{
			fieldname: "buying_selling",
			label: __("Buying Or Selling Prices"),
			fieldtype: "Select",
			options:"Selling\nBuying\nBoth",
			default:"Selling",
			hidden: !cint(frappe.defaults.get_default("restrict_amounts_in_report_to_role") && frappe.user.has_role(frappe.defaults.get_default("restrict_amounts_in_report_to_role")))
		},
		{
			fieldname: "price_list_1",
			label: __("Additional Price List 1"),
			fieldtype: "Link",
			options:"Price List",
			auto_email_report_ignore: 1
		},
		{
			fieldname: "price_list_2",
			label: __("Additional Price List 2"),
			fieldtype: "Link",
			options:"Price List",
			auto_email_report_ignore: 1
		},
		{
			fieldname: "uom",
			label: __("UOM"),
			fieldtype: "Link",
			options:"UOM",
			auto_email_report_ignore: 1
		},
		{
			fieldname: "default_uom",
			label: __("Which UOM"),
			fieldtype: "Select",
			options: "Default UOM\nStock UOM\nContents UOM",
			default: "Default UOM"
		},
		{
			fieldname: "highlight_margin_lower_bound",
			label: __("Hightlight if Margin less than"),
			fieldtype: "Float",
			default: 15
		},
	],
	formatter: function(value, row, column, data, default_formatter) {
		if (!data) {
			if (in_list(['po_qty', 'actual_qty', 'projected_qty'], column.fieldname)) {
				return default_formatter(value, row, column, data);
			} else {
				return '';
			}
		}

		var options = {
			link_target: "_blank",
			css: {}
		};

		if (column.price_list && !column.is_diff) {
			var old_rate_field = "rate_old_" + frappe.scrub(column.price_list);
			if (data.hasOwnProperty(old_rate_field)) {
				if (flt(value) < flt(data[old_rate_field])) {
					options.css['color'] = 'green';
				} else if (flt(value) > flt(data[old_rate_field])) {
					options.css['color'] = 'red';
				}
			}

			var item_price_field = "item_price_" + frappe.scrub(column.price_list);
			if (data.hasOwnProperty(item_price_field) && data[item_price_field]) {
				options.link_href = encodeURI("desk#Form/Item Price/" + data[item_price_field]);
			}
		}

		if (column.fieldname == 'valuation_rate') {
			options.link_href = encodeURI("desk#query-report/Stock Ledger?item_code=" + data['item_code']);
		}

		if (column.fieldname == "po_qty") {
			var po_from_date = frappe.query_report.get_filter_value("po_from_date");
			var po_to_date = frappe.query_report.get_filter_value("po_to_date");
			options.link_href = encodeURI("desk#query-report/Purchase Order Items To Be Received?item_code=" + data.item_code);
			if(po_from_date) {
				options.link_href += encodeURI("&from_date=" + po_from_date);
			}
			if(po_to_date) {
				options.link_href += encodeURI("&to_date=" + po_to_date);
			}
		}

		var highlight_margin_lower_bound = flt(frappe.query_report.get_filter_value("highlight_margin_lower_bound"));
		if (highlight_margin_lower_bound && column.fieldname == "margin_rate" && data['margin_rate'] < highlight_margin_lower_bound) {
			options.css['background-color'] = '#efb4b4';
		}

		if (['po_qty', 'actual_qty', 'standard_rate', 'avg_lc_rate'].includes(column.fieldname)) {
			options.css['font-weight'] = 'bold';
		}

		if (column.fieldname == "alt_uom_size") {
			options.always_show_decimals = 0;
		}

		return default_formatter(value, row, column, data, options);
	},
	onChange: function(new_value, column, data, rowIndex) {
		var method;
		var args;

		if (column.fieldname === "print_in_price_list") {
			method = "frappe.client.set_value";
			args = {
				doctype: "Item",
				name: data.item_code,
				fieldname: 'print_in_price_list',
				value: new_value
			};
		} else {
			method = "erpnext.stock.report.price_list.price_list.set_item_pl_rate";
			args = {
				effective_date: frappe.query_report.get_filter_value("date"),
				item_code: data['item_code'],
				price_list: column.price_list,
				price_list_rate: new_value,
				is_diff: cint(column.is_diff),
				uom: data['uom'],
				filters: frappe.query_report.get_filter_values()
			};
		}

		return frappe.call({
			method: method,
			args: args,
			callback: function(r) {
				if (r.message) {
					frappe.query_report.datatable.datamanager.data[rowIndex] = r.message[1][0];

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
			}
		});
	},
	onload: function(listview) {
		listview && listview.page && listview.page.add_menu_item(__("Setup Auto Email"), function() {
			var customer = frappe.query_report.get_filter_value("customer");
			var title = "Price List";
			if (customer) {
				title = title + " - " + customer;
			}

			frappe.model.with_doctype('Auto Email Report', function() {
				var filter_meta = frappe.query_reports[frappe.query_report.report_name].filters.map(d => Object.assign({}, d));
				var filter_values = frappe.query_report.get_filter_values();
				frappe.clean_auto_email_report_filters(filter_meta, filter_values, 1, 1);

				var doc = frappe.model.get_new_doc('Auto Email Report');
				doc = Object.assign(doc,{
					'report': frappe.query_report.report_name,
					'title': title,
					'from_date_field': 'date',
					'to_date_field': 'date',
					'dynamic_date_period': 'Daily',
					'day_of_week': 'Tuesday',
					'frequency': 'Weekly',
					'format': 'PDF',
					'filters': JSON.stringify(filter_values),
				});

				frappe.run_serially([
					() => frappe.set_route('Form', 'Auto Email Report', doc.name),
					() => cur_frm.set_value('filters', JSON.stringify(filter_values))
				]);
			});
		});
	},
	get_datatable_options(options) {
		return Object.assign(options, {
			hooks: {
				columnTotal: function (values, column, type) {
					if (in_list(['po_qty', 'actual_qty', 'projected_qty'], column.column.fieldname)) {
						return frappe.utils.report_column_total(values, column, type);
					} else {
						return '';
					}
				}
			},
		});
	}
};
