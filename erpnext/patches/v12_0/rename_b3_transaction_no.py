# Copyright (c) 2020, Frappe and Contributors
# License: GNU General Public License v3. See license.txt

import frappe


def execute():
	po_to_b3_barcode = dict(frappe.db.sql("""
		select name, b3_transaction_no
		from `tabPurchase Order`
		where ifnull(b3_transaction_no, '') != ''
	"""))

	for po_name, barcode in po_to_b3_barcode.items():
		b3_transaction_no = get_b3_transaction_no(barcode)
		frappe.db.set_value("Purchase Order", po_name, "b3_transaction_no", b3_transaction_no, update_modified=0)

	frappe.reload_doc("buying", "doctype", "purchase_order")

	for po_name, barcode in po_to_b3_barcode.items():
		frappe.db.set_value("Purchase Order", po_name, "b3_transaction_no_barcode", barcode, update_modified=0)


def get_b3_transaction_no(barcode):
	import re
	if not barcode:
		return ""
	else:
		b3_transaction_no = re.search('data-barcode-value="(.*?)"', barcode)
		b3_transaction_no = b3_transaction_no.group(1)
		return b3_transaction_no
