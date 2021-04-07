// Copyright (c) 2015, Frappe Technologies Pvt. Ltd. and Contributors
// License: GNU General Public License v3. See license.txt

frappe.query_reports["Accounts Payable Summary"] = {
	"filters": [
		{
			"fieldname":"company",
			"label": __("Company"),
			"fieldtype": "Link",
			"options": "Company",
			"default": frappe.defaults.get_user_default("Company")
		},
		{
			"fieldname":"ageing_based_on",
			"label": __("Ageing Based On"),
			"fieldtype": "Select",
			"options": 'Posting Date\nDue Date',
			"default": "Posting Date"
		},
		{
			"fieldname":"report_date",
			"label": __("Date"),
			"fieldtype": "Date",
			"default": frappe.datetime.get_today()
		},
		{
			"fieldname":"range1",
			"label": __("Ageing Range 1"),
			"fieldtype": "Int",
			"default": "30",
			"reqd": 1
		},
		{
			"fieldname":"range2",
			"label": __("Ageing Range 2"),
			"fieldtype": "Int",
			"default": "60",
			"reqd": 1
		},
		{
			"fieldname":"range3",
			"label": __("Ageing Range 3"),
			"fieldtype": "Int",
			"default": "90",
			"reqd": 1
		},
		{
			"fieldname":"finance_book",
			"label": __("Finance Book"),
			"fieldtype": "Link",
			"options": "Finance Book"
		},
		{
			"fieldname":"supplier",
			"label": __("Supplier"),
			"fieldtype": "Link",
			"options": "Supplier"
		},
		{
			"fieldname":"supplier_group",
			"label": __("Supplier Group"),
			"fieldtype": "Link",
			"options": "Supplier Group"
		},
		{
			"fieldname": "account",
			"label": __("Payable Account"),
			"fieldtype": "Link",
			"options": "Account",
			"get_query": function() {
				var company = frappe.query_report.get_filter_value('company');
				return {
					"doctype": "Account",
					"filters": {
						"company": company,
						"account_type": "Payable",
						"is_group": 0
					}
				}
			}
		},
	],

	formatter: function(value, row, column, data, default_formatter) {
		var link;
		var filters = frappe.query_report.get_values();
		if (data && column.fieldname == 'advance_amount' && flt(value)) {
			link = encodeURI("desk#Form/Payment Reconciliation/Payment Reconciliation?company="+filters.company+"&party_type=Supplier&party=" + data['supplier']);
		}
		if (data && column.fieldname == __("supplier")) {
			link = encodeURI("desk#query-report/Accounts Payable/Accounts Payable?supplier=" + data['supplier'] + "&report_date=" + filters.report_date);
		}

		return default_formatter(value, row, column, data, {link_href: link, link_target: "_blank"});
	},

	onload: function(report) {
		report.page.add_inner_button(__("Accounts Payable"), function() {
			var filters = report.get_values();
			frappe.set_route('query-report', 'Accounts Payable', {company: filters.company});
		});
	}
}

erpnext.utils.add_dimensions('Accounts Payable Summary', 9);

