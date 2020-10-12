import frappe

def execute():
	frappe.reload_doc("accounts", "doctype", "payment_entry_reference")

	if frappe.db.has_column("Payment Entry Reference", "cheque_no"):
		frappe.db.sql("""
			update `tabPayment Entry Reference`
			set bill_no = cheque_no
			where ifnull(bill_no, '') = '' and ifnull(cheque_no, '') != ''
		""")