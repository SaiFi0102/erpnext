// Copyright (c) 2015, Frappe Technologies Pvt. Ltd. and Contributors
// License: GNU General Public License v3. See license.txt

{% include 'erpnext/selling/sales_common.js' %}

frappe.ui.form.on("Sales Order", {
	setup: function(frm) {
		frm.custom_make_buttons = {
			'Delivery Note': 'Delivery',
			'Sales Invoice': 'Invoice',
			'Material Request': 'Material Request',
			'Purchase Order': 'Purchase Order',
			'Project': 'Project'
		}
		frm.add_fetch('customer', 'tax_id', 'tax_id');

		// formatter for material request item
		frm.set_indicator_formatter('item_code',
			function(doc) { return (doc.stock_qty<=doc.delivered_qty) ? "green" : "orange" })

		frm.set_query('company_address', function(doc) {
			if(!doc.company) {
				frappe.throw(__('Please set Company'));
			}

			return {
				query: 'frappe.contacts.doctype.address.address.address_query',
				filters: {
					link_doctype: 'Company',
					link_name: doc.company
				}
			};
		})
	},
	refresh: function(frm) {
		// if(frm.doc.docstatus == 1 && frm.doc.status == 'To Deliver and Bill') {
		//	frm.add_custom_button(__('Update Items'), () => {
		//		erpnext.utils.update_child_items({
		//			frm: frm,
		//			child_docname: "items",
		//			child_doctype: "Sales Order Detail",
		//		})
		//	});
		// }
	},

	validate: function(frm) {
		for (var i = frm.fields_dict['items'].grid.grid_rows.length - 1; i >= 0; --i) {
			var grid_row = frm.fields_dict['items'].grid.grid_rows[i];
			if (!grid_row.doc.qty) {
				grid_row.remove();
			}
		}
	},

	onload: function(frm) {
		if (!frm.doc.transaction_date){
			frm.set_value('transaction_date', frappe.datetime.get_today())
		}
		erpnext.queries.setup_queries(frm, "Warehouse", function() {
			return erpnext.queries.warehouse(frm.doc);
		});

		frm.set_query('project', function(doc, cdt, cdn) {
			return {
				query: "erpnext.controllers.queries.get_project_name",
				filters: {
					'customer': doc.customer
				}
			}
		});

		frm.set_query("blanket_order", "items", function() {
			return {
				filters: {
					"company": frm.doc.company,
					"docstatus": 1
				}
			}
		});

		erpnext.queries.setup_warehouse_query(frm);
	},

	delivery_date: function(frm) {
		$.each(frm.doc.items || [], function(i, d) {
			if(!d.delivery_date && d.item_code) d.delivery_date = frm.doc.delivery_date;
		});
		refresh_field("items");
	},

	onload_post_render: function(frm) {
		frm.get_field("items").grid.set_multiple_add("item_code", "qty");

		frm.fields_dict.items.grid.wrapper.on('click', '.grid-row-check', function(e) {
			frm.cscript.show_hide_add_remove_default_items(frm);
		});

		frm.fields_dict.items.grid.add_custom_button("Remove Customer Default", frm.cscript.remove_selected_from_default_items);
		frm.fields_dict.items.grid.add_custom_button("Add Customer Default", frm.cscript.add_selected_to_default_items);
		frm.fields_dict.items.grid.clear_custom_buttons();
	}
});

frappe.ui.form.on("Sales Order Item", {
	item_code: function(frm,cdt,cdn) {
		var row = locals[cdt][cdn];
		if (frm.doc.delivery_date) {
			row.delivery_date = frm.doc.delivery_date;
			refresh_field("delivery_date", cdn, "items");
		} else {
			frm.script_manager.copy_from_first_row("items", row, ["delivery_date"]);
		}
	},
	delivery_date: function(frm, cdt, cdn) {
		if(!frm.doc.delivery_date) {
			erpnext.utils.copy_value_in_all_rows(frm.doc, cdt, cdn, "items", "delivery_date");
		}
	}
});

frappe.ui.form.on("Sales Order", {
	onload: function(frm) {
		var me = frm.cscript;

		frm.cscript.set_po_qty_labels();
		if (me.frm.doc.docstatus == 0) {
			$(me.frm.wrapper).on("grid-row-render", function(e, grid_row) {
				if(grid_row.doc && grid_row.doc.doctype == "Sales Order Item") {
					$(grid_row.wrapper).off('focus', 'input').on('focus', 'input', function() {
						me.selected_item_dn = grid_row.doc.name;
						me.update_selected_item_fields();
					});
				}
			});
		}

		$(".control-value", frm.fields_dict.customer_outstanding_amount.$input_wrapper)
			.wrap("<a href='#' id='customer_outstanding_amount_link' target='_blank'></a>");
	},
	refresh: function(frm) {
		frm.cscript.get_item_custom_projected_qty();
		frm.cscript.customer_outstanding_amount();
	},
	transaction_date: function(frm) {
		frm.cscript.set_po_qty_labels();
		frm.cscript.get_item_custom_projected_qty();
	},

	onload_post_render(frm) {
		frm.cscript.customer_outstanding_amount();
	},

	customer: function (frm) {
		frm.cscript.customer_outstanding_amount();
	}
});

erpnext.selling.SalesOrderController = erpnext.selling.SellingController.extend({
	onload: function(doc, dt, dn) {
		this._super();
	},

	customer_outstanding_amount: function() {
		$("a", this.frm.fields_dict.customer_outstanding_amount.$input_wrapper)
			.attr("href", "desk#query-report/Accounts Receivable/?customer=" + this.frm.doc.customer);

		$("a", this.frm.fields_dict.customer_outstanding_amount.$input_wrapper).css("color",
			this.frm.doc.customer_credit_limit && flt(this.frm.doc.customer_outstanding_amount) >= flt(this.frm.doc.customer_credit_limit) ? "red" : "inherit");
	},

	show_hide_add_remove_default_items: function() {
		var has_checked = this.frm.fields_dict.items.grid.grid_rows.some(row => row.doc.__checked);
		if (has_checked) {
			$(".btn-custom", this.frm.fields_dict.items.grid.grid_buttons).removeClass("hidden");
		} else {
			$(".btn-custom", this.frm.fields_dict.items.grid.grid_buttons).addClass("hidden");
		}
	},
	add_selected_to_default_items: function() {
		var frm = cur_frm;
		var item_codes = frm.fields_dict.items.grid.grid_rows
			.filter(row => row.doc.__checked && row.doc.item_code)
			.map(row => row.doc.item_code);

		if (frm.doc.customer && item_codes.length) {
			return frappe.call({
				method: "erpnext.api.add_item_codes_to_party_default_items",
				args: {
					party_type: "Customer",
					party: frm.doc.customer,
					item_codes: item_codes
				}
			});
		}
	},
	remove_selected_from_default_items: function() {
		var frm = cur_frm;
		var item_codes = frm.fields_dict.items.grid.grid_rows
			.filter(row => row.doc.__checked && row.doc.item_code)
			.map(row => row.doc.item_code);

		if (frm.doc.customer && item_codes.length) {
			return frappe.call({
				method: "erpnext.api.remove_item_codes_from_party_default_items",
				args: {
					party_type: "Customer",
					party: frm.doc.customer,
					item_codes: item_codes
				}
			});
		}
	},

	get_customer_default_items: function() {
		this.get_party_default_items();
	},

	update_selected_item_fields: function() {
		if (this.frm.doc.docstatus == 0) {
			var me = this;

			var grid_row = this.selected_item_dn ? this.frm.fields_dict['items'].grid.grid_rows_by_docname[this.selected_item_dn] : null;
			if(grid_row && grid_row.doc.item_code) {
				me.frm.doc.current_actual_qty = grid_row.doc.actual_qty / grid_row.doc.conversion_factor;
				me.frm.refresh_field("current_actual_qty");
				me.frm.doc.current_projected_qty = grid_row.doc.projected_qty / grid_row.doc.conversion_factor;
				me.frm.refresh_field("current_projected_qty");
				for(var i = 1; i <= 5; ++i) {
					me.frm.doc["po_day_" + i] = grid_row.doc["po_day_" + i] / grid_row.doc.conversion_factor;
					me.frm.refresh_field("po_day_" + i);
					me.frm.doc["so_day_" + i] = grid_row.doc["so_day_" + i] / grid_row.doc.conversion_factor;
					me.frm.refresh_field("so_day_" + i);
				}
			} else {
				me.frm.doc.current_actual_qty = 0;
				me.frm.refresh_field("current_actual_qty");
				me.frm.doc.current_projected_qty = 0;
				me.frm.refresh_field("current_projected_qty");
				for(var i = 1; i <= 5; ++i) {
					me.frm.doc["po_day_" + i] = 0;
					me.frm.refresh_field("po_day_" + i);
					me.frm.doc["so_day_" + i] = 0;
					me.frm.refresh_field("so_day_" + i);
				}
			}
		}
	},

	conversion_factor: function(doc, cdt, cdn, dont_fetch_price_list_rate) {
		this._super(doc, cdt, cdn, dont_fetch_price_list_rate);
		this.update_selected_item_fields();
	},

	set_po_qty_labels: function() {
		for (var i = 0; i < 5; ++i) {
			var date = new frappe.datetime.datetime(frappe.datetime.add_days(this.frm.doc.transaction_date, i));
			var day = date.format("ddd");
			this.frm.fields_dict["po_day_"+(i+1)].set_label("PO " + day);
			this.frm.fields_dict["so_day_"+(i+1)].set_label("SO " + day);
		}
	},

	set_item_custom_projected_qty: function(item, data) {
		item['actual_qty'] = data['actual_qty'];
		item['projected_qty'] = data['projected_qty'];
		for(var i = 0; i < 5; ++i) {
			item['po_day_' + (i + 1)] = data['po_day_' + (i + 1)];
			item['so_day_' + (i + 1)] = data['so_day_' + (i + 1)];
		}
	},

	get_item_custom_projected_qty: function() {
		var me = this;
		if (me.frm.doc.docstatus == 0) {
			var item_codes = [];
			$.each(this.frm.doc.items || [], function(i, item) {
				if(item.item_code) {
					item_codes.push(item.item_code);
				}
			});

			if(item_codes.length) {
				return this.frm.call({
					method: "erpnext.api.get_item_custom_projected_qty",
					args: {
						date: me.frm.doc.transaction_date,
						item_codes: item_codes,
						exclude_so: me.frm.doc.name
					},
					callback: function(r) {
						if(!r.exc) {
							$.each(me.frm.doc.items || [], function(i, item) {
								if(item.item_code && r.message.hasOwnProperty(item.item_code)) {
									me.set_item_custom_projected_qty(item, r.message[item.item_code]);
								} else {
									item['actual_qty'] = 0;
									item['projected_qty'] = 0;
									for(var i = 0; i < 5; ++i) {
										item['po_day_' + (i + 1)] = 0;
										item['so_day_' + (i + 1)] = 0;
									}
								}
							});

							me.update_selected_item_fields();
						}
					}
				});
			}
		}
	},

	refresh: function(doc, dt, dn) {
		var me = this;
		this._super();
		var allow_purchase = false;
		var allow_delivery = false;

		if(doc.docstatus==1) {
			if(doc.status != 'Closed') {

				for (var i in this.frm.doc.items) {
					var item = this.frm.doc.items[i];
					if(item.delivered_by_supplier === 1 || item.supplier){
						if(item.qty > flt(item.ordered_qty)
							&& item.qty > flt(item.delivered_qty)) {
							allow_purchase = true;
						}
					}

					if (item.delivered_by_supplier===0) {
						if(item.qty > flt(item.delivered_qty)) {
							allow_delivery = true;
						}
					}

					if (allow_delivery && allow_purchase) {
						break;
					}
				}

				if (this.frm.has_perm("submit")) {
					// close
					if(flt(doc.per_delivered, 6) < 100 || flt(doc.per_completed, 6) < 100) {
						this.frm.add_custom_button(__('Close'),
							function() { me.close_sales_order() }, __("Status"))
					}
				}

				// delivery note
				if(flt(doc.per_delivered, 6) < 100 && ["Sales", "Shopping Cart"].indexOf(doc.order_type)!==-1 && allow_delivery) {
					this.frm.add_custom_button(__('Delivery'),
						function() { me.make_delivery_note_based_on_delivery_date(); }, __("Make"));
					this.frm.add_custom_button(__('Work Order'),
						function() { me.make_work_order() }, __("Make"));

					this.frm.page.set_inner_btn_group_as_primary(__("Make"));
				}

				// sales invoice
				if(flt(doc.per_completed, 6) < 100) {
					this.frm.add_custom_button(__('Invoice'),
						function() { me.make_sales_invoice() }, __("Make"));

					this.frm.add_custom_button(__('Make Invoice'),
						function() { me.make_sales_invoice() });
				}

				// material request
				if(!doc.order_type || ["Sales", "Shopping Cart"].indexOf(doc.order_type)!==-1
					&& flt(doc.per_delivered, 6) < 100) {
					this.frm.add_custom_button(__('Material Request'),
						function() { me.make_material_request() }, __("Make"));
					this.frm.add_custom_button(__('Request for Raw Materials'),
						function() { me.make_raw_material_request() }, __("Make"));
				}

				// make purchase order
				if(flt(doc.per_delivered, 6) < 100 && allow_purchase) {
					this.frm.add_custom_button(__('Purchase Order'),
						function() { me.make_purchase_order() }, __("Make"));
				}

				// payment request
				if(flt(doc.per_billed)==0 && flt(doc.per_completed, 2) < 100) {
					this.frm.add_custom_button(__('Payment Request'),
						function() { me.make_payment_request() }, __("Make"));
					this.frm.add_custom_button(__('Payment'),
						function() { me.make_payment_entry() }, __("Make"));
				}

				// maintenance
				if(flt(doc.per_delivered, 2) < 100 &&
						["Sales", "Shopping Cart"].indexOf(doc.order_type)===-1) {
					this.frm.add_custom_button(__('Maintenance Visit'),
						function() { me.make_maintenance_visit() }, __("Make"));
					this.frm.add_custom_button(__('Maintenance Schedule'),
						function() { me.make_maintenance_schedule() }, __("Make"));
				}

				// project
				if(flt(doc.per_delivered, 2) < 100 && ["Sales", "Shopping Cart"].indexOf(doc.order_type)!==-1 && allow_delivery) {
						this.frm.add_custom_button(__('Project'),
							function() { me.make_project() }, __("Make"));
				}

				if(!doc.auto_repeat) {
					this.frm.add_custom_button(__('Subscription'), function() {
						erpnext.utils.make_subscription(doc.doctype, doc.name)
					}, __("Make"))
				}

			} else {
				if (this.frm.has_perm("submit")) {
					// un-close
					this.frm.add_custom_button(__('Re-open'), function() {
						me.frm.cscript.update_status('Re-open', 'Draft')
					}, __("Status"));
				}
			}
		}

		if (this.frm.doc.docstatus===0) {
			this.frm.add_custom_button(__('Quotation'),
				function() {
					erpnext.utils.map_current_doc({
						method: "erpnext.selling.doctype.quotation.quotation.make_sales_order",
						source_doctype: "Quotation",
						target: me.frm,
						setters: {
							customer: me.frm.doc.customer || undefined
						},
						get_query_filters: {
							company: me.frm.doc.company,
							docstatus: 1,
							status: ["!=", "Lost"],
						}
					})
				}, __("Get items from"));
		}

		if(me.frm.doc.status=="To Deliver and Bill" || me.frm.doc.status=="To Bill") {
			me.frm.add_custom_button(__('Make New Sales Order For Balance Qty'), function() {
				frappe.call({
					method:'erpnext.sales_confirm.makeSOFromSo',
					args:{'name':me.frm.doc.name},
					freeze:true,
					freeze_message:'Please Wait....',
					callback:function(r){
						var msg='New Order Created :' + r.message;
						show_alert(msg,3);
						frappe.set_route("Form", "Sales Order", r.message);
					}
				})
			})
		}

		this.order_type(doc);
	},

	make_work_order() {
		var me = this;
		this.frm.call({
			doc: this.frm.doc,
			method: 'get_work_order_items',
			callback: function(r) {
				if(!r.message) {
					frappe.msgprint({
						title: __('Work Order not created'),
						message: __('No Items with Bill of Materials to Manufacture'),
						indicator: 'orange'
					});
					return;
				}
				else if(!r.message) {
					frappe.msgprint({
						title: __('Work Order not created'),
						message: __('Work Order already created for all items with BOM'),
						indicator: 'orange'
					});
					return;
				} else {
					var fields = [
						{fieldtype:'Table', fieldname: 'items',
							description: __('Select BOM and Qty for Production'),
							fields: [
								{fieldtype:'Read Only', fieldname:'item_code',
									label: __('Item Code'), in_list_view:1},
								{fieldtype:'Link', fieldname:'bom', options: 'BOM', reqd: 1,
									label: __('Select BOM'), in_list_view:1, get_query: function(doc) {
										return {filters: {item: doc.item_code}};
									}},
								{fieldtype:'Float', fieldname:'pending_qty', reqd: 1,
									label: __('Qty'), in_list_view:1},
								{fieldtype:'Data', fieldname:'sales_order_item', reqd: 1,
									label: __('Sales Order Item'), hidden:1}
							],
							data: r.message,
							get_data: function() {
								return r.message
							}
						}
					]
					var d = new frappe.ui.Dialog({
						title: __('Select Items to Manufacture'),
						fields: fields,
						primary_action: function() {
							var data = d.get_values();
							me.frm.call({
								method: 'make_work_orders',
								args: {
									items: data,
									company: me.frm.doc.company,
									sales_order: me.frm.docname,
									project: me.frm.project
								},
								freeze: true,
								callback: function(r) {
									if(r.message) {
										frappe.msgprint({
											message: __('Work Orders Created: {0}',
												[r.message.map(function(d) {
													return repl('<a href="#Form/Work Order/%(name)s">%(name)s</a>', {name:d})
												}).join(', ')]),
											indicator: 'green'
										})
									}
									d.hide();
								}
							});
						},
						primary_action_label: __('Make')
					});
					d.show();
				}
			}
		});
	},

	order_type: function() {
		//this.frm.fields_dict.items.grid.toggle_reqd("delivery_date", this.frm.doc.order_type == "Sales");
	},

	tc_name: function() {
		this.get_terms();
	},

	make_material_request: function() {
		frappe.model.open_mapped_doc({
			method: "erpnext.selling.doctype.sales_order.sales_order.make_material_request",
			frm: this.frm
		})
	},

	make_raw_material_request: function() {
		var me = this;
		this.frm.call({
			doc: this.frm.doc,
			method: 'get_work_order_items',
			args: {
				for_raw_material_request: 1
			},
			callback: function(r) {
				if(!r.message) {
					frappe.msgprint({
						message: __('No Items with Bill of Materials.'),
						indicator: 'orange'
					});
					return;
				}
				else {
					me.make_raw_material_request_dialog(r);
				}
			}
		});
	},

	make_raw_material_request_dialog: function(r) {
		var fields = [
			{fieldtype:'Check', fieldname:'include_exploded_items',
				label: __('Include Exploded Items')},
			{fieldtype:'Check', fieldname:'ignore_existing_ordered_qty',
				label: __('Ignore Existing Ordered Qty')},
			{
				fieldtype:'Table', fieldname: 'items',
				description: __('Select BOM, Qty and For Warehouse'),
				fields: [
					{fieldtype:'Read Only', fieldname:'item_code',
						label: __('Item Code'), in_list_view:1},
					{fieldtype:'Link', fieldname:'bom', options: 'BOM', reqd: 1,
						label: __('BOM'), in_list_view:1, get_query: function(doc) {
							return {filters: {item: doc.item_code}};
						}
					},
					{fieldtype:'Float', fieldname:'required_qty', reqd: 1,
						label: __('Qty'), in_list_view:1},
					{fieldtype:'Link', fieldname:'for_warehouse', options: 'Warehouse',
						label: __('For Warehouse')}
				],
				data: r.message,
				get_data: function() {
					return r.message
				}
			}
		]
		var d = new frappe.ui.Dialog({
			title: __("Items for Raw Material Request"),
			fields: fields,
			primary_action: function() {
				var data = d.get_values();
				me.frm.call({
					method: 'erpnext.selling.doctype.sales_order.sales_order.make_raw_material_request',
					args: {
						items: data,
						company: me.frm.doc.company,
						sales_order: me.frm.docname,
						project: me.frm.project
					},
					freeze: true,
					callback: function(r) {
						if(r.message) {
							frappe.msgprint(__('Material Request {0} submitted.',
							['<a href="#Form/Material Request/'+r.message.name+'">' + r.message.name+ '</a>']));
						}
						d.hide();
						me.frm.reload_doc();
					}
				});
			},
			primary_action_label: __('Make')
		});
		d.show();
	},

	make_delivery_note_based_on_delivery_date: function() {
		var me = this;

		var delivery_dates = [];
		$.each(this.frm.doc.items || [], function(i, d) {
			if(!delivery_dates.includes(d.delivery_date)) {
				delivery_dates.push(d.delivery_date);
			}
		});

		var item_grid = this.frm.fields_dict["items"].grid;
		if(!item_grid.get_selected().length && delivery_dates.length > 1) {
			var dialog = new frappe.ui.Dialog({
				title: __("Select Items based on Delivery Date"),
				fields: [{fieldtype: "HTML", fieldname: "dates_html"}]
			});

			var html = $(`
				<div style="border: 1px solid #d1d8dd">
					<div class="list-item list-item--head">
						<div class="list-item__content list-item__content--flex-2">
							${__('Delivery Date')}
						</div>
					</div>
					${delivery_dates.map(date => `
						<div class="list-item">
							<div class="list-item__content list-item__content--flex-2">
								<label>
								<input type="checkbox" data-date="${date}" checked="checked"/>
								${frappe.datetime.str_to_user(date)}
								</label>
							</div>
						</div>
					`).join("")}
				</div>
			`);

			var wrapper = dialog.fields_dict.dates_html.$wrapper;
			wrapper.html(html);

			dialog.set_primary_action(__("Select"), function() {
				var dates = wrapper.find('input[type=checkbox]:checked')
					.map((i, el) => $(el).attr('data-date')).toArray();

				if(!dates) return;

				$.each(dates, function(i, d) {
					$.each(item_grid.grid_rows || [], function(j, row) {
						if(row.doc.delivery_date == d) {
							row.doc.__checked = 1;
						}
					});
				})
				me.make_delivery_note();
				dialog.hide();
			});
			dialog.show();
		} else {
			this.make_delivery_note();
		}
	},

	make_delivery_note: function() {
		frappe.model.open_mapped_doc({
			method: "erpnext.selling.doctype.sales_order.sales_order.make_delivery_note",
			frm: me.frm
		})
	},

	make_sales_invoice: function() {
		frappe.model.open_mapped_doc({
			method: "erpnext.selling.doctype.sales_order.sales_order.make_sales_invoice",
			frm: this.frm
		})
	},

	make_maintenance_schedule: function() {
		frappe.model.open_mapped_doc({
			method: "erpnext.selling.doctype.sales_order.sales_order.make_maintenance_schedule",
			frm: this.frm
		})
	},

	make_project: function() {
		frappe.model.open_mapped_doc({
			method: "erpnext.selling.doctype.sales_order.sales_order.make_project",
			frm: this.frm
		})
	},

	make_maintenance_visit: function() {
		frappe.model.open_mapped_doc({
			method: "erpnext.selling.doctype.sales_order.sales_order.make_maintenance_visit",
			frm: this.frm
		})
	},

	make_purchase_order: function(){
		var me = this;
		var dialog = new frappe.ui.Dialog({
			title: __("For Supplier"),
			fields: [
				{"fieldtype": "Link", "label": __("Supplier"), "fieldname": "supplier", "options":"Supplier",
				 "description": __("Leave the field empty to make purchase orders for all suppliers"),
					"get_query": function () {
						return {
							query:"erpnext.selling.doctype.sales_order.sales_order.get_supplier",
							filters: {'parent': me.frm.doc.name}
						}
					}},

				{"fieldtype": "Button", "label": __("Make Purchase Order"), "fieldname": "make_purchase_order", "cssClass": "btn-primary"},
			]
		});

		dialog.fields_dict.make_purchase_order.$input.click(function() {
			var args = dialog.get_values();
			dialog.hide();
			return frappe.call({
				type: "GET",
				method: "erpnext.selling.doctype.sales_order.sales_order.make_purchase_order_for_drop_shipment",
				args: {
					"source_name": me.frm.doc.name,
					"for_supplier": args.supplier
				},
				freeze: true,
				callback: function(r) {
					if(!r.exc) {
						// var args = dialog.get_values();
						if (args.supplier){
							var doc = frappe.model.sync(r.message);
							frappe.set_route("Form", r.message.doctype, r.message.name);
						}
						else{
							frappe.route_options = {
								"sales_order": me.frm.doc.name
							}
							frappe.set_route("List", "Purchase Order");
						}
					}
				}
			})
		});
		dialog.show();
	},
	close_sales_order: function(){
		this.frm.cscript.update_status("Close", "Closed")
	},
	update_status: function(label, status){
		var doc = this.frm.doc;
		var me = this;
		frappe.ui.form.is_saving = true;
		frappe.call({
			method: "erpnext.selling.doctype.sales_order.sales_order.update_status",
			args: {status: status, name: doc.name},
			callback: function(r){
				me.frm.reload_doc();
			},
			always: function() {
				frappe.ui.form.is_saving = false;
			}
		});
	}
});
$.extend(cur_frm.cscript, new erpnext.selling.SalesOrderController({frm: cur_frm}));
