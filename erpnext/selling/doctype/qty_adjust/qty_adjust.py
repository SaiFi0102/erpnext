# -*- coding: utf-8 -*-
# Copyright (c) 2019, Frappe Technologies Pvt. Ltd. and contributors
# For license information, please see license.txt

from __future__ import unicode_literals
import frappe
from frappe import _
from frappe.utils import cint
from frappe.model.document import Document
from frappe.utils import flt, getdate
from six import string_types
import json


class QtyAdjust(Document):
	def qty_adjust_sales_orders(self, checked_rows=None):
		sales_orders = list(filter(lambda d: d.doc_status == 0 and d.dt == "Sales Order", self.sales_orders))

		if isinstance(checked_rows, string_types):
			checked_rows = json.loads(checked_rows)

		# Validate
		if self.new_item_code and self.item_code == self.new_item_code:
			frappe.throw(_("New Item Code is the same as the selected Item Code"))
		if self.new_item_code and not checked_rows:
			frappe.throw(_("New Item Code is set but no rows are check marked. Please check rows to change Item Code for or remove 'Change Item Code'"))

		for d in sales_orders:
			if flt(d.back_order_qty) and not d.back_order_date:
				frappe.throw(_("Row #{0}: Please select Back Order Date for {1}").format(d.idx, d.dn))
			if d.back_order_date and getdate(d.back_order_date) <= getdate(d.date):
				frappe.throw(_("Row #{0}: Back Order Date {1} must be after Order Date {2} of {3}")
					.format(d.idx, d.get_formatted("back_order_date"), d.get_formatted("date"), d.dn))

		# Change Item Code
		if self.new_item_code and checked_rows:
			for d in sales_orders:
				if d.name in checked_rows:
					change_item_code(d.dn, d.so_detail, self.new_item_code, self.item_code)

		# Adjust
		for d in sales_orders:
			if flt(d.qty, d.precision('qty')) != flt(d.allocated_qty, d.precision('qty')):
				qty_adjust_so_item(d.dn, d.so_detail, d.allocated_qty / d.conversion_factor,
					d.back_order_qty / d.conversion_factor, d.back_order_date)

		frappe.msgprint("Sales Orders Adjusted")

	def validate(self):
		frappe.throw(_("Cannot save Qty Adjust"))


def change_item_code(sales_order, so_detail, new_item_code, old_item_code):
	from erpnext.stock.get_item_details import get_item_details

	doc = frappe.get_doc("Sales Order", sales_order)
	row = list(filter(lambda d: d.name == so_detail, doc.items))
	if not row:
		frappe.throw(_("Could not find Item {0} in {1}").format(old_item_code, sales_order))
	else:
		row = row[0]

	item_details = get_item_details({
		'item_code': new_item_code,
		'set_warehouse': doc.set_warehouse,
		'warehouse': row.warehouse,
		'customer': doc.customer,
		'currency': doc.currency,
		'conversion_rate': doc.conversion_rate,
		'price_list': doc.selling_price_list,
		'price_list_currency': doc.price_list_currency,
		'plc_conversion_rate': doc.plc_conversion_rate,
		'company': doc.company,
		'order_type': doc.order_type,
		'transaction_date': doc.transaction_date or doc.get('posting_date'),
		'delivery_date': doc.delivery_date or doc.transaction_date or doc.get('posting_date'),
		'ignore_pricing_rule': cint(row.override_price_list_rate or doc.ignore_pricing_rule),
		'doctype': doc.doctype,
		'name': doc.name,
		'project': row.get('project') or doc.project,
		'qty': row.qty or 0,
		'stock_qty': row.stock_qty,
		'uom': row.uom,
		'tax_category': doc.tax_category
	})

	for f in ['meta', 'name', 'doctype']:
		if f in item_details:
			del item_details[f]

	row.update(item_details)
	doc.save()


@frappe.whitelist()
def get_sales_orders_for_qty_adjust(item_code, from_date, to_date=None, sort_by="Date"):
	date_condition = "and so.delivery_date >= %(from_date)s"
	if to_date:
		date_condition += "and so.delivery_date <= %(to_date)s"
	date_condition_si = date_condition.replace("so.", "sinv.")

	so_data = frappe.db.sql("""
		select 'Sales Order' as dt, so.name as dn, so.docstatus as doc_status, so.customer, so.delivery_date as date,
			i.name as so_detail, (i.qty - ifnull(i.delivered_qty, 0)) * i.conversion_factor as qty, i.conversion_factor,
			i.item_code, '' as batch_no, i.alt_uom_size, i.alt_uom_size_std, i.base_net_amount, i.qty as actual_qty
		from `tabSales Order Item` i
		inner join `tabSales Order` so on so.name = i.parent
		where so.docstatus < 2 and ifnull(i.delivered_qty, 0) < ifnull(i.qty, 0) and so.status != 'Closed'
			and i.item_code = %(item_code)s {0}
		
		union all
		
		select 'Sales Invoice' as dt, sinv.name as dn, sinv.docstatus as doc_status, sinv.customer, sinv.delivery_date as date,
			i.name as so_detail, i.stock_qty as qty, i.conversion_factor,
			i.item_code, i.batch_no, i.alt_uom_size, i.alt_uom_size_std, i.base_net_amount, i.qty as actual_qty
		from `tabSales Invoice Item` i
		inner join `tabSales Invoice` sinv on sinv.name = i.parent
		where sinv.docstatus = 0 and ifnull(i.sales_order, '') = ''
			and i.item_code = %(item_code)s {1}
	""".format(date_condition, date_condition_si), {"from_date": from_date, "to_date": to_date, "item_code": item_code}, as_dict=1)

	update_gross_profit_on_sales_orders(so_data, from_date, to_date)

	def sort_key(d):
		if sort_by == "Profit Margin (Ascending)":
			return d.per_gross_profit, d.dt, d.dn
		elif sort_by == "Customer (Ascending)":
			return d.customer, d.date, d.dt, d.dn
		elif sort_by == "Qty (Descending)":
			return -d.qty, d.dt, d.dn
		else:
			return d.date, d.dt, d.dn

	so_data = sorted(so_data, key=sort_key)
	return so_data


def update_gross_profit_on_sales_orders(so_data, from_date, to_date):
	from erpnext.accounts.report.gross_profit.gross_profit import update_item_batch_incoming_rate
	update_item_batch_incoming_rate(so_data, po_from_date=from_date, po_to_date=to_date)

	for d in so_data:
		force_set_selling_item_prices = cint(frappe.get_cached_value("Stock Settings", None, "force_set_selling_item_prices"))

		if d.doc_status == 0 and force_set_selling_item_prices:
			doc = frappe.get_doc(d.dt, d.dn)
			doc.force_set_item_prices(d.so_detail)
			doc_item = doc.get('items', filters={'name': d.so_detail})
			doc_item = doc_item[0] if doc_item else None
			if doc_item:
				d.base_net_amount = doc_item.base_net_amount

		d.cogs_per_unit = flt(d.valuation_rate) * flt(d.conversion_factor)
		if flt(d.get('alt_uom_size_std')):
			d.cogs_per_unit *= flt(d.alt_uom_size) / flt(d.alt_uom_size_std)

		d.revenue = d.base_net_amount
		d.cogs_qty = flt(d.actual_qty)
		d.cogs = d.cogs_per_unit * d.cogs_qty
		d.gross_profit = d.revenue - d.cogs
		d.per_gross_profit = d.gross_profit / d.revenue * 100 if d.revenue else 0
		d.gross_profit_per_unit = d.gross_profit / d.cogs_qty if d.cogs_qty else 0

@frappe.whitelist()
def qty_adjust_so_item(sales_order_name, so_detail, adjusted_qty, backorder_qty=0, backorder_date=None):
	sales_order = frappe.get_doc("Sales Order", sales_order_name)
	if sales_order.docstatus != 0:
		return

	so_item = list(filter(lambda d: d.name == so_detail, sales_order.items))
	if not so_item:
		return

	so_item = so_item[0]

	ordered_qty = flt(so_item.qty, so_item.precision('qty'))
	adjusted_qty = flt(adjusted_qty, so_item.precision('qty'))
	backorder_qty = flt(backorder_qty, so_item.precision('qty'))
	if ordered_qty == adjusted_qty:
		return

	sales_order.qty_adjust = 1
	so_item.qty = flt(adjusted_qty)
	so_item.stock_qty = flt(so_item.qty * so_item.conversion_factor)
	so_item.boxes = flt(so_item.stock_qty, so_item.precision('boxes'))

	sales_order.save()

	backorder = backorder_item = None
	if backorder_qty > 0 and backorder_date:
		backorder, backorder_item = create_backorder(sales_order, so_item, backorder_qty, backorder_date)

	create_qty_adjust_log(sales_order, so_item, ordered_qty, adjusted_qty, backorder_qty, backorder, backorder_item)


def create_backorder(sales_order, so_item, backorder_qty, backorder_date):
	existing_backorder = frappe.db.sql_list("""select name from `tabSales Order`
		where delivery_date=%s and customer=%s and selling_price_list=%s and docstatus=0
		order by name limit 1""", [backorder_date, sales_order.customer, sales_order.selling_price_list])

	if existing_backorder:
		backorder = frappe.get_doc("Sales Order", existing_backorder[0])
	else:
		backorder = frappe.new_doc("Sales Order")
		backorder.update({
			"order_type": sales_order.order_type,
			"company": sales_order.company,
			"customer": sales_order.customer,
			"transaction_date": frappe.utils.nowdate(),
			"delivery_date": backorder_date,
			"selling_price_list": sales_order.selling_price_list,
			"payment_terms_template": sales_order.payment_terms_template,
			"currency": sales_order.currency,
			"customer_address": sales_order.customer_address,
			"shipping_address_name": sales_order.shipping_address_name,
			"contact_person": sales_order.contact_person,
			"items": []
		})

	backorder.is_back_order = 1

	backorder_item = list(filter(lambda d: d.item_code == so_item.item_code and d.uom == so_item.uom\
		and flt(d.alt_uom_size, d.precision('alt_uom_size')) == flt(d.alt_uom_size_std, d.precision('alt_uom_size'))
		and not cint(d.override_price_list_rate)
		and d.prevdoc_docname == so_item.prevdoc_docname, backorder.items))

	if backorder_item:
		backorder_item = backorder_item[0]
	else:
		backorder_item = backorder.append("items", {
			"item_code": so_item.item_code,
			"item_name": so_item.item_name,
			"uom": so_item.uom,
			"qty": 0,
			"prevdoc_docname": so_item.prevdoc_docname,
			"warehouse": so_item.warehouse
		})

	backorder_item.qty += backorder_qty

	backorder.set_missing_values()
	backorder_item.boxes = flt(backorder_item.stock_qty, backorder_item.precision('boxes'))

	backorder.save()

	return backorder, backorder_item


def create_qty_adjust_log(sales_order, so_item, ordered_qty, allocated_qty, backorder_qty, backorder, backorder_item):
	ordered_qty = flt(ordered_qty * so_item.conversion_factor, so_item.precision('qty'))
	allocated_qty = flt(allocated_qty * so_item.conversion_factor, so_item.precision('qty'))
	backorder_qty = flt(backorder_qty * so_item.conversion_factor, so_item.precision('qty'))

	frappe.get_doc({
		"date": frappe.utils.today(),
		"item_code": so_item.item_code,
		"item_name": so_item.item_name,
		"doctype": "Qty Adjustment Log",
		"name": "New Qty Adjustment Log 1",
		"ordered_qty": ordered_qty,
		"allocated_qty": allocated_qty,
		"sales_order": sales_order.name,
		"sales_order_item": so_item.name,
		"back_qty": backorder_qty,
		"customer": sales_order.customer,
		"qty_surplus_and_shortage": flt(ordered_qty) - flt(allocated_qty),
		"back_order": backorder.name if backorder else None,
		"back_order_item": backorder_item.name if backorder_item else None
	}).insert()
