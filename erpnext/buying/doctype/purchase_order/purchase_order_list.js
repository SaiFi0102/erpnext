frappe.listview_settings['Purchase Order'] = {
	add_fields: ["base_grand_total", "company", "currency", "supplier",
		"supplier_name", "per_received", "per_billed", "per_completed", "status"],
	get_indicator: function (doc) {
		if (doc.status === "Closed") {
			return [__("Closed"), "green", "status,=,Closed"];
		} else if (doc.status === "On Hold") {
			return [__("On Hold"), "orange", "status,=,On Hold"];
		} else if (doc.status === "Delivered") {
			return [__("Delivered"), "green", "status,=,Closed"];
		} else if (flt(doc.per_received, 2) < 100 && doc.status !== "Closed") {
			if (flt(doc.per_completed, 2) < 100) {
				return [__("To Receive and Bill"), "orange",
					"per_received,<,100|per_completed,<,100|status,!=,Closed"];
			} else {
				return [__("To Receive"), "orange",
					"per_received,<,100|per_completed,=,100|status,!=,Closed"];
			}
		} else if (flt(doc.per_received, 2) == 100 && flt(doc.per_completed, 2) < 100 && doc.status !== "Closed") {
			return [__("To Bill"), "orange", "per_received,=,100|per_completed,<,100|status,!=,Closed"];
		} else if (flt(doc.per_received, 2) == 100 && flt(doc.per_completed, 2) == 100 && doc.status !== "Closed") {
			return [__("Completed"), "green", "per_received,=,100|per_completed,=,100|status,!=,Closed"];
		}
	},
	onload: function (listview) {
		listview.page.add_action_item(__("Create Landed Cost Voucher"), function () {
			var names = cur_list.get_checked_items(true);
			if (!names || !names.length) {
				return;
			}

			return frappe.call({
				method: "erpnext.stock.doctype.landed_cost_voucher.landed_cost_voucher.get_landed_cost_voucher",
				args: {
					"dt": "Purchase Order",
					"dn": names
				},
				callback: function(r) {
					var doclist = frappe.model.sync(r.message);
					frappe.set_route("Form", doclist[0].doctype, doclist[0].name);
				}
			});
		});

		var status_method = "erpnext.buying.doctype.purchase_order.purchase_order.close_or_unclose_purchase_orders";

		listview.page.add_action_item(__("Close"), function () {
			listview.call_for_selected_items(status_method, { "status": "Closed" });
		});

		listview.page.add_action_item(__("Re-open"), function () {
			listview.call_for_selected_items(status_method, { "status": "Submitted" });
		});
	}
};
