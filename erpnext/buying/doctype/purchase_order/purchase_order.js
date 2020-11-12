// Copyright (c) 2015, Frappe Technologies Pvt. Ltd. and Contributors
// License: GNU General Public License v3. See license.txt

frappe.provide("erpnext.buying");

{% include 'erpnext/public/js/controllers/buying.js' %};

frappe.ui.form.on("Purchase Order", {
	setup: function(frm) {
		frm.custom_make_buttons = {
			'Purchase Receipt': 'Receipt',
			'Purchase Invoice': 'Invoice',
			'Stock Entry': 'Material to Supplier',
			'Landed Cost Voucher': 'Landed Cost Voucher'
		};

		frm.set_query("reserve_warehouse", "supplied_items", function() {
			return {
				filters: {
					"company": frm.doc.company,
					"name": ['!=', frm.doc.supplier_warehouse],
					"is_group": 0
				}
			}
		});

		frm.set_indicator_formatter('item_code',
			function(doc) { return (doc.qty<=doc.received_qty) ? "green" : "orange" })

		frm.set_query("expense_account", "items", function() {
			return {
				query: "erpnext.controllers.queries.get_expense_account",
				filters: {'company': frm.doc.company}
			}
		});

	},

	refresh: function(frm) {
		if(frm.doc.docstatus === 1 && frm.doc.status !== 'Closed'
			&& flt(frm.doc.per_received) < 100 && flt(frm.doc.per_billed) < 100) {
			frm.add_custom_button(__('Update Items'), () => {
				erpnext.utils.update_child_items({
					frm: frm,
					child_docname: "items",
					child_doctype: "Purchase Order Detail",
					cannot_add_row: false,
				})
			});
		}
	},

	onload: function(frm) {
		set_schedule_date(frm);
		if (!frm.doc.transaction_date){
			frm.set_value('transaction_date', frappe.datetime.get_today())
		}

		erpnext.queries.setup_queries(frm, "Warehouse", function() {
			return erpnext.queries.warehouse(frm.doc);
		});
	},

	onload_post_render: function(frm) {
		frm.fields_dict.items.grid.wrapper.on('click', '.grid-row-check', function(e) {
			frm.cscript.show_hide_add_remove_default_items();
			frm.cscript.show_hide_add_update_item_prices();
		});

		if (frm.doc.__onload && frm.doc.__onload.from_copy) {
			frm.cscript.apply_price_list();
		}

		frm.fields_dict.items.grid.add_custom_button("Remove Supplier Default",
			() => frm.cscript.remove_selected_from_default_items("Supplier", "supplier")
		).addClass('btn-set-default-items');
		frm.fields_dict.items.grid.add_custom_button("Add Supplier Default",
			() => frm.cscript.add_selected_to_default_items("Supplier", "supplier")
		).addClass('btn-set-default-items');

		frm.fields_dict.items.grid.add_custom_button("Update Item Prices",
			frm.cscript.update_selected_item_prices).addClass('btn-update-item-prices');

		frm.cscript.show_hide_add_remove_default_items();
		frm.cscript.show_hide_add_update_item_prices();
	},

	validate: function(frm) {
		for (var i = frm.fields_dict['items'].grid.grid_rows.length - 1; i >= 0; --i) {
			var grid_row = frm.fields_dict['items'].grid.grid_rows[i];
			if (!grid_row.doc.qty) {
				grid_row.remove();
			}
		}
	},

	airway_bill_no: function(frm) {
		let value = frm.doc.airway_bill_no;

		if (value) {
			value = value.replace(/[^0-9]+/g, "");
			if(value.length >= 4) {
				value = value.slice(0,4) + "-" + value.slice(4);
			}
		}
		frm.set_value("airway_bill_no", value)
	}
});

frappe.ui.form.on("Purchase Order Item", {
	schedule_date: function(frm, cdt, cdn) {
		var row = locals[cdt][cdn];
		if (row.schedule_date) {
			if(!frm.doc.schedule_date) {
				erpnext.utils.copy_value_in_all_rows(frm.doc, cdt, cdn, "items", "schedule_date");
			} else {
				set_schedule_date(frm);
			}
		}
	}
});

erpnext.buying.PurchaseOrderController = erpnext.buying.BuyingController.extend({
	item_po_gross_profit_fields: ["base_selling_price", "gross_profit", "gross_profit_per_unit", "per_gross_profit"],

	refresh: function(doc, cdt, cdn) {
		var me = this;
		this._super();
		var allow_receipt = false;
		var is_drop_ship = false;

		for (var i in cur_frm.doc.items) {
			var item = cur_frm.doc.items[i];
			if(item.delivered_by_supplier !== 1) {
				allow_receipt = true;
			} else {
				is_drop_ship = true;
			}

			if(is_drop_ship && allow_receipt) {
				break;
			}
		}

		if (this.frm.doc.docstatus < 2 && !this.frm.doc.__islocal) {
			this.frm.add_custom_button(__('Print Barcode Labels'), () => this.show_print_barcode_label_dialog(() => {
				if (!this.frm.doc.b3_transaction_no) {
					frappe.throw(__("B3 Transaction No is not set"));
				}
			}));
		}

		this.frm.set_df_property("drop_ship", "hidden", !is_drop_ship);

		if(doc.docstatus < 1 && !in_list(["Closed", "Delivered"], doc.status)) {
			if (this.frm.has_perm("submit")) {
				if(flt(doc.per_completed, 6) < 100 || flt(doc.per_received, 6) < 100) {
					cur_frm.add_custom_button(__('Close'), this.close_purchase_order, __("Status"));
				}
			}

			if(is_drop_ship && doc.status!="Delivered"){
				cur_frm.add_custom_button(__('Delivered'),
					this.delivered_by_supplier, __("Status"));

				cur_frm.page.set_inner_btn_group_as_primary(__("Status"));
			}
		} else if(doc.docstatus===0) {
			cur_frm.cscript.add_from_mappers();
		}

		if(doc.docstatus == 1 && in_list(["Closed", "Delivered"], doc.status)) {
			if (this.frm.has_perm("submit")) {
				cur_frm.add_custom_button(__('Re-open'), this.unclose_purchase_order, __("Status"));
			}
		}

		if(doc.docstatus == 1 && doc.status != "Closed") {
			if(flt(doc.per_received, 2) < 100 && allow_receipt) {
				cur_frm.add_custom_button(__('Receipt'), this.make_purchase_receipt, __("Create"));

				if(doc.is_subcontracted==="Yes") {
					cur_frm.add_custom_button(__('Material to Supplier'),
						function() { me.make_stock_entry(); }, __("Transfer"));
				}
			}

			if(flt(doc.per_completed, 2) < 100)
				cur_frm.add_custom_button(__('Invoice'),
					this.make_purchase_invoice, __("Create"));

			if(flt(doc.per_billed)==0 && doc.status != "Delivered" && flt(doc.per_completed, 2) < 100) {
				cur_frm.add_custom_button(__('Payment'), cur_frm.cscript.make_payment_entry, __("Create"));
			}

			if(!doc.auto_repeat) {
				cur_frm.add_custom_button(__('Subscription'), function() {
					erpnext.utils.make_subscription(doc.doctype, doc.name)
				}, __("Create"))
			}

			if(flt(doc.per_billed)==0 && flt(doc.per_completed, 2) < 100) {
				this.frm.add_custom_button(__('Payment Request'),
					function() { me.make_payment_request() }, __("Create"));
			}

			cur_frm.page.set_inner_btn_group_as_primary(__("Create"));
		}

		if(doc.docstatus < 2 && !doc.__islocal) {
			cur_frm.add_custom_button(__('Landed Cost Voucher'), this.make_landed_cost_voucher, __("Create"));
		}

		if(doc.docstatus < 2) {
			this.calculate_gross_profit();
			this.frm.refresh_fields();
		}
	},

	show_hide_add_update_item_prices: function() {
		var has_checked = this.frm.fields_dict.items.grid.grid_rows.some(row => row.doc.__checked);
		if (has_checked) {
			$(".btn-update-item-prices", this.frm.fields_dict.items.grid.grid_buttons).removeClass("hidden");
		} else {
			$(".btn-update-item-prices", this.frm.fields_dict.items.grid.grid_buttons).addClass("hidden");
		}
	},

	update_selected_item_prices: function() {
		var me = this;
		var frm = cur_frm;
		var rows = frm.fields_dict.items.grid.grid_rows
			.filter(row => row.doc.__checked && row.doc.item_code && row.doc.rate)
			.map(function(row) { return {
				item_code: row.doc.item_code,
				item_name: row.doc.item_name,
				price_list_rate: row.doc.rate,
				uom: row.doc.uom,
				conversion_factor: row.doc.conversion_factor
			}});

		var price_list = frm.doc.buying_price_list;
		this.data = [];

		if (price_list && rows.length) {
			var dialog = new frappe.ui.Dialog({
				title: __("Update Price List {0}", [price_list]), fields: [
					{label: __("Effective Date"), fieldname: "effective_date", fieldtype: "Date", reqd: 1},
					{label: __("Item Prices"), fieldname: "items", fieldtype: "Table", data: this.data,
						get_data: () => this.data,
						cannot_add_rows: true, in_place_edit: true,
						fields: [
							{
								label: __('Item Code'),
								fieldname:"item_code",
								fieldtype:'Link',
								options: 'Item',
								read_only: 1,
								in_list_view: 1,
								columns: 2,
							},
							{
								label: __('Item Name'),
								fieldname:"item_name",
								fieldtype:'Data',
								read_only: 1,
								in_list_view: 1,
								columns: 4,
							},
							{
								label: __('UOM'),
								fieldtype:'Link',
								fieldname:"uom",
								read_only: 1,
								in_list_view: 1,
								columns: 2,
							},
							{
								label: __('New Rate'),
								fieldtype:'Currency',
								fieldname:"price_list_rate",
								default: 0,
								read_only: 1,
								in_list_view: 1,
								columns: 2,
							},
							{
								label: __('Conversion Factor'),
								fieldtype:'Float',
								precision: 9,
								fieldname:"conversion_factor",
								read_only: 1
							}
						]
					}
				]
			});

			dialog.fields_dict.items.df.data = rows;
			this.data = dialog.fields_dict.items.df.data;
			dialog.fields_dict.items.grid.refresh();

			dialog.show();
			dialog.set_primary_action(__('Update Price List'), function() {
				var updated_items = this.get_values()["items"];
				return frappe.call({
					method: "erpnext.stock.report.price_list.price_list.set_multiple_item_pl_rate",
					args: {
						effective_date: dialog.get_value('effective_date'),
						items: updated_items,
						price_list: price_list
					},
					callback: function() {
						dialog.hide();
					}
				});
			});
		}
	},

	show_print_barcode_label_dialog: function(validation) {
		if (validation) {
			validation(this.frm);
		}

		let me = this;
		let available_print_formats = me.frm.meta.__print_formats.filter(d => d.name.toLowerCase().includes('barcode')).map(d => d.name);
		let default_print_format = available_print_formats ? available_print_formats[0] : "";
		let dialog = new frappe.ui.Dialog({
			title: __("Barcode Label Print"),
			fields: [
				{
					fieldname: "print_format",
					fieldtype: "Select",
					label: __("Print Format"),
					options: available_print_formats,
					default: default_print_format,
					reqd: 1
				},
				{
					fieldname: "print_qty",
					fieldtype: "Int",
					label: __("Print Qty"),
					default: 1
				}
			]
		});
		dialog.set_primary_action(__("Print"), function () {
			let print_qty = cint(dialog.get_value('print_qty'));
			if (print_qty > 0) {
				me.frm.print_preview.refresh_print_options();
				me.frm.print_preview.print_sel.val(dialog.get_value('print_format'));
				me.frm.print_preview.printit({
					print_qty: print_qty
				});
			}
			dialog.hide();
		});
		dialog.show();
	},

	get_items_from_open_material_requests: function() {
		erpnext.utils.map_current_doc({
			method: "erpnext.stock.doctype.material_request.material_request.make_purchase_order_based_on_supplier",
			source_name: this.frm.doc.supplier,
			get_query_filters: {
				docstatus: ["!=", 2],
			}
		});
	},

	validate: function() {
		set_schedule_date(this.frm);
	},

	has_unsupplied_items: function() {
		return this.frm.doc['supplied_items'].some(item => item.required_qty != item.supplied_qty)
	},

	update_selected_item_fields: function() {
		this.update_selected_item_gross_profit();
	},

	update_selected_item_gross_profit: function() {
		var me = this;
		var grid_row = this.selected_item_dn ? this.frm.fields_dict['items'].grid.grid_rows_by_docname[this.selected_item_dn] : null;

		var all_fields = [];
		all_fields.push(...this.item_po_gross_profit_fields);

		if(grid_row && grid_row.doc.item_code) {
			$.each(all_fields, function (i, f) {
				me.frm.doc['selected_' + f] = grid_row.doc[f];
			});
		} else {
			$.each(all_fields, function (i, f) {
				me.frm.doc['selected_' + f] = 0;
			});
		}

		$.each(me.gp_link_fields || [], function (i, f) {
			var link = "desk#query-report/Batch Profitability";
			if (grid_row) {
				link += "?batch_no=" + grid_row.doc.batch_no;
			}
			$("a", me.frm.fields_dict['selected_' + f].$input_wrapper).attr("href", link);
		});

		$.each(all_fields.map(d => "selected_" + d), function (i, fieldname) {
			me.frm.refresh_field(fieldname);
		});
	},

	make_stock_entry: function() {
		var items = $.map(cur_frm.doc.items, function(d) { return d.bom ? d.item_code : false; });
		var me = this;

		if(items.length >= 1){
			me.raw_material_data = [];
			me.show_dialog = 1;
			let title = __('Transfer Material to Supplier');
			let fields = [
			{fieldtype:'Section Break', label: __('Raw Materials')},
			{fieldname: 'sub_con_rm_items', fieldtype: 'Table', label: __('Items'),
				fields: [
					{
						fieldtype:'Data',
						fieldname:'item_code',
						label: __('Item'),
						read_only:1,
						in_list_view:1
					},
					{
						fieldtype:'Data',
						fieldname:'rm_item_code',
						label: __('Raw Material'),
						read_only:1,
						in_list_view:1
					},
					{
						fieldtype:'Float',
						read_only:1,
						fieldname:'qty',
						label: __('Quantity'),
						read_only:1,
						in_list_view:1
					},
					{
						fieldtype:'Data',
						read_only:1,
						fieldname:'warehouse',
						label: __('Reserve Warehouse'),
						in_list_view:1
					},
					{
						fieldtype:'Float',
						read_only:1,
						fieldname:'rate',
						label: __('Rate'),
						hidden:1
					},
					{
						fieldtype:'Float',
						read_only:1,
						fieldname:'amount',
						label: __('Amount'),
						hidden:1
					},
					{
						fieldtype:'Link',
						read_only:1,
						fieldname:'uom',
						label: __('UOM'),
						hidden:1
					}
				],
				data: me.raw_material_data,
				get_data: function() {
					return me.raw_material_data;
				}
			}
		]

		me.dialog = new frappe.ui.Dialog({
			title: title, fields: fields
		});

		if (me.frm.doc['supplied_items']) {
			me.frm.doc['supplied_items'].forEach((item, index) => {
			if (item.rm_item_code && item.main_item_code && item.required_qty - item.supplied_qty != 0) {
					me.raw_material_data.push ({
						'name':item.name,
						'item_code': item.main_item_code,
						'rm_item_code': item.rm_item_code,
						'item_name': item.rm_item_code,
						'qty': item.required_qty - item.supplied_qty,
						'warehouse':item.reserve_warehouse,
						'rate':item.rate,
						'amount':item.amount,
						'stock_uom':item.stock_uom
					});
					me.dialog.fields_dict.sub_con_rm_items.grid.refresh();
				}
			})
		}

		me.dialog.get_field('sub_con_rm_items').check_all_rows()

		me.dialog.show()
		this.dialog.set_primary_action(__('Transfer'), function() {
			me.values = me.dialog.get_values();
			if(me.values) {
				me.values.sub_con_rm_items.map((row,i) => {
					if (!row.item_code || !row.rm_item_code || !row.warehouse || !row.qty || row.qty === 0) {
						frappe.throw(__("Item Code, warehouse, quantity are required on row" + (i+1)));
					}
				})
				me._make_rm_stock_entry(me.dialog.fields_dict.sub_con_rm_items.grid.get_selected_children())
				me.dialog.hide()
				}
			});
		}

		me.dialog.get_close_btn().on('click', () => {
			me.dialog.hide();
		});

	},

	_make_rm_stock_entry: function(rm_items) {
		frappe.call({
			method:"erpnext.buying.doctype.purchase_order.purchase_order.make_rm_stock_entry",
			args: {
				purchase_order: cur_frm.doc.name,
				rm_items: rm_items
			}
			,
			callback: function(r) {
				var doclist = frappe.model.sync(r.message);
				frappe.set_route("Form", doclist[0].doctype, doclist[0].name);
			}
		});
	},

	make_inter_company_order: function(frm) {
		frappe.model.open_mapped_doc({
			method: "erpnext.buying.doctype.purchase_order.purchase_order.make_inter_company_sales_order",
			frm: frm
		});
	},

	make_purchase_receipt: function() {
		frappe.model.open_mapped_doc({
			method: "erpnext.buying.doctype.purchase_order.purchase_order.make_purchase_receipt",
			frm: cur_frm
		})
	},

	make_purchase_invoice: function() {
		frappe.model.open_mapped_doc({
			method: "erpnext.buying.doctype.purchase_order.purchase_order.make_purchase_invoice",
			frm: cur_frm
		})
	},

	add_from_mappers: function() {
		var me = this;
		this.frm.add_custom_button(__('Material Request'),
			function() {
				erpnext.utils.map_current_doc({
					method: "erpnext.stock.doctype.material_request.material_request.make_purchase_order",
					source_doctype: "Material Request",
					target: me.frm,
					setters: {
						company: me.frm.doc.company
					},
					get_query_filters: {
						material_request_type: "Purchase",
						docstatus: 1,
						status: ["!=", "Stopped"],
						per_ordered: ["<", 99.99],
					}
				})
			}, __("Get items from"));

		this.frm.add_custom_button(__('Supplier Quotation'),
			function() {
				erpnext.utils.map_current_doc({
					method: "erpnext.buying.doctype.supplier_quotation.supplier_quotation.make_purchase_order",
					source_doctype: "Supplier Quotation",
					target: me.frm,
					setters: {
						company: me.frm.doc.company
					},
					get_query_filters: {
						docstatus: 1,
						status: ["!=", "Stopped"],
					}
				})
			}, __("Get items from"));

		this.frm.add_custom_button(__('Update rate as per last purchase'),
			function() {
				frappe.call({
					"method": "get_last_purchase_rate",
					"doc": me.frm.doc,
					callback: function(r, rt) {
						me.frm.dirty();
						me.frm.cscript.calculate_taxes_and_totals();
					}
				})
			}, __("Tools"));

		this.frm.add_custom_button(__('Link to Material Request'),
		function() {
			var my_items = [];
			for (var i in me.frm.doc.items) {
				if(!me.frm.doc.items[i].material_request){
					my_items.push(me.frm.doc.items[i].item_code);
				}
			}
			frappe.call({
				method: "erpnext.buying.utils.get_linked_material_requests",
				args:{
					items: my_items
				},
				callback: function(r) {
					if(r.exc) return;

					var i = 0;
					var item_length = me.frm.doc.items.length;
					while (i < item_length) {
						var qty = me.frm.doc.items[i].qty;
						(r.message[0] || []).forEach(function(d) {
							if (d.qty > 0 && qty > 0 && me.frm.doc.items[i].item_code == d.item_code && !me.frm.doc.items[i].material_request_item)
							{
								me.frm.doc.items[i].material_request = d.mr_name;
								me.frm.doc.items[i].material_request_item = d.mr_item;
								var my_qty = Math.min(qty, d.qty);
								qty = qty - my_qty;
								d.qty = d.qty  - my_qty;
								me.frm.doc.items[i].stock_qty = my_qty * me.frm.doc.items[i].conversion_factor;
								me.frm.doc.items[i].qty = my_qty;

								frappe.msgprint("Assigning " + d.mr_name + " to " + d.item_code + " (row " + me.frm.doc.items[i].idx + ")");
								if (qty > 0) {
									frappe.msgprint("Splitting " + qty + " units of " + d.item_code);
									var new_row = frappe.model.add_child(me.frm.doc, me.frm.doc.items[i].doctype, "items");
									item_length++;

									for (var key in me.frm.doc.items[i]) {
										new_row[key] = me.frm.doc.items[i][key];
									}

									new_row.idx = item_length;
									new_row["stock_qty"] = new_row.conversion_factor * qty;
									new_row["qty"] = qty;
									new_row["material_request"] = "";
									new_row["material_request_item"] = "";
								}
							}
						});
						i++;
					}
					refresh_field("items");
				}
			});
		}, __("Tools"));
	},

	tc_name: function() {
		this.get_terms();
	},

	items_add: function(doc, cdt, cdn) {
		var row = frappe.get_doc(cdt, cdn);
		if(doc.schedule_date) {
			row.schedule_date = doc.schedule_date;
			refresh_field("schedule_date", cdn, "items");
		} else {
			this.frm.script_manager.copy_from_first_row("items", row, ["schedule_date"]);
		}
	},

	unhold_purchase_order: function(){
		cur_frm.cscript.update_status("Resume", "Draft")
	},

	hold_purchase_order: function(){
		var me = this;
		var d = new frappe.ui.Dialog({
			title: __('Reason for Hold'),
			fields: [
				{
					"fieldname": "reason_for_hold",
					"fieldtype": "Text",
					"reqd": 1,
				}
			],
			primary_action: function() {
				var data = d.get_values();
				frappe.call({
					method: "frappe.desk.form.utils.add_comment",
					args: {
						reference_doctype: me.frm.doctype,
						reference_name: me.frm.docname,
						content: __('Reason for hold: ')+data.reason_for_hold,
						comment_email: frappe.session.user
					},
					callback: function(r) {
						if(!r.exc) {
							me.update_status('Hold', 'On Hold')
							d.hide();
						}
					}
				});
			}
		});
		d.show();
	},

	unclose_purchase_order: function(){
		cur_frm.cscript.update_status('Re-open', 'Submitted')
	},

	close_purchase_order: function(){
		if (cur_frm.doc.docstatus == 0) {
			frappe.confirm(__('Are you sure you want to close this Purchase Order. This will cancel the document permanently.'), function () {
				cur_frm.cscript.update_status('Close', 'Closed')
			})
		} else {
			cur_frm.cscript.update_status('Close', 'Closed')
		}
	},

	delivered_by_supplier: function(){
		cur_frm.cscript.update_status('Deliver', 'Delivered')
	},

	items_on_form_rendered: function() {
		set_schedule_date(this.frm);
	},

	schedule_date: function() {
		set_schedule_date(this.frm);
		this.get_base_selling_prices();
	},

	transaction_date: function () {
		this._super();
		this.get_base_selling_prices();
	},

	selected_base_selling_price: function() {
		var me = this;
		var new_price = flt(me.frm.doc.selected_base_selling_price);
		if (!new_price) {
			return;
		}
		if (!me.selected_item_dn) {
			me.frm.doc.selected_base_selling_price = 0;
			me.frm.refresh_field('selected_base_selling_price');
			return;
		}

		var item = frappe.model.get_doc('Purchase Order Item', me.selected_item_dn);
		var args = me._get_args(item);
		if (!args) {
			return;
		}

		Object.assign(args, args.items[0]);

		return frappe.call({
			method: 'erpnext.stock.get_item_details.get_base_selling_price',
			args: {args: args, item_code: item.item_code},
			freeze: 1,
			callback: function (r) {
				if (!r.exc) {
					me.show_set_base_price_dialog(item, new_price, flt(r.message))
				}
			}
		});
	},

	show_set_base_price_dialog: function (item, new_price, old_price) {
		var me = this;

		if (!me.can_get_gross_profit()) {
			return;
		}

		var dialog = new frappe.ui.Dialog({
			title: __('Update Base Selling Price'),
			fields: [
				{
					label: "Item Code",
					fieldname: "item_code",
					fieldtype: "Link",
					options: "Item",
					read_only: 1,
					default: item.item_code
				},
				{
					label: "Price Effective Date",
					fieldname: "effective_date",
					fieldtype: "Date",
					reqd: 1,
					default: me.frm.doc.schedule_date
				},
				{
					fieldtype: "Column Break",
				},
				{
					label: "Item Name",
					fieldname: "item_name",
					fieldtype: "Data",
					read_only: 1,
					default: item.item_name
				},
				{
					label: "UOM (Default)",
					fieldname: "uom",
					fieldtype: "Data",
					read_only: 1,
					default: item.stock_uom
				},
				{
					fieldtype: "Section Break",
				},
				{
					fieldtype: "Section Break",
				},
				{
					label: "Old Base Selling Rate",
					fieldname: "old_price",
					fieldtype: "Currency",
					read_only: 1,
					default: old_price
				},
				{
					fieldtype: "Column Break",
				},
				{
					label: "New Base Selling Rate",
					fieldname: "new_price",
					fieldtype: "Currency",
					reqd: 1,
					default: new_price
				},
			],
			primary_action: function() {
				var data = dialog.get_values();
				if (!data.new_price) {
					dialog.hide();
					return;
				}

				frappe.call({
					method: "erpnext.stock.report.price_list.price_list.set_item_pl_rate",
					args: {
						effective_date: data.effective_date,
						item_code: item.item_code,
						price_list: '',
						base_price_list: 1,
						price_list_rate: flt(data.new_price)
					},
					callback: function(r) {
						if (!r.exc) {
							item.base_selling_price = flt(data.new_price);
						}
						me.calculate_gross_profit();
						me.frm.refresh_fields();
						dialog.hide();
					}
				});
			},
			primary_action_label: __('Update')
		});
		dialog.show();
	},

	get_base_selling_prices: function() {
		if (this.can_get_gross_profit()) {
			var me = this;
			return frappe.call({
				method: 'set_base_selling_price',
				doc: me.frm.doc,
				callback: function (r) {
					if (!r.exc) {
						me.calculate_taxes_and_totals();
					}
				}
			});
		}
	}
});

// for backward compatibility: combine new and previous states
$.extend(cur_frm.cscript, new erpnext.buying.PurchaseOrderController({frm: cur_frm}));

cur_frm.cscript.update_status= function(label, status){
	frappe.call({
		method: "erpnext.buying.doctype.purchase_order.purchase_order.update_status",
		args: {status: status, name: cur_frm.doc.name},
		callback: function(r) {
			cur_frm.set_value("status", status);
			cur_frm.reload_doc();
		}
	})
}

cur_frm.fields_dict['items'].grid.get_field('project').get_query = function(doc, cdt, cdn) {
	return {
		filters:[
			['Project', 'status', 'not in', 'Completed, Cancelled']
		]
	}
}

cur_frm.fields_dict['items'].grid.get_field('bom').get_query = function(doc, cdt, cdn) {
	var d = locals[cdt][cdn]
	return {
		filters: [
			['BOM', 'item', '=', d.item_code],
			['BOM', 'is_active', '=', '1'],
			['BOM', 'docstatus', '=', '1'],
			['BOM', 'company', '=', doc.company]
		]
	}
}

function set_schedule_date(frm) {
	if(frm.doc.schedule_date){
		erpnext.utils.copy_value_in_all_rows(frm.doc, frm.doc.doctype, frm.doc.name, "items", "schedule_date");
	}
}

frappe.provide("erpnext.buying");

frappe.ui.form.on("Purchase Order", "is_subcontracted", function(frm) {
	if (frm.doc.is_subcontracted === "Yes") {
		erpnext.buying.get_default_bom(frm);
	}
});

frappe.ui.form.on("Purchase Order", "get_customs_exchange_rate", function (frm) {
	var company_currency = frm.cscript.get_company_currency();

	if (!frm.doc.shipping_date) {
		frappe.msgprint(__("Please set Shipping Date first"));
		return;
	}

	if (frm.doc.currency) {
		if (frm.doc.currency == company_currency) {
			frm.set_value("customs_exchange_rate", 1.0);
		} else {
			frappe.call({
				method: "erpnext.buying.doctype.purchase_order.purchase_order.get_customs_exchange_rate",
				args: {'from_currency': frm.doc.currency , 'to_currency': company_currency, 'transaction_date': frm.doc.shipping_date},
				callback: function (r) {
					if (r.message)
						frm.set_value("customs_exchange_rate", r.message);
				}
			});
		}
	}
});

frappe.ui.form.on("Purchase Order", "get_b3_transaction_number", function (frm) {
	frappe.call({
		method: "erpnext.buying.doctype.purchase_order.purchase_order.generate_b3_transaction_no",
		args: {'company': frm.doc.company},
		callback: function (r) {
			if (r.message)
				frm.set_value("b3_transaction_no", r.message);
		}
	});
});

frappe.ui.form.on("Purchase Order", "b3_transaction_no", function (frm) {
	frm.set_value("b3_transaction_no_barcode", frm.fields_dict.b3_transaction_no_barcode.parse(frm.doc.b3_transaction_no));
});