# Copyright (c) 2015, Frappe Technologies Pvt. Ltd. and Contributors
# License: GNU General Public License v3. See license.txt

from __future__ import unicode_literals
import frappe
import json
from frappe.utils import cstr, flt, cint
from frappe import msgprint, _
from frappe.model.mapper import get_mapped_doc
from erpnext.controllers.buying_controller import BuyingController
from erpnext.stock.doctype.item.item import get_last_purchase_details
from erpnext.stock.stock_balance import update_bin_qty, get_ordered_qty
from frappe.desk.notifications import clear_doctype_notifications
from erpnext.buying.utils import validate_for_items, check_on_hold_or_closed_status
from erpnext.stock.utils import get_bin
from erpnext.accounts.party import get_party_account_currency
from six import string_types
from erpnext.stock.doctype.item.item import get_item_defaults
from erpnext.setup.doctype.item_group.item_group import get_item_group_defaults
from erpnext.accounts.doctype.sales_invoice.sales_invoice import validate_inter_company_party, update_linked_doc,\
	unlink_inter_company_doc

form_grid_templates = {
	"items": "templates/form_grid/item_grid.html"
}

class PurchaseOrder(BuyingController):
	def __init__(self, *args, **kwargs):
		super(PurchaseOrder, self).__init__(*args, **kwargs)
		self.status_updater = [{
			'source_dt': 'Purchase Order Item',
			'target_dt': 'Material Request Item',
			'join_field': 'material_request_item',
			'target_field': 'ordered_qty',
			'target_parent_dt': 'Material Request',
			'target_parent_field': 'per_ordered',
			'target_ref_field': 'stock_qty',
			'source_field': 'stock_qty',
			'percent_join_field': 'material_request'
		}]

	def validate(self):
		super(PurchaseOrder, self).validate()

		self.set_status()

		self.validate_supplier()
		self.validate_schedule_date()
		validate_for_items(self)
		self.check_on_hold_or_closed_status()

		self.validate_uom_is_integer("uom", "qty")
		self.validate_uom_is_integer("stock_uom", "stock_qty")

		self.validate_with_previous_doc()
		self.validate_for_subcontracting()
		self.validate_minimum_order_qty()
		self.validate_bom_for_subcontracting_items()
		self.create_raw_materials_supplied("supplied_items")
		self.set_received_qty_for_drop_ship_items()
		self.validate_b3_information()
		validate_inter_company_party(self.doctype, self.supplier, self.company, self.inter_company_order_reference)

	def on_change(self):
		self.update_lcv_values()
		self.set_landed_cost_voucher_amount()
		for d in self.items:
			d.db_set({
				"landed_cost_voucher_amount": d.landed_cost_voucher_amount,
				"landed_rate": d.landed_rate,
			}, update_modified=False)

	def validate_b3_information(self):
		import re
		if self.carrier_code:
			if len(self.carrier_code) != 3 or not self.carrier_code.isdecimal():
				frappe.throw(_("Carrier Code must be 3 digits long"))
		
		if self.airway_bill_no:
			if len(self.airway_bill_no) != 9 or not re.search("[0-9]{4}-[0-9]{4}", self.airway_bill_no):
				frappe.throw(_("Airway Bill No must be in the format ####-####"))

		if self.b3_transaction_no:
			if len(self.b3_transaction_no) != 14 or not self.b3_transaction_no.isdecimal():
				frappe.throw(_("B3 Transaction Number must be 14 digits long"))

			check_digit = cstr(calculate_b3_transaction_no_check_digit(self.b3_transaction_no[:13]))
			if check_digit != self.b3_transaction_no[13]:
				frappe.throw(_("Invalid B3 Transaction Number Check Digit"))
	
	def update_lcv_values(self):
		lcvs_to_update = frappe.db.sql_list("""
			select distinct parent
			from `tabLanded Cost Purchase Receipt`
			where receipt_document_type='Purchase Order' and receipt_document=%s and docstatus=0
		""", [self.name])

		for name in lcvs_to_update:
			doc = frappe.get_doc("Landed Cost Voucher", name)
			doc.get_items_from_purchase_receipts()
			doc.calculate_taxes_and_totals()
			doc.save()

	def before_print(self):
		super(PurchaseOrder, self).before_print()

		self.items_by_hs_code = {}
		self.items_without_hs_code = [d for d in self.items if not frappe.get_cached_value('Item', d.item_code, 'customs_tariff_number')]

		if self.b3_transaction_no:
			self.b3_transaction_no_formatted = "{0}-{1} / {2}".format(self.b3_transaction_no[0:5], self.b3_transaction_no[5:], self.company)
		else:
			self.b3_transaction_no_formatted = ""

		add_fields = ["qty", "amount"]
		empty_dict = frappe._dict()
		empty_dict['net_weight'] = 0
		for fn in add_fields:
			empty_dict[fn] = 0

		for d in self.items:
			if d.item_code:
				item_doc = frappe.get_cached_doc("Item", d.item_code)
				country_code = frappe.get_cached_value("Country", item_doc.country_of_origin, "code").upper() if item_doc.country_of_origin else ""

				current_row = self.items_by_hs_code.setdefault((item_doc.customs_tariff_number, country_code), empty_dict.copy())
				for fn in add_fields:
					current_row[fn] += flt(d.get(fn))
				
				if cstr(d.alt_uom).lower() in ['kgs', 'kg']:
					current_row['net_weight'] += d.alt_uom_qty
				elif d.alt_uom == 'lbs':
					current_row['net_weight'] += d.alt_uom_qty * 0.45359237
				else:
					current_row['net_weight'] += d.total_weight_kg

				current_row['net_weight'] = flt(current_row['net_weight'], 0)
		
		for key, current_row in self.items_by_hs_code.items():
			current_row.hs_code, current_row.country_code = key
			current_row.rate = current_row.amount / current_row.qty if current_row.qty else 0
			current_row.base_amount = current_row.amount * self.customs_exchange_rate

			if current_row.hs_code:
				current_row.description = frappe.get_cached_value("Customs Tariff Number", key[0], "description")

		self.total_net_weight = sum([current_row['net_weight'] for current_row in self.items_by_hs_code.values()])
		self.base_customs_total = self.total * self.customs_exchange_rate

	def validate_with_previous_doc(self):
		super(PurchaseOrder, self).validate_with_previous_doc({
			"Supplier Quotation": {
				"ref_dn_field": "supplier_quotation",
				"compare_fields": [["supplier", "="], ["company", "="], ["currency", "="]],
			},
			"Supplier Quotation Item": {
				"ref_dn_field": "supplier_quotation_item",
				"compare_fields": [["project", "="], ["item_code", "="],
					["uom", "="], ["conversion_factor", "="]],
				"is_child_table": True
			},
			"Material Request": {
				"ref_dn_field": "material_request",
				"compare_fields": [["company", "="]],
			},
			"Material Request Item": {
				"ref_dn_field": "material_request_item",
				"compare_fields": [["project", "="], ["item_code", "="]],
				"is_child_table": True
			}
		})


		if cint(frappe.db.get_single_value('Buying Settings', 'maintain_same_rate')):
			self.validate_rate_with_reference_doc([["Supplier Quotation", "supplier_quotation", "supplier_quotation_item"]])

	def validate_supplier(self):
		prevent_po = frappe.db.get_value("Supplier", self.supplier, 'prevent_pos')
		if prevent_po:
			standing = frappe.db.get_value("Supplier Scorecard", self.supplier, 'status')
			if standing:
				frappe.throw(_("Purchase Orders are not allowed for {0} due to a scorecard standing of {1}.")
					.format(self.supplier, standing))

		warn_po = frappe.db.get_value("Supplier", self.supplier, 'warn_pos')
		if warn_po:
			standing = frappe.db.get_value("Supplier Scorecard",self.supplier, 'status')
			frappe.msgprint(_("{0} currently has a {1} Supplier Scorecard standing, and Purchase Orders to this supplier should be issued with caution.").format(self.supplier, standing), title=_("Caution"), indicator='orange')

		self.party_account_currency = get_party_account_currency("Supplier", self.supplier, self.company)

	def validate_minimum_order_qty(self):
		if not self.get("items"): return
		items = list(set([d.item_code for d in self.get("items")]))

		itemwise_min_order_qty = frappe._dict(frappe.db.sql("""select name, min_order_qty
			from tabItem where name in ({0})""".format(", ".join(["%s"] * len(items))), items))

		itemwise_qty = frappe._dict()
		for d in self.get("items"):
			itemwise_qty.setdefault(d.item_code, 0)
			itemwise_qty[d.item_code] += flt(d.stock_qty)

		for item_code, qty in itemwise_qty.items():
			if flt(qty) < flt(itemwise_min_order_qty.get(item_code)):
				frappe.throw(_("Item {0}: Ordered qty {1} cannot be less than minimum order qty {2} (defined in Item).").format(item_code,
					qty, itemwise_min_order_qty.get(item_code)))

	def validate_bom_for_subcontracting_items(self):
		if self.is_subcontracted == "Yes":
			for item in self.items:
				if not item.bom:
					frappe.throw(_("BOM is not specified for subcontracting item {0} at row {1}"\
						.format(item.item_code, item.idx)))

	def get_schedule_dates(self):
		for d in self.get('items'):
			if d.material_request_item and not d.schedule_date:
				d.schedule_date = frappe.db.get_value("Material Request Item",
						d.material_request_item, "schedule_date")


	def get_last_purchase_rate(self):
		"""get last purchase rates for all items"""

		conversion_rate = flt(self.get('conversion_rate')) or 1.0
		for d in self.get("items"):
			if d.item_code:
				last_purchase_details = get_last_purchase_details(d.item_code, self.name)
				if last_purchase_details:
					d.base_price_list_rate = (last_purchase_details['base_price_list_rate'] *
						(flt(d.conversion_factor) or 1.0))
					d.discount_percentage = last_purchase_details['discount_percentage']
					d.base_rate = last_purchase_details['base_rate'] * (flt(d.conversion_factor) or 1.0)
					d.price_list_rate = d.base_price_list_rate / conversion_rate
					d.rate = d.base_rate / conversion_rate
					d.last_purchase_rate = d.rate
				else:

					item_last_purchase_rate = frappe.get_cached_value("Item", d.item_code, "last_purchase_rate")
					if item_last_purchase_rate:
						d.base_price_list_rate = d.base_rate = d.price_list_rate \
							= d.rate = d.last_purchase_rate = item_last_purchase_rate

	# Check for Closed status
	def check_on_hold_or_closed_status(self):
		check_list =[]
		for d in self.get('items'):
			if d.meta.get_field('material_request') and d.material_request and d.material_request not in check_list:
				check_list.append(d.material_request)
				check_on_hold_or_closed_status('Material Request', d.material_request)

	def update_requested_qty(self):
		material_request_map = {}
		for d in self.get("items"):
			if d.material_request_item:
				material_request_map.setdefault(d.material_request, []).append(d.material_request_item)

		for mr, mr_item_rows in material_request_map.items():
			if mr and mr_item_rows:
				mr_obj = frappe.get_doc("Material Request", mr)

				if mr_obj.status in ["Stopped", "Cancelled"]:
					frappe.throw(_("Material Request {0} is cancelled or stopped").format(mr), frappe.InvalidStatusError)

				mr_obj.update_requested_qty(mr_item_rows)

	def update_ordered_qty(self, po_item_rows=None):
		"""update requested qty (before ordered_qty is updated)"""
		item_wh_list = []
		for d in self.get("items"):
			if (not po_item_rows or d.name in po_item_rows) \
				and [d.item_code, d.warehouse] not in item_wh_list \
				and frappe.get_cached_value("Item", d.item_code, "is_stock_item") \
				and d.warehouse and not d.delivered_by_supplier:
					item_wh_list.append([d.item_code, d.warehouse])
		for item_code, warehouse in item_wh_list:
			update_bin_qty(item_code, warehouse, {
				"ordered_qty": get_ordered_qty(item_code, warehouse)
			})

	def check_modified_date(self):
		mod_db = frappe.db.sql("select modified from `tabPurchase Order` where name = %s",
			self.name)
		date_diff = frappe.db.sql("select '%s' - '%s' " % (mod_db[0][0], cstr(self.modified)))

		if date_diff and date_diff[0][0]:
			msgprint(_("{0} {1} has been modified. Please refresh.").format(self.doctype, self.name),
				raise_exception=True)

	def update_status(self, status):
		if self.docstatus == 0 and status == "Closed":
			#self.submit()
			self.flags.allow_draft_cancel = 1
			self.cancel()
			return

		self.check_modified_date()
		self.set_status(update=True, status=status)
		self.update_requested_qty()
		self.update_ordered_qty()
		if self.is_subcontracted == "Yes":
			self.update_reserved_qty_for_subcontract()

		self.notify_update()
		clear_doctype_notifications(self)

	def on_submit(self):
		super(PurchaseOrder, self).on_submit()

		if self.is_against_so():
			self.update_status_updater()

		self.update_prevdoc_status()
		self.update_requested_qty()
		self.update_ordered_qty()
		self.validate_budget()

		if self.is_subcontracted == "Yes":
			self.update_reserved_qty_for_subcontract()

		frappe.get_doc('Authorization Control').validate_approving_authority(self.doctype,
			self.company, self.base_grand_total)

		self.update_blanket_order()

		update_linked_doc(self.doctype, self.name, self.inter_company_order_reference)

	def on_cancel(self):
		super(PurchaseOrder, self).on_cancel()

		if self.is_against_so():
			self.update_status_updater()

		if self.has_drop_ship_item():
			self.update_delivered_qty_in_sales_order()

		if self.is_subcontracted == "Yes":
			self.update_reserved_qty_for_subcontract()

		self.check_on_hold_or_closed_status()

		frappe.db.set(self,'status','Cancelled')

		self.update_prevdoc_status()

		# Must be called after updating ordered qty in Material Request
		self.update_requested_qty()
		self.update_ordered_qty()

		self.update_blanket_order()

		unlink_inter_company_doc(self.doctype, self.name, self.inter_company_order_reference)

	def on_update(self):
		pass

	def update_status_updater(self):
		self.status_updater.append({
			'source_dt': 'Purchase Order Item',
			'target_dt': 'Sales Order Item',
			'target_field': 'ordered_qty',
			'target_parent_dt': 'Sales Order',
			'target_parent_field': '',
			'join_field': 'sales_order_item',
			'target_ref_field': 'stock_qty',
			'source_field': 'stock_qty'
		})

	def update_delivered_qty_in_sales_order(self):
		"""Update delivered qty in Sales Order for drop ship"""
		sales_orders_to_update = []
		for item in self.items:
			if item.sales_order and item.delivered_by_supplier == 1:
				if item.sales_order not in sales_orders_to_update:
					sales_orders_to_update.append(item.sales_order)

		for so_name in sales_orders_to_update:
			so = frappe.get_doc("Sales Order", so_name)
			so.update_delivery_status()
			so.set_status(update=True)
			so.notify_update()

	def has_drop_ship_item(self):
		return any([d.delivered_by_supplier for d in self.items])

	def is_against_so(self):
		return any([d.sales_order for d in self.items if d.sales_order])

	def set_received_qty_for_drop_ship_items(self):
		for item in self.items:
			if item.delivered_by_supplier == 1:
				item.received_qty = item.qty

	def update_reserved_qty_for_subcontract(self):
		for d in self.supplied_items:
			if d.rm_item_code:
				stock_bin = get_bin(d.rm_item_code, d.reserve_warehouse)
				stock_bin.update_reserved_qty_for_sub_contracting()

	def update_receiving_percentage(self):
		total_qty, received_qty = 0.0, 0.0
		for item in self.items:
			received_qty += item.received_qty
			total_qty += item.qty
		if total_qty:
			self.db_set("per_received", flt(received_qty/total_qty) * 100, update_modified=False)
		else:
			self.db_set("per_received", 0, update_modified=False)

def item_last_purchase_rate(name, conversion_rate, item_code, conversion_factor= 1.0):
	"""get last purchase rate for an item"""

	conversion_rate = flt(conversion_rate) or 1.0

	last_purchase_details =  get_last_purchase_details(item_code, name)
	if last_purchase_details:
		last_purchase_rate = (last_purchase_details['base_net_rate'] * (flt(conversion_factor) or 1.0)) / conversion_rate
		return last_purchase_rate
	else:
		item_last_purchase_rate = frappe.get_cached_value("Item", item_code, "last_purchase_rate")
		if item_last_purchase_rate:
			return item_last_purchase_rate

@frappe.whitelist()
def close_or_unclose_purchase_orders(names, status):
	if not frappe.has_permission("Purchase Order", "write"):
		frappe.throw(_("Not permitted"), frappe.PermissionError)

	names = json.loads(names)
	for name in names:
		po = frappe.get_doc("Purchase Order", name)
		if po.docstatus == 1:
			if status == "Closed":
				if po.status not in ( "Cancelled", "Closed") and (po.per_received < 100 or po.per_billed < 100):
					po.update_status(status)
			else:
				if po.status == "Closed":
					po.update_status("Draft")
			po.update_blanket_order()

	frappe.local.message_log = []

def set_missing_values(source, target):
	target.ignore_pricing_rule = 1
	target.run_method("set_missing_values")
	target.run_method("calculate_taxes_and_totals")

@frappe.whitelist()
def make_purchase_receipt(source_name, target_doc=None):
	def update_item(obj, target, source_parent):
		target.qty = flt(obj.qty) - flt(obj.received_qty)
		target.received_qty = flt(obj.qty) - flt(obj.received_qty)
		target.stock_qty = (flt(obj.qty) - flt(obj.received_qty)) * flt(obj.conversion_factor)
		target.amount = (flt(obj.qty) - flt(obj.received_qty)) * flt(obj.rate)
		target.base_amount = (flt(obj.qty) - flt(obj.received_qty)) * \
			flt(obj.rate) * flt(source_parent.conversion_rate)

		target.pallets_ordered = flt(obj.pallets)
		target.qty_ordered = flt(obj.qty)

	doc = get_mapped_doc("Purchase Order", source_name,	{
		"Purchase Order": {
			"doctype": "Purchase Receipt",
			"field_map": {
				"per_billed": "per_billed",
				"supplier_warehouse":"supplier_warehouse",
				"shipping_date": "shipping_date"
			},
			"validation": {
				"docstatus": ["=", 1],
			}
		},
		"Purchase Order Item": {
			"doctype": "Purchase Receipt Item",
			"field_map": {
				"name": "purchase_order_item",
				"parent": "purchase_order",
				"bom": "bom",
				"material_request": "material_request",
				"material_request_item": "material_request_item"
			},
			"postprocess": update_item,
			"condition": lambda doc: abs(doc.received_qty) < abs(doc.qty) and doc.delivered_by_supplier!=1
		},
		"Purchase Taxes and Charges": {
			"doctype": "Purchase Taxes and Charges",
			"add_if_empty": True
		}
	}, target_doc, set_missing_values)

	return doc

@frappe.whitelist()
def make_purchase_invoice(source_name, target_doc=None):
	return get_mapped_purchase_invoice(source_name, target_doc)

@frappe.whitelist()
def make_purchase_invoice_from_portal(purchase_order_name):
	doc = get_mapped_purchase_invoice(purchase_order_name, ignore_permissions=True)
	if doc.contact_email != frappe.session.user:
		frappe.throw(_('Not Permitted'), frappe.PermissionError)
	doc.save()
	frappe.db.commit()
	frappe.response['type'] = 'redirect'
	frappe.response.location = '/purchase-invoices/' + doc.name

def get_mapped_purchase_invoice(source_name, target_doc=None, ignore_permissions=False):
	def postprocess(source, target):
		target.flags.ignore_permissions = ignore_permissions
		set_missing_values(source, target)
		target.update_stock = 1
		#Get the advance paid Journal Entries in Purchase Invoice Advance

		if target.get("allocate_advances_automatically"):
			target.set_advances()

	def update_item(obj, target, source_parent):
		target.qty = flt(obj.qty) - flt(obj.billed_qty) - flt(obj.returned_qty)

		target.pallets_ordered = flt(obj.pallets)
		target.qty_ordered = flt(obj.qty)

	fields = {
		"Purchase Order": {
			"doctype": "Purchase Invoice",
			"field_map": {
				"party_account_currency": "party_account_currency",
				"supplier_warehouse":"supplier_warehouse",
				"posting_date": "received_date"
			},
			"validation": {
				"docstatus": ["=", 1],
			}
		},
		"Purchase Order Item": {
			"doctype": "Purchase Invoice Item",
			"field_map": {
				"name": "po_detail",
				"parent": "purchase_order",
			},
			"postprocess": update_item,
			"condition": lambda doc: doc.qty and (abs(doc.billed_qty) < abs(doc.qty))
		},
		"Purchase Taxes and Charges": {
			"doctype": "Purchase Taxes and Charges",
			"add_if_empty": True
		},
	}

	if frappe.get_single("Accounts Settings").automatically_fetch_payment_terms == 1:
		fields["Payment Schedule"] = {
			"doctype": "Payment Schedule",
			"add_if_empty": True
		}

	doc = get_mapped_doc("Purchase Order", source_name,	fields,
		target_doc, postprocess, ignore_permissions=ignore_permissions)

	return doc

@frappe.whitelist()
def make_rm_stock_entry(purchase_order, rm_items):
	if isinstance(rm_items, string_types):
		rm_items_list = json.loads(rm_items)
	else:
		frappe.throw(_("No Items available for transfer"))

	if rm_items_list:
		fg_items = list(set(d["item_code"] for d in rm_items_list))
	else:
		frappe.throw(_("No Items selected for transfer"))

	if purchase_order:
		purchase_order = frappe.get_doc("Purchase Order", purchase_order)

	if fg_items:
		items = tuple(set(d["rm_item_code"] for d in rm_items_list))
		item_wh = get_item_details(items)

		stock_entry = frappe.new_doc("Stock Entry")
		stock_entry.purpose = "Send to Subcontractor"
		stock_entry.purchase_order = purchase_order.name
		stock_entry.supplier = purchase_order.supplier
		stock_entry.supplier_name = purchase_order.supplier_name
		stock_entry.supplier_address = purchase_order.supplier_address
		stock_entry.address_display = purchase_order.address_display
		stock_entry.company = purchase_order.company
		stock_entry.to_warehouse = purchase_order.supplier_warehouse
		stock_entry.set_stock_entry_type()

		for item_code in fg_items:
			for rm_item_data in rm_items_list:
				if rm_item_data["item_code"] == item_code:
					rm_item_code = rm_item_data["rm_item_code"]
					items_dict = {
						rm_item_code: {
							"po_detail": rm_item_data.get("name"),
							"item_name": rm_item_data["item_name"],
							"description": item_wh.get(rm_item_code, {}).get('description', ""),
							'qty': rm_item_data["qty"],
							'from_warehouse': rm_item_data["warehouse"],
							'stock_uom': rm_item_data["stock_uom"],
							'main_item_code': rm_item_data["item_code"],
							'allow_alternative_item': item_wh.get(rm_item_code, {}).get('allow_alternative_item')
						}
					}
					stock_entry.add_to_stock_entry_detail(items_dict)
		return stock_entry.as_dict()
	else:
		frappe.throw(_("No Items selected for transfer"))
	return purchase_order.name

def get_item_details(items):
	item_details = {}
	for d in frappe.db.sql("""select item_code, description, allow_alternative_item from `tabItem`
		where name in ({0})""".format(", ".join(["%s"] * len(items))), items, as_dict=1):
		item_details[d.item_code] = d

	return item_details

def get_list_context(context=None):
	from erpnext.controllers.website_list_for_contact import get_list_context
	list_context = get_list_context(context)
	list_context.update({
		'show_sidebar': True,
		'show_search': True,
		'no_breadcrumbs': True,
		'title': _('Purchase Orders'),
	})
	return list_context

@frappe.whitelist()
def generate_b3_transaction_no(company):
	from frappe.model.naming import make_autoname

	asec_security_number = frappe.get_cached_value("Company", company, "asec_security_number")
	if not asec_security_number:
		frappe.throw(_("Please set Account Security Number (ASEC) for company {0}").format(company))

	series = "{0}.########".format(asec_security_number)
	b3_transaction_no = make_autoname(series, "Purchase Order")
	check_digit = calculate_b3_transaction_no_check_digit(b3_transaction_no)

	return "{0}{1}".format(b3_transaction_no, check_digit)

def calculate_b3_transaction_no_check_digit(b3_transaction_no):
	if len(b3_transaction_no) != 13 or not b3_transaction_no.isdecimal():
		frappe.throw(_("Invalid B3 Transaction Number"))

	D = []
	for i, char in enumerate(b3_transaction_no):
		a = int(char)
		b = 1 if i % 2 == 0 else 2
		c = a * b

		lft = c // 10
		rgt = c % 10
		d = lft + rgt

		D.append(d)

	E = sum(D)
	F = E % 10
	return F


@frappe.whitelist()
def update_status(status, name):
	po = frappe.get_doc("Purchase Order", name)

	if po.docstatus < 2:
		po.update_status(status)
		po.update_delivered_qty_in_sales_order()

@frappe.whitelist()
def make_inter_company_sales_order(source_name, target_doc=None):
	from erpnext.accounts.doctype.sales_invoice.sales_invoice import make_inter_company_transaction
	return make_inter_company_transaction("Purchase Order", source_name, target_doc)

@frappe.whitelist()
def get_customs_exchange_rate(from_currency, to_currency, transaction_date=None):
	import requests 

	if not transaction_date:
		transaction_date = frappe.utils.today()

	try:
		cache = frappe.cache()
		key = "bank_of_canada_FX{0}:{1}:{2}".format(from_currency, to_currency, transaction_date)
		value = flt(cache.get(key))
		if not value:
			start_date = end_date = frappe.utils.add_days(transaction_date, -1)
			if frappe.utils.getdate(start_date).weekday() == 5:  # Saturday
				start_date = frappe.utils.add_days(start_date, -1)
			elif frappe.utils.getdate(start_date).weekday() == 6:  # Sunday
				start_date = frappe.utils.add_days(start_date, -2)

			url = "https://www.bankofcanada.ca/valet/observations/FX{0}{1}?start_date={2}&end_date={3}".format(from_currency,
				to_currency, start_date, end_date)

			data = requests.get(url).json()
			observation = data["observations"][-1]
			value = flt(observation["FX{0}{1}".format(from_currency, to_currency)]["v"])
			cache.setex(key, value, 6 * 60 * 60)
	except:
		frappe.log_error(title="Get Exchange Rate")
		frappe.msgprint(_("Unable to find exchange rate for {0} to {1} for key date {2}. Please set a Currency Exchange manually").format(from_currency, to_currency, transaction_date))
		return 0.0

	return value