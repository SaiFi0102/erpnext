# -*- coding: utf-8 -*-
# Copyright (c) 2021, Frappe Technologies Pvt. Ltd. and contributors
# For license information, please see license.txt

from __future__ import unicode_literals
import frappe
from frappe import _
from frappe.utils import flt, cstr
from frappe.model.document import Document
from erpnext.selling.report.qty_adjust.qty_adjust import get_data

class QtyAdjustStockCount(Document):
	def validate(self):
		self.calculate_totals()

	def get_items(self):
		if not self.from_date or not self.to_date:
			frappe.throw(_("From Date and To Date are mandatory"))

		filters = frappe._dict({
			'date': self.from_date,
			'selected_to_date': self.to_date,
			'item_group': self.item_group,
			'brand': self.brand,
		})

		self.items = []

		data = get_data(filters)
		for d in data:
			self.append('items', d)

		self.calculate_totals()

		sorter = None
		if self.sort_by == "Item Code":
			sorter = lambda d: cstr(d.item_code)
		elif self.sort_by == "Item Name":
			sorter = lambda d: cstr(d.item_name)
		elif self.sort_by == "Net +/-":
			sorter = lambda d: flt(d.net_short_excess)
		elif self.sort_by == "Short(-)/Excess":
			sorter = lambda d: flt(d.short_excess)

		if sorter:
			self.items = sorted(self.items, key=sorter)
			for i, d in enumerate(self.items):
				d.idx = i + 1

	def calculate_totals(self):
		for d in self.items:
			d.net_short_excess = flt(d.physical_stock) + flt(d.total_selected_po_qty) - flt(d.total_selected_so_qty) - flt(d.ppk)

		self.total_actual_qty = sum([flt(d.actual_qty) for d in self.items])
		self.total_po_qty = sum([flt(d.total_selected_po_qty) for d in self.items])
		self.total_available_qty = sum([flt(d.total_available_qty) for d in self.items])
		self.total_so_qty = sum([flt(d.total_selected_so_qty) for d in self.items])
		self.total_short_excess = sum([flt(d.short_excess) for d in self.items])
		self.total_physical_stock = sum([flt(d.physical_stock) for d in self.items])
		self.total_ppk = sum([flt(d.ppk) for d in self.items])
		self.total_net_short_excess = sum([flt(d.net_short_excess) for d in self.items])
