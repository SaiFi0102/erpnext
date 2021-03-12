# Copyright (c) 2015, Frappe Technologies Pvt. Ltd. and Contributors
# License: GNU General Public License v3. See license.txt

from __future__ import unicode_literals
import frappe
from frappe import _
from frappe.utils import flt, nowdate, getdate, add_days
from erpnext.stock.report.stock_ledger.stock_ledger import get_item_group_condition
from six import iteritems


def execute(filters=None):
	filters = frappe._dict(filters or {})
	filters.date = getdate(filters.date or nowdate())

	columns = get_columns(filters)
	data = get_data(filters)

	return columns, data


def get_data(filters):
	template = frappe._dict({"actual_qty": 0, "total_so_qty": 0, "total_po_qty": 0, "total_selected_so_qty": 0,
		"total_selected_po_qty": 0})
	def add_qty_to_item_map(data, so_or_po, set_daily):
		for d in data:
			item_map.setdefault(d.item_code, template.copy())
			item_map[d.item_code]['item_code'] = d.item_code
			item_map[d.item_code]['item_name'] = d.item_name
			item_map[d.item_code]['total_{0}_qty'.format(so_or_po)] += d.qty

			if set_daily:
				i = frappe.utils.date_diff(d.date, filters.from_date)
				day_field = '{0}_day_{1}'.format(so_or_po, i + 1)
				item_map[d.item_code].setdefault(day_field, 0)
				item_map[d.item_code][day_field] += d.qty

	conditions = get_item_conditions(filters)
	item_map = {}

	filters.from_date = filters.date
	filters.to_date = frappe.utils.add_days(filters.from_date, 4)
	po_data, so_data, sinv_data = get_order_qty_data(filters.from_date, filters.to_date, filters, conditions,
		get_daily=True)

	add_qty_to_item_map(so_data, 'so', set_daily=True)
	add_qty_to_item_map(sinv_data, 'so', set_daily=True)
	add_qty_to_item_map(po_data, 'po', set_daily=True)

	bin_data = get_bin_data(filters, conditions)
	for d in bin_data:
		item_map.setdefault(d.item_code, template.copy())
		item_map[d.item_code]['actual_qty'] = d.actual_qty
		item_map[d.item_code]['item_code'] = d.item_code
		item_map[d.item_code]['item_name'] = d.item_name

	if filters.selected_to_date:
		po_data, so_data, sinv_data = get_order_qty_data(filters.from_date, filters.selected_to_date, filters, conditions,
			get_daily=False)

		add_qty_to_item_map(so_data, 'selected_so', set_daily=False)
		add_qty_to_item_map(sinv_data, 'selected_so', set_daily=False)
		add_qty_to_item_map(po_data, 'selected_po', set_daily=False)

		for d in item_map.values():
			d.total_available_qty = d.actual_qty + d.total_selected_po_qty
			d.short_excess = d.total_available_qty - d.total_selected_so_qty

	data = sorted(item_map.values(), key=lambda d: (d.total_so_qty, d.actual_qty), reverse=True)
	return data


def get_order_qty_data(from_date, to_date, filters, item_conditions, get_daily):
	filters = filters.copy()
	filters.from_date = from_date
	filters.to_date = to_date

	sales_group_by = ", s.delivery_date" if get_daily else ""
	purchase_group_by = ", p.schedule_date" if get_daily else ""

	po_data = frappe.db.sql("""
		select
			i.item_code, i.item_name, p.schedule_date as date,
			sum((i.qty - ifnull(i.received_qty, 0)) * i.conversion_factor) as qty
		from `tabPurchase Order Item` i
		inner join `tabPurchase Order` p on p.name = i.parent
		inner join `tabItem` im on im.name = i.item_code and im.is_sales_item = 1
		where p.docstatus < 2 and p.status != 'Closed' and ifnull(i.received_qty, 0) < ifnull(i.qty, 0)
			and p.schedule_date between %(from_date)s and %(to_date)s {0}
		group by i.item_code {1}
	""".format(item_conditions, purchase_group_by), filters, as_dict=1)

	so_data = frappe.db.sql("""
		select
			i.item_code, i.item_name, s.delivery_date as date,
			sum((i.qty - ifnull(i.delivered_qty, 0)) * i.conversion_factor) as qty
		from `tabSales Order Item` i
		inner join `tabSales Order` s on s.name = i.parent
		inner join `tabItem` im on im.name = i.item_code and im.is_sales_item = 1
		where s.docstatus < 2 and ifnull(i.delivered_qty, 0) < ifnull(i.qty, 0) and s.status != 'Closed'
			and s.delivery_date between %(from_date)s and %(to_date)s {0}
		group by i.item_code {1}
	""".format(item_conditions, sales_group_by), filters, as_dict=1)

	sinv_data = frappe.db.sql("""
		select
			i.item_code, i.item_name, s.delivery_date as date,
			sum(i.stock_qty) as qty
		from `tabSales Invoice Item` i
		inner join `tabSales Invoice` s on s.name = i.parent
		inner join `tabItem` im on im.name = i.item_code and im.is_sales_item = 1
		where s.docstatus = 0 and ifnull(i.sales_order, '') = ''
			and s.delivery_date between %(from_date)s and %(to_date)s {0}
		group by i.item_code {1}
	""".format(item_conditions, sales_group_by), filters, as_dict=1)

	return po_data, so_data, sinv_data


def get_bin_data(filters, item_conditions):
	return frappe.db.sql("""
		select bin.item_code, sum(bin.actual_qty) as actual_qty, im.item_name
		from tabBin bin, tabItem im
		where im.name = bin.item_code and im.is_sales_item=1 {0}
		group by bin.item_code
		having actual_qty != 0
	""".format(item_conditions), filters, as_dict=1)

def get_item_conditions(filters):
	conditions = []

	if filters.get("item_code"):
		conditions.append("im.name = %(item_code)s")
	else:
		if filters.get("brand"):
			conditions.append("im.brand=%(brand)s")
		if filters.get("item_group"):
			conditions.append(get_item_group_condition(filters.get("item_group")).replace("item.", "im."))

	conditions = " and ".join(conditions)
	return "and {0}".format(conditions) if conditions else ""


def get_columns(filters):
	columns = [
		{"fieldname": "item_code", "label": _("Item Code"), "fieldtype": "Link", "options": "Item", "width": 80},
		{"fieldname": "item_name", "label": _("Item Name"), "fieldtype": "Data", "width": 150},
		{"fieldname": "actual_qty", "label": _("In Stock"), "fieldtype": "Float", "width": 70},
	]

	if filters.selected_to_date:
		columns += [
			{"fieldname": "total_selected_po_qty", "label": _("Total PO Selected Dates"), "fieldtype": "Float", "width": 120,
				"is_po_qty": 1, "from_date": filters.date, "to_date": filters.selected_to_date},
			{"fieldname": "total_available_qty", "label": _("Total Available Qty"), "fieldtype": "Float", "width": 120},
			{"fieldname": "total_selected_so_qty", "label": _("Total SO Selected Dates"), "fieldtype": "Float", "width": 120,
				"is_so_qty": 1, "from_date": filters.date, "to_date": filters.selected_to_date},
			{"fieldname": "short_excess", "label": _("Short(-)/Excess"), "fieldtype": "Float", "width": 120},
		]

	columns += [
		{"fieldname": "total_so_qty", "label": _("Total SO"), "fieldtype": "Float", "width": 70,
			"is_so_qty": 1, "from_date": filters.date, "to_date": add_days(filters.date, 4)},
	]
	for i in range(5):
		date = add_days(filters.date, i)
		columns.append({
			"fieldname": "so_day_{0}".format(i+1),
			"label": _("SO {0}").format(frappe.utils.formatdate(date, "EEE")),
			"fieldtype": "Float",
			"is_so_qty": 1,
			"from_date": date,
			"to_date": date,
			"width": 64
		})

	columns.append({"fieldname": "total_po_qty", "label": _("Total PO"), "fieldtype": "Float", "width": 70,
		"is_po_qty": 1, "from_date": filters.date, "to_date": add_days(filters.date, 4)})
	for i in range(5):
		date = add_days(filters.date, i)
		columns.append({
			"fieldname": "po_day_{0}".format(i+1),
			"label": _("PO {0}").format(frappe.utils.formatdate(add_days(filters.date, i), "EEE")),
			"fieldtype": "Float",
			"is_po_qty": 1,
			"from_date": date,
			"to_date": date,
			"width": 64
		})

	columns.append({
		"fieldname": "physical_stock",
		"label": _("Phys. Stock"),
		"fieldtype": "Float",
		"width": 90,
		"editable": 1
	})
	columns.append({
		"fieldname": "ppk",
		"label": _("PPK"),
		"fieldtype": "Float",
		"width": 65,
		"editable": 1
	})
	columns.append({
		"fieldname": "net_short_excess",
		"label": _("Net +/-"),
		"fieldtype": "Float",
		"width": 65
	})

	return columns
