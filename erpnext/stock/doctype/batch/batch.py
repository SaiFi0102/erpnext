# Copyright (c) 2015, Frappe Technologies Pvt. Ltd. and Contributors
# License: GNU General Public License v3. See license.txt

from __future__ import unicode_literals
import frappe
from frappe import _
from frappe.model.document import Document
from frappe.model.naming import make_autoname, revert_series_if_last
from frappe.utils import flt, cint
from frappe.utils.jinja import render_template
from frappe.utils.data import add_days

class UnableToSelectBatchError(frappe.ValidationError):
	pass


def get_name_from_hash():
	"""
	Get a name for a Batch by generating a unique hash.
	:return: The hash that was generated.
	"""
	temp = None
	while not temp:
		temp = frappe.generate_hash()[:7].upper()
		if frappe.db.exists('Batch', temp):
			temp = None

	return temp


def batch_uses_naming_series():
	"""
	Verify if the Batch is to be named using a naming series
	:return: bool
	"""
	use_naming_series = cint(frappe.db.get_single_value('Stock Settings', 'use_naming_series'))
	return bool(use_naming_series)


def _get_batch_prefix():
	"""
	Get the naming series prefix set in Stock Settings.

	It does not do any sanity checks so make sure to use it after checking if the Batch
	is set to use naming series.
	:return: The naming series.
	"""
	naming_series_prefix = frappe.db.get_single_value('Stock Settings', 'naming_series_prefix')
	if not naming_series_prefix:
		naming_series_prefix = 'BATCH-'

	return naming_series_prefix


def _make_naming_series_key(prefix):
	"""
	Make naming series key for a Batch.

	Naming series key is in the format [prefix].[#####]
	:param prefix: Naming series prefix gotten from Stock Settings
	:return: The derived key. If no prefix is given, an empty string is returned
	"""
	if not unicode(prefix):
		return ''
	elif not prefix.find('#'):
		return prefix.upper() + '.#####'
	else:
		return prefix.upper()


def get_batch_naming_series():
	"""
	Get naming series key for a Batch.

	Naming series key is in the format [prefix].[#####]
	:return: The naming series or empty string if not available
	"""
	series = ''
	if batch_uses_naming_series():
		prefix = _get_batch_prefix()
		key = _make_naming_series_key(prefix)
		series = key

	return series


class Batch(Document):
	def autoname(self):
		"""Generate random ID for batch if not specified"""
		if not self.batch_id:
			create_new_batch, batch_number_series = frappe.db.get_value('Item', self.item, 
				['create_new_batch', 'batch_number_series'])

			if create_new_batch:
				if batch_number_series:
					batch_number_series = self.replace_supplier_code_namng_series(batch_number_series)
					self.batch_id = make_autoname(batch_number_series, self.doctype, self)
				elif batch_uses_naming_series():
					self.batch_id = self.get_name_from_naming_series()
				else:
					self.batch_id = get_name_from_hash()
			else:
				frappe.throw(_('Batch ID is mandatory'), frappe.MandatoryError)

		self.name = self.batch_id

	def onload(self):
		self.image = frappe.db.get_value('Item', self.item, 'image')

	def after_delete(self):
		revert_series_if_last(get_batch_naming_series(), self.name)

	def validate(self):
		self.item_has_batch_enabled()
		self.update_item_details()

	def update_item_details(self):
		item_details = frappe.db.get_value("Item", self.item, ["item_name", "item_group"], as_dict=1)
		self.item_name = item_details.item_name
		self.item_group = item_details.item_group

	def item_has_batch_enabled(self):
		if frappe.db.get_value("Item", self.item, "has_batch_no") == 0:
			frappe.throw(_("The selected item cannot have Batch"))

	def before_save(self):
		has_expiry_date, shelf_life_in_days = frappe.db.get_value('Item', self.item, ['has_expiry_date', 'shelf_life_in_days'])
		if not self.expiry_date and has_expiry_date and shelf_life_in_days:
			self.expiry_date = add_days(self.manufacturing_date, shelf_life_in_days)

		if has_expiry_date and not self.expiry_date:
			frappe.throw(_('Expiry date is mandatory for selected item'))
			frappe.msgprint(_('Set items shelf life in days, to set expiry based on manufacturing_date plus self life'))

	def get_name_from_naming_series(self):
		"""
		Get a name generated for a Batch from the Batch's naming series.
		:return: The string that was generated.
		"""
		naming_series_prefix = _get_batch_prefix()
		# validate_template(naming_series_prefix)
		naming_series_prefix = self.replace_supplier_code_namng_series(naming_series_prefix)
		name = make_autoname(naming_series_prefix, self.doctype, self)

		return name

	def replace_supplier_code_namng_series(self, series):
		if '.{SC}.' in series:
			supplier_code = None
			if self.supplier:
				supplier_code = frappe.get_cached_value("Supplier", self.supplier, 'supplier_code')

			if supplier_code:
				series = series.replace('.{SC}.', supplier_code)
			else:
				if self.supplier:
					frappe.throw(_("Cannot automatically create Batch No for Item {0} because Supplier Code not set for Supplier {1}. Please set Supplier Code or create Batch manually.")
						.format(self.item, self.supplier))
				else:
					frappe.throw(_("Cannot automatically create Batch No for Item {0} because no Supplier can be found. Please create Batch manually.")
						.format(self.item))

		return series


@frappe.whitelist()
def get_batch_qty(batch_no=None, warehouse=None, item_code=None):
	"""Returns batch actual qty if warehouse is passed,
		or returns dict of qty by warehouse if warehouse is None

	The user must pass either batch_no or batch_no + warehouse or item_code + warehouse

	:param batch_no: Optional - give qty for this batch no
	:param warehouse: Optional - give qty for this warehouse
	:param item_code: Optional - give qty for this item"""

	out = 0
	if batch_no and warehouse:
		out = flt(frappe.db.sql("""select sum(actual_qty)
			from `tabStock Ledger Entry`
			where warehouse=%s and batch_no=%s""",
			(warehouse, batch_no))[0][0] or 0)

	if batch_no and not warehouse:
		out = frappe.db.sql('''select warehouse, sum(actual_qty) as qty
			from `tabStock Ledger Entry`
			where batch_no=%s
			group by warehouse''', batch_no, as_dict=1)

	if not batch_no and item_code and warehouse:
		out = frappe.db.sql('''select batch_no, sum(actual_qty) as qty
			from `tabStock Ledger Entry`
			where item_code = %s and warehouse=%s
			group by batch_no''', (item_code, warehouse), as_dict=1)

	return out

def get_batch_qty_on(batch_no, warehouse, posting_date, posting_time):
	res = frappe.db.sql("""
		select sum(actual_qty)
		from `tabStock Ledger Entry`
		where timestamp(posting_date, posting_time) <= timestamp(%s, %s)
			and ifnull(is_cancelled, 'No') = 'No' and warehouse=%s and batch_no=%s""",
	(posting_date, posting_time, warehouse, batch_no))

	return flt(res[0][0]) if res else 0.0


@frappe.whitelist()
def get_batches_by_oldest(item_code, warehouse):
	"""Returns the oldest batch and qty for the given item_code and warehouse"""
	batches = get_batch_qty(item_code=item_code, warehouse=warehouse)
	batches_dates = [[batch, frappe.get_value('Batch', batch.batch_no, 'expiry_date')] for batch in batches]
	batches_dates.sort(key=lambda tup: tup[1])
	return batches_dates


@frappe.whitelist()
def split_batch(batch_no, item_code, warehouse, qty, new_batch_id=None):
	"""Split the batch into a new batch"""
	batch = frappe.get_doc(dict(doctype='Batch', item=item_code, batch_id=new_batch_id)).insert()
	stock_entry = frappe.get_doc(dict(
		doctype='Stock Entry',
		purpose='Repack',
		items=[
			dict(
				item_code=item_code,
				qty=float(qty or 0),
				s_warehouse=warehouse,
				batch_no=batch_no
			),
			dict(
				item_code=item_code,
				qty=float(qty or 0),
				t_warehouse=warehouse,
				batch_no=batch.name
			),
		]
	))
	stock_entry.insert()
	stock_entry.submit()

	return batch.name


def set_batch_nos(doc, warehouse_field, throw=False):
	"""Automatically select `batch_no` for outgoing items in item table"""
	for d in doc.items:
		qty = d.get('stock_qty') or d.get('transfer_qty') or d.get('qty') or 0
		has_batch_no = frappe.db.get_value('Item', d.item_code, 'has_batch_no')
		warehouse = d.get(warehouse_field, None)
		if has_batch_no and warehouse and qty > 0:
			if not d.batch_no:
				d.batch_no = get_batch_no(d.item_code, warehouse, qty, throw)
			else:
				batch_qty = get_batch_qty(batch_no=d.batch_no, warehouse=warehouse)
				if flt(batch_qty, d.precision("qty")) < flt(qty, d.precision("qty")):
					frappe.throw(_("Row #{0}: The batch {1} has only {2} qty. Please select another batch which has {3} qty available or split the row into multiple rows, to deliver/issue from multiple batches").format(d.idx, d.batch_no, batch_qty, qty))



@frappe.whitelist()
def get_batch_no(item_code, warehouse, qty=1, throw=False):
	"""
	Get batch number using First Expiring First Out method.
	:param item_code: `item_code` of Item Document
	:param warehouse: name of Warehouse to check
	:param qty: quantity of Items
	:return: String represent batch number of batch with sufficient quantity else an empty String
	"""

	batch_no = None
	batches = get_batches(item_code, warehouse)

	for batch in batches:
		if flt(qty) <= flt(batch.qty):
			batch_no = batch.name
			break

	if not batch_no:
		batch_no=""
		return batch_no
		frappe.msgprint(_('Please select a Batch for Item {0}. Unable to find a single batch that fulfills this requirement').format(frappe.bold(item_code)))
		if throw:
			raise UnableToSelectBatchError

	return batch_no

@frappe.whitelist()
def get_sufficient_batch_or_fifo(item_code, warehouse, qty=1, conversion_factor=1):
	if not warehouse or not qty:
		return []

	batches = get_batches(item_code, warehouse)

	selected_batches = []

	qty = flt(qty)
	conversion_factor = flt(conversion_factor or 1)
	stock_qty = qty * conversion_factor
	remaining_qty = stock_qty

	for batch in batches:
		if remaining_qty <= 0:
			break
		if stock_qty <= flt(batch.qty):
			return [{
				'batch_no': batch.name,
				'available_qty': batch.qty / conversion_factor,
				'selected_qty': qty
			}]

		selected_qty = min(remaining_qty, batch.qty)
		selected_batches.append({
			'batch_no': batch.name,
			'available_qty': batch.qty / conversion_factor,
			'selected_qty': selected_qty / conversion_factor
		})

		remaining_qty -= selected_qty

	if remaining_qty > 0:
		total_selected_qty = stock_qty - remaining_qty
		frappe.msgprint(_("Only {0} {1} found in {2}".format(total_selected_qty, item_code, warehouse)))

	return selected_batches

def get_batch_received_date(batch_no, warehouse):
	date = frappe.db.sql("""
		select min(timestamp(posting_date, posting_time))
		from `tabStock Ledger Entry`
		where batch_no = %s and warehouse = %s
	""", [batch_no, warehouse])

	return date[0][0] if date else None

def get_batches(item_code, warehouse):
	batches = frappe.db.sql("""
		select b.name, sum(sle.actual_qty) as qty, b.expiry_date,
			min(timestamp(sle.posting_date, sle.posting_time)) received_date
		from `tabBatch` b
		join `tabStock Ledger Entry` sle ignore index (item_code, warehouse) on b.name = sle.batch_no
		where sle.item_code = %s and sle.warehouse = %s and (b.expiry_date >= CURDATE() or b.expiry_date IS NULL)
		group by b.name
		having qty > 0
	""", (item_code, warehouse), as_dict=True)

	return sorted(batches, key=lambda d: (d.expiry_date, d.received_date))
