# Copyright (c) 2013, Frappe Technologies Pvt. Ltd. and contributors
# For license information, please see license.txt

from __future__ import unicode_literals
import frappe
from frappe.utils import flt


def execute(filters=None):
	columns = get_columns()
	data = get_data(filters)
	return columns, data


def get_data(filters):
	conditions = []
	if filters.get('item_code'):
		conditions.append("item_code = %(item_code)s")
	if filters.get('from_date'):
		conditions.append("po.`schedule_date` >= %(from_date)s")
	if filters.get('to_date'):
		conditions.append("po.`schedule_date` <= %(to_date)s")
	conditions_sql = "and {0}".format(" and ".join(conditions)) if conditions else ""

	data = frappe.db.sql("""
		select
			po.`name` as purchase_order,
			i.`schedule_date` as arrival_date,
			po.`supplier`,
			i.item_code,
			i.stock_qty as ordered_qty,
			(i.qty - ifnull(i.received_qty, 0)) * i.conversion_factor as balance_qty,
			i.landed_rate * i.conversion_factor as lc_rate,
			i.landed_cost_voucher_amount / (i.qty * i.conversion_factor) as lcv_rate,
			po.order_type as shipping_mode,
			po.status
		from
			`tabPurchase Order` po, `tabPurchase Order Item` i
		where
			i.`parent` = po.`name`
			and po.docstatus < 2
			and po.status not in ('Stopped', 'Closed')
			and ifnull(i.received_qty, 0) < ifnull(i.qty, 0) {0}
		order by po.schedule_date asc
	""".format(conditions_sql), filters, as_dict=1)

	for d in data:
		d["lc_rate"] = flt(d.get("lc_rate"), 2)
		d["lcv_rate"] = flt(d.get("lcv_rate"), 2)

	return data


def get_columns():
	columns = [
		"Purchase Order:Link/Purchase Order:100",
		"Arrival Date:Date:80",
		"Supplier:Link/Supplier:120",
		"Item Code:Link/Item:80",
		"Ordered Qty:Float:70",
		"Balance Qty:Float:90",
	]

	show_amounts_role = frappe.db.get_single_value("Stock Settings", "restrict_amounts_in_report_to_role")
	show_amounts = show_amounts_role and show_amounts_role in frappe.get_roles()
	if show_amounts:
		columns += [
			{"label": "LC/Unit", "fieldname": "lc_rate", "fieldtype": "Currency", "width": 70},
			{"label": "Expenses/Unit", "fieldname": "lcv_rate", "fieldtype": "Currency", "width": 70},
		]

	columns += [
		"Shipping Mode:Link/Master Purchase Order Type:110",
		"Status::120",
	]

	return columns
