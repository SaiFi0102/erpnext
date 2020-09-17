frappe.listview_settings['Quotation'] = {
	add_fields: ["customer_name", "base_grand_total", "status",
		"company", "currency", 'valid_till', 'confirmed_by_customer'],
	get_indicator: function(doc) {
		if(doc.status==="Open") {
			return [__("To Create SO"), "red", "status,=,Open"];
		} else if(doc.status==="Ordered") {
			return [__("Ordered"), "green", "status,=,Ordered"];
		} else if(doc.status==="Lost") {
			return [__("Lost"), "darkgrey", "status,=,Lost"];
		} else if (doc.status==="Expired") {
			return [__("Expired"), "darkgrey", "status,=,Expired"];
		} else if(doc.docstatus == 0) {
			if (doc.confirmed_by_customer) {
				return [__("To Receive"), "orange", "confirmed_by_customer,=,1|docstatus,=,0"];
			} else {
				return [__("Draft"), "darkgrey", "confirmed_by_customer,=,0|docstatus,=,0"];
			}
		}
	},
	has_indicator_for_draft: 1,
	filters: [["confirmed_by_customer", "=", "1"]]
};
