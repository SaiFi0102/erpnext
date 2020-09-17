# Copyright (c) 2015, Frappe Technologies Pvt. Ltd. and Contributors
# License: GNU General Public License v3. See license.txt

from __future__ import unicode_literals
import frappe
from frappe import _, scrub, unscrub
from frappe.utils import flt, cstr, getdate, nowdate
from frappe.desk.query_report import group_report_data
from six import string_types
import json


def execute(filters=None):
	return GrossProfitGenerator(filters).run()


class GrossProfitGenerator(object):
	def __init__(self, filters=None):
		self.filters = frappe._dict(filters or {})
		self.filters.from_date = getdate(self.filters.from_date or nowdate())
		self.filters.to_date = getdate(self.filters.to_date or nowdate())

		self.data = []

	def run(self):
		if self.filters.from_date > self.filters.to_date:
			frappe.throw(_("From Date must be before To Date"))

		self.load_invoice_items()
		self.prepare_data()
		self.get_cogs()

		data = self.get_grouped_data()
		columns = self.get_columns()

		return columns, data

	def load_invoice_items(self):
		conditions = self.get_conditions()

		self.data = frappe.db.sql("""
			select
				si.name as parent, si_item.name, si_item.idx,
				si.posting_date, si.posting_time,
				si.customer, c.customer_group, c.territory,
				si_item.item_code, si_item.item_name, si_item.batch_no, si_item.uom,
				si_item.warehouse, i.item_group, i.brand,
				si.update_stock, si_item.dn_detail, si_item.delivery_note,
				si_item.qty, si_item.stock_qty, si_item.conversion_factor, si_item.alt_uom_size, si_item.alt_uom_size_std,
				si_item.base_net_amount, si_item.returned_qty, si_item.base_returned_amount,
				GROUP_CONCAT(DISTINCT sp.sales_person SEPARATOR ', ') as sales_person,
				sum(ifnull(sp.allocated_percentage, 100)) as allocated_percentage
			from `tabSales Invoice` si
			inner join `tabSales Invoice Item` si_item on si_item.parent = si.name
			left join `tabCustomer` c on c.name = si.customer
			left join `tabItem` i on i.name = si_item.item_code
			left join `tabSales Team` sp on sp.parent = si.name and sp.parenttype = 'Sales Invoice'
			where
				si.docstatus = 1 and si.is_return = 0 and si.is_opening != 'Yes' {conditions}
			group by si.name, si_item.name
			order by si.posting_date desc, si.posting_time desc, si.name desc, si_item.idx asc
		""".format(conditions=conditions), self.filters, as_dict=1)

	def prepare_data(self):
		for d in self.data:
			if "Group by Item" in [self.filters.group_by_1, self.filters.group_by_2, self.filters.group_by_3]:
				d['doc_type'] = "Sales Invoice"
				d['reference'] = d.parent
			else:
				d['doc_type'] = "Item"
				d['reference'] = d.item_code

	def get_cogs(self):
		update_item_batch_incoming_rate(self.data)

		for item in self.data:
			item.cogs_per_unit = flt(item.valuation_rate) * flt(item.conversion_factor)
			if flt(item.get('alt_uom_size_std')):
				item.cogs_per_unit *= flt(item.alt_uom_size) / flt(item.alt_uom_size_std)

			item.cogs_qty = flt(item.qty) - flt(item.get('returned_qty'))
			item.cogs = item.cogs_per_unit * item.cogs_qty

			self.postprocess_row(item)
			item.gross_profit_per_unit = item.gross_profit / item.cogs_qty if item.cogs_qty else 0

	def get_grouped_data(self):
		data = self.data

		self.group_by = [None]
		for i in range(3):
			group_label = self.filters.get("group_by_" + str(i + 1), "").replace("Group by ", "")

			if not group_label or group_label == "Ungrouped":
				continue

			if group_label == "Invoice":
				group_field = "parent"
			elif group_label == "Item":
				group_field = "item_code"
			elif group_label == "Customer Group":
				group_field = "customer_group"
			else:
				group_field = scrub(group_label)

			self.group_by.append(group_field)

		if len(self.group_by) <= 1:
			return data

		def sort_group(group_object, group_by_map):
			group_object.per_gross_profit = group_object.totals.per_gross_profit
			group_object.rows = sorted(group_object.rows, key=lambda d: -flt(d.per_gross_profit))

		return group_report_data(data, self.group_by, calculate_totals=self.calculate_group_totals,
			postprocess_group=sort_group)

	def calculate_group_totals(self, data, group_field, group_value, grouped_by):
		total_fields = [
			'qty', 'stock_qty', 'returned_qty', 'cogs',
			'base_net_amount', 'base_returned_amount'
		]

		totals = frappe._dict()

		# Copy grouped by into total row
		for f, g in grouped_by.items():
			totals[f] = g

		# Set zeros
		for f in total_fields:
			totals[f] = 0

		# Add totals
		for d in data:
			for f in total_fields:
				totals[f] += flt(d[f])

		# Set group values
		if data:
			if 'parent' in grouped_by:
				totals['posting_date'] = data[0].get('posting_date')
				totals['customer'] = data[0].get('customer')
				totals['sales_person'] = data[0].get('sales_person')

			if 'item_code' in grouped_by:
				totals['item_group'] = data[0].get('item_group')

			if group_field == 'party':
				totals['customer_group'] = data[0].get("customer_group")

		# Set reference field
		group_reference_doctypes = {
			"customer": "Customer",
			"parent": "Sales Invoice",
			"item_code": "Item",
		}

		reference_field = group_field[0] if isinstance(group_field, (list, tuple)) else group_field
		reference_dt = group_reference_doctypes.get(reference_field, unscrub(cstr(reference_field)))
		totals['doc_type'] = reference_dt
		totals['reference'] = grouped_by.get(reference_field) if group_field else "'Total'"

		if not group_field and self.group_by == [None]:
			totals['voucher_no'] = "'Total'"

		self.postprocess_row(totals)
		return totals

	def postprocess_row(self, item):
		item.revenue = item.base_net_amount - flt(item.get('base_returned_amount'))
		item.gross_profit = item.revenue - item.cogs
		item.per_gross_profit = item.gross_profit / item.revenue * 100 if item.revenue else 0

	def get_conditions(self):
		conditions = []

		if self.filters.company:
			conditions.append("si.company = %(company)s")

		if self.filters.from_date:
			conditions.append("si.posting_date >= %(from_date)s")
		if self.filters.to_date:
			conditions.append("si.posting_date <= %(to_date)s")

		if self.filters.get("sales_invoice"):
			conditions.append("si.name = %(sales_invoice)s")

		if self.filters.get("customer"):
			conditions.append("si.customer = %(customer)s")

		if self.filters.get("customer_group"):
			lft, rgt = frappe.db.get_value("Customer Group", self.filters.customer_group, ["lft", "rgt"])
			conditions.append("""c.customer_group in (select name from `tabCustomer Group`
					where lft>=%s and rgt<=%s)""" % (lft, rgt))

		if self.filters.get("territory"):
			lft, rgt = frappe.db.get_value("Territory", self.filters.customer_group, ["lft", "rgt"])
			conditions.append("""c.territory in (select name from `tabTerritory`
					where lft>=%s and rgt<=%s)""" % (lft, rgt))

		if self.filters.get("item_code"):
			conditions.append("si_item.item_code = %(item_code)s")

		if self.filters.get("item_group"):
			lft, rgt = frappe.db.get_value("Item Group", self.filters.item_group, ["lft", "rgt"])
			conditions.append("""i.item_group in (select name from `tabItem Group` 
					where lft>=%s and rgt<=%s)""" % (lft, rgt))

		if self.filters.get("brand"):
			conditions.append("i.brand = %(brand)s")

		if self.filters.get("warehouse"):
			lft, rgt = frappe.db.get_value("Warehouse", self.filters.sales_person, ["lft", "rgt"])
			conditions.append("""si_item.warehouse in (select name from `tabWarehouse`
				where lft>=%s and rgt<=%s)""" % (lft, rgt))

		if self.filters.get("batch_no"):
			conditions.append("si_item.batch_no = %(batch_no)s")

		if self.filters.get("sales_person"):
			lft, rgt = frappe.db.get_value("Sales Person", self.filters.sales_person, ["lft", "rgt"])
			conditions.append("""sp.sales_person in (select name from `tabSales Person`
				where lft>=%s and rgt<=%s)""" % (lft, rgt))

		return "and {}".format(" and ".join(conditions)) if conditions else ""

	def get_columns(self):
		columns = []

		if len(self.group_by) > 1:
			columns += [
				{
					"label": _("Reference"),
					"fieldtype": "Dynamic Link",
					"fieldname": "reference",
					"options": "doc_type",
					"width": 180
				},
				{
					"label": _("Type"),
					"fieldtype": "Data",
					"fieldname": "doc_type",
					"width": 100
				},
			]

			columns += [
				{
					"label": _("Date"),
					"fieldtype": "Date",
					"fieldname": "posting_date",
					"width": 80
				},
			]

			group_list = [self.filters.group_by_1, self.filters.group_by_2, self.filters.group_by_3]
			if "Group by Customer" not in group_list:
				columns.append({
					"label": _("Customer"),
					"fieldtype": "Link",
					"fieldname": "customer",
					"options": "Customer",
					"width": 180
				})

			if "Group by Invoice" not in group_list:
				columns.append({
					"label": _("Sales Invoice"),
					"fieldtype": "Link",
					"fieldname": "parent",
					"options": "Sales Invoice",
					"width": 100
				})
		else:
			columns += [
				{
					"label": _("Date"),
					"fieldtype": "Date",
					"fieldname": "posting_date",
					"width": 80
				},
				{
					"label": _("Sales Invoice"),
					"fieldtype": "Link",
					"fieldname": "parent",
					"options": "Sales Invoice",
					"width": 100
				},
				{
					"label": _("Customer"),
					"fieldtype": "Link",
					"fieldname": "customer",
					"options": "Customer",
					"width": 180
				},
				{
					"label": _("Item Code"),
					"fieldtype": "Link",
					"fieldname": "item_code",
					"options": "Item",
					"width": 80
				},
			]

		columns += [
			{
				"label": _("Item Name"),
				"fieldtype": "Data",
				"fieldname": "item_name",
				"width": 150
			},
			{
				"label": _("Batch No"),
				"fieldtype": "Link",
				"fieldname": "batch_no",
				"options": "Batch",
				"width": 140
			},
			{
				"label": _("UOM"),
				"fieldtype": "Link",
				"options": "UOM",
				"fieldname": "uom",
				"width": 50
			},
			{
				"label": _("Qty"),
				"fieldtype": "Float",
				"fieldname": "qty",
				"width": 80
			},
			{
				"label": _("Returned Qty"),
				"fieldtype": "Float",
				"fieldname": "returned_qty",
				"width": 100
			},
			{
				"label": _("Net Amount"),
				"fieldtype": "Currency",
				"fieldname": "base_net_amount",
				"options": "Company:company:default_currency",
				"width": 110
			},
			{
				"label": _("Credit Amount"),
				"fieldtype": "Currency",
				"fieldname": "base_returned_amount",
				"options": "Company:company:default_currency",
				"width": 110
			},
			{
				"label": _("Valuation Rate"),
				"fieldtype": "Currency",
				"fieldname": "valuation_rate",
				"options": "Company:company:default_currency",
				"width": 110
			},
			{
				"label": _("Cost / Unit"),
				"fieldtype": "Currency",
				"fieldname": "cogs_per_unit",
				"options": "Company:company:default_currency",
				"width": 110
			},
			{
				"label": _("Revenue"),
				"fieldtype": "Currency",
				"fieldname": "revenue",
				"options": "Company:company:default_currency",
				"width": 110
			},
			{
				"label": _("COGS"),
				"fieldtype": "Currency",
				"fieldname": "cogs",
				"options": "Company:company:default_currency",
				"width": 110
			},
			{
				"label": _("Gross Profit"),
				"fieldtype": "Currency",
				"fieldname": "gross_profit",
				"options": "Company:company:default_currency",
				"width": 110
			},
			{
				"label": _("GP / Unit"),
				"fieldtype": "Currency",
				"fieldname": "gross_profit_per_unit",
				"options": "Company:company:default_currency",
				"width": 110
			},
			{
				"label": _("Gross Profit %"),
				"fieldtype": "Percent",
				"fieldname": "per_gross_profit",
				"width": 110
			},
			{
				"label": _("Sales Person"),
				"fieldtype": "Data",
				"fieldname": "sales_person",
				"width": 150
			},
		]
		if self.filters.sales_person:
			columns.append({
				"label": _("% Contribution"),
				"fieldtype": "Percent",
				"fieldname": "allocated_percentage",
				"width": 60
			})

		return columns















def update_item_batch_incoming_rate(items, doc=None, po_from_date=None, po_to_date=None):
	if not doc:
		doc = frappe._dict()

	args = items
	if doc:
		args = []
		doc_dict = doc.as_dict()
		for d in items:
			cur_arg = doc_dict.copy()
			cur_arg.update(d.as_dict())
			args.append(d)

	incoming_rate_data = get_item_incoming_rate_data(args,
		po_from_date=po_from_date or doc.get('po_cost_from_date'),
		po_to_date=po_to_date or doc.get('po_cost_to_date'))

	for i, d in enumerate(items):
		source_info = incoming_rate_data.source_map.get(i)
		if source_info:
			source_type, source_key = source_info
			source_object = incoming_rate_data.get(source_type)

			if source_object:
				d.valuation_rate = flt(source_object.get(source_key))
			else:
				d.valuation_rate = 0
		else:
			d.valuation_rate = 0


def get_item_incoming_rate_data(args, po_from_date=None, po_to_date=None):
	"""
	args list:
		'dt' or 'parenttype' or 'doctype'
		'child_docname' or 'name'
		'doc_status' or 'docstatus'
		'item_code'
		'batch_no'
		'update_stock'
		'dn_detail'
	"""

	source_map = {}

	for i, d in enumerate(args):
		parent_doctype = d.get('dt') or d.get('parenttype') or d.get('doctype')
		row_name = d.get('child_docname') or d.get('name')
		docstatus = d.get('doc_status') or d.get('docstatus')

		if d.get('batch_no'):
			source_map[i] = ('batch_incoming_rate', d.get('batch_no'))
		elif parent_doctype in ('Sales Invoice', 'Delivery Note'):
			if d.get('dn_detail') and parent_doctype == "Sales Invoice":
				voucher_detail_no = ('Delivery Note', d.get('dn_detail'))
				source_map[i] = ('sle_outgoing_rate', voucher_detail_no)
			elif docstatus == 1:
				if row_name and (parent_doctype == "Delivery Note" or d.get('update_stock')):
					voucher_detail_no = (parent_doctype, row_name)
					source_map[i] = ('sle_outgoing_rate', voucher_detail_no)
			else:
				# get_incoming_rate
				source_map[i] = (None, None)
		elif d.get('item_code'):
			source_map[i] = ('item_valuation_rate', d.get('item_code'))

	item_codes = list(set([key for obj, key in source_map.values() if obj == 'item_valuation_rate']))
	batch_nos = list(set([key for obj, key in source_map.values() if obj == 'batch_incoming_rate']))
	voucher_detail_nos = [key for obj, key in source_map.values() if obj == 'sle_outgoing_rate']

	out = frappe._dict()
	out.batch_incoming_rate = get_batch_incoming_rate(batch_nos)
	out.item_valuation_rate = get_item_valuation_rate(item_codes, po_from_date, po_to_date)
	out.sle_outgoing_rate = get_sle_outgoing_rate(voucher_detail_nos)
	out.source_map = source_map
	return out


def get_item_valuation_rate(item_codes, po_from_date=None, po_to_date=None):
	if not item_codes:
		return {}

	item_values = {item_code: frappe._dict({'cost': 0, 'qty': 0}) for item_code in item_codes}

	bin_data = frappe.db.sql("""
		select bin.item_code, sum(bin.actual_qty) as qty, sum(bin.stock_value) as cost
		from tabBin bin
		where bin.item_code in %s
		group by bin.item_code
	""", [item_codes], as_dict=1)

	for d in bin_data:
		item_values[d.item_code].cost += d.cost
		item_values[d.item_code].qty += d.qty

	po_conditions = []
	po_args = {'item_codes': item_codes}
	if po_from_date:
		po_conditions.append("po.schedule_date >= %(from_date)s")
		po_args['from_date'] = po_from_date
	if po_to_date:
		po_conditions.append("po.schedule_date <= %(to_date)s")
		po_args['to_date'] = po_to_date

	po_conditions = "and {0}".format(" and ".join(po_conditions)) if po_conditions else ""

	po_data = frappe.db.sql("""
		select
			item.item_code,
			sum(if(item.qty - item.received_qty < 0, 0, item.qty - item.received_qty) * item.conversion_factor) as qty,
			sum(if(item.qty - item.received_qty < 0, 0, item.qty - item.received_qty) * item.conversion_factor * item.landed_rate) as cost
		from `tabPurchase Order Item` item
		inner join `tabPurchase Order` po on po.name = item.parent
		where item.docstatus < 2 and po.status != 'Closed' and item.item_code in %(item_codes)s {0}
		group by item.item_code
	""".format(po_conditions), po_args, as_dict=1)

	for d in po_data:
		item_values[d.item_code].cost += d.cost
		item_values[d.item_code].qty += d.qty

	out = {item_code: item_value.cost / item_value.qty if item_value.qty else 0 for (item_code, item_value) in item_values.items()}
	return out

def get_batch_incoming_rate(batch_nos):
	if not batch_nos:
		return {}

	# get repack entries that have batch_nos as target
	repack_entry_data = frappe.db.sql("""
		select ste.name, item.batch_no, item.s_warehouse, item.t_warehouse, item.amount, item.transfer_qty as qty,
			item.additional_cost
		from `tabStock Entry` ste, `tabStock Entry Detail` item
		where ste.name = item.parent and ste.purpose = 'Repack' and ste.docstatus = 1 and exists(
			select t_item.name from `tabStock Entry Detail` t_item where t_item.parent = ste.name
				and t_item.batch_no in %s and ifnull(t_item.t_warehouse, '') != '')
	""", [batch_nos], as_dict=1)

	# create maps for stock entry -> target repack rows and stock_entry -> source repack rows
	stock_entry_to_target_items = {}
	stock_entry_to_source_items = {}
	for repack_entry_row in repack_entry_data:
		if repack_entry_row.s_warehouse:
			stock_entry_to_source_items.setdefault(repack_entry_row.name, []).append(repack_entry_row)
		if repack_entry_row.t_warehouse:
			stock_entry_to_target_items.setdefault(repack_entry_row.name, []).append(repack_entry_row)

	# create map for repacked batch -> data about its source items and costs
	target_batch_source_map = {}
	source_batch_nos = []
	for ste_name, target_items in stock_entry_to_target_items.items():
		total_incoming = sum([d.amount for d in target_items])

		for target_item in target_items:
			target_batch_data = target_batch_source_map.setdefault(target_item.batch_no, {}).setdefault(ste_name, frappe._dict())
			target_batch_data.qty = target_item.qty
			target_batch_data.additional_cost = target_item.additional_cost
			target_batch_data.contribution = (target_item.amount / total_incoming) * 100 if total_incoming\
				else 100 / len(target_items)

			source_rows = stock_entry_to_source_items.get(ste_name, [])
			target_batch_data.source_batches = [(d.batch_no, d.qty) for d in source_rows if d.batch_no]
			target_batch_data.source_non_batch_cost = sum([d.amount for d in source_rows if not d.batch_no])

			source_batch_nos += list(set([d.batch_no for d in source_rows if d.batch_no]))

	# get cost of batch_nos in argument and batch_nos in repack entry
	all_batch_nos = list(set(batch_nos + source_batch_nos))
	sle_data = frappe.db.sql("""
		select sle.batch_no, sum(sle.stock_value_difference) as cost, sum(sle.actual_qty) as qty
		from `tabStock Ledger Entry` sle
		where sle.batch_no in %s and sle.actual_qty > 0 and sle.voucher_type in ('Purchase Receipt', 'Purchase Invoice')
		group by sle.batch_no
	""", [all_batch_nos], as_dict=1) if all_batch_nos else []

	# create map for batch_no -> {'cost': ..., 'qty': ...}
	batch_to_incoming_values = {}
	for d in sle_data:
		batch_to_incoming_values[d.batch_no] = d

	# add repack raw material costs
	for target_batch_no, stes in target_batch_source_map.items():
		for ste_name, target_batch_data in stes.items():
			target_batch_incoming_value = batch_to_incoming_values.setdefault(target_batch_no, frappe._dict({'cost': 0, 'qty': 0}))

			target_batch_cost = target_batch_data.source_non_batch_cost
			target_batch_cost += target_batch_data.additional_cost

			for source_batch_no, source_batch_qty in target_batch_data.source_batches:
				source_batch_incoming_value = batch_to_incoming_values.get(source_batch_no, frappe._dict())
				target_batch_cost += flt(source_batch_incoming_value.cost) / flt(source_batch_incoming_value.qty) * source_batch_qty\
					if flt(source_batch_incoming_value.qty) else 0

			target_batch_cost = target_batch_cost * target_batch_data.contribution / 100

			target_batch_incoming_value.qty += target_batch_data.qty
			target_batch_incoming_value.cost += target_batch_cost

	out = {}
	for batch_no in batch_nos:
		batch_incoming_value = batch_to_incoming_values.get(batch_no, frappe._dict())
		out[batch_no] = batch_incoming_value.cost / batch_incoming_value.qty if batch_incoming_value else 0

	return out

def get_sle_outgoing_rate(voucher_detail_nos):
	if not voucher_detail_nos:
		return

	values = []
	for voucher_type, voucher_detail_no in voucher_detail_nos:
		values.append(voucher_type)
		values.append(voucher_detail_no)

	res = frappe.db.sql("""
		select sum(stock_value_difference) / sum(actual_qty) as outgoing_rate, voucher_type, voucher_detail_no
		from `tabStock Ledger Entry`
		where (voucher_type, voucher_detail_no) in ({0})
		group by voucher_type, voucher_detail_no
	""".format(", ".join(["(%s, %s)"] * len(voucher_detail_nos))), voucher_detail_nos, as_dict=1)

	out = {}
	for d in res:
		out[(d.voucher_type, d.voucher_detail_no)] = d.outgoing_rate

	return out