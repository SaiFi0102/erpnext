// Copyright (c) 2015, Frappe Technologies Pvt. Ltd. and Contributors
// License: GNU General Public License v3. See license.txt


cur_frm.cscript.tax_table = "Sales Taxes and Charges";
{% include 'erpnext/accounts/doctype/sales_taxes_and_charges_template/sales_taxes_and_charges_template.js' %}


cur_frm.email_field = "contact_email";

frappe.provide("erpnext.selling");
erpnext.selling.SellingController = erpnext.TransactionController.extend({
	item_sales_gross_profit_fields: ["valuation_rate", "base_returned_amount", "cogs_per_unit", "cogs", "gross_profit", "gross_profit_per_unit", "per_gross_profit"],

	setup: function() {
		this._super();
		this.frm.add_fetch("sales_partner", "commission_rate", "commission_rate");
		this.frm.add_fetch("sales_person", "commission_rate", "commission_rate");

		var me = this;
		frappe.ui.form.on(this.frm.doctype + " Item", "rate", function(frm, cdt, cdn) {
			me.validate_price_change(cdt, cdn);
		});
		frappe.ui.form.on(this.frm.doctype + " Item", "price_list_rate", function(frm, cdt, cdn) {
			me.validate_price_change(cdt, cdn);
		});
		frappe.ui.form.on(this.frm.doctype + " Item", "items_remove", function(frm, cdt, cdn) {
			me.set_price_override_authorization();
		});
	},

	onload: function() {
		this._super();
		this.setup_queries();
		this.frm.set_query('shipping_rule', function() {
			return {
				filters: {
					"shipping_rule_type": "Selling"
				}
			};
		});

		var me = this;
		me.frm.fields_dict.items.grid.wrapper.off('change', 'input[data-fieldname="rate"]').on('change', 'input[data-fieldname="rate"]', function(e) {
			var cdn = $(e.target).closest(".grid-row").attr("data-name");
			if (cdn) {
				var item = frappe.get_doc(me.frm.doc.doctype + " Item", cdn);
				me.show_edit_pricing_rule_dialog(item);
			}
		});
	},

	show_edit_pricing_rule_dialog: function(item) {
		var me = this;

		if (!me.frm.doc.__onload || !me.frm.doc.__onload.force_set_selling_item_prices) {
			return;
		}

		if (!item || !item.item_code || !me.frm.doc.customer || !me.frm.doc.selling_price_list || me.frm.doc.ignore_pricing_rule || item.override_price_list_rate) {
			return;
		}

		let current_pricing_rule = cstr(item.pricing_rules).split(`
`)[0];

		var dialog = new frappe.ui.Dialog({
			title: __("Set Special Price"),
			fields: [
				{"fieldtype": "Link", "label": __("Item Code"), "fieldname": "item_code", "options": "Item", "read_only":true, "default": item.item_code},
				{"fieldtype": "Column Break", "fieldname": "col_break1"},
				{"fieldtype": "Link", "label": __("Item Name"), "fieldname": "item_name", "read_only":true, "default": item.item_name},
				{"fieldtype": "Section Break", "fieldname": "sec_break1"},
				{"fieldtype": "Date", "label": __("From Date"), "fieldname": "valid_from", "reqd":true, "default": me.frm.doc.pricing_rule ? "" : me.frm.doc.delivery_date},
				{"fieldtype": "Column Break", "fieldname": "col_break1"},
				{"fieldtype": "Date", "label": __("To Date"), "fieldname": "valid_upto", "reqd":true, "default": me.frm.doc.pricing_rule ? "" : me.frm.doc.delivery_date},
				{"fieldtype": "Section Break", "fieldname": "sec_break1"},
				{"fieldtype": "Button", "label": __("Ignore Pricing Rule"), "fieldname": "ignore_pricing_rule"},
				{"fieldtype": "Link", "label": __("Existing Pricing Rule"), "fieldname": "pricing_rule", "options": "Pricing Rule", "read_only":true, "default": current_pricing_rule},
				{"fieldtype": "Check", "label": __("Create New Pricing Rule"), "fieldname": "create_new", "depends_on":"pricing_rule"},
				{"fieldtype": "Column Break", "fieldname": "col_break1"},
				{"fieldtype": "Currency", "label": __("New Rate (As Per Selected UOM)"), "fieldname": "new_uom_rate", "read_only":true, "default": item.rate},
				{"fieldtype": "Currency", "label": __("New Rate"), "fieldname": "new_rate", "reqd":true, "default": flt(item.rate/item.conversion_factor, precision('rate', item))},
				{"fieldtype": "Select", "label": __("Reason"), "fieldname": "reason", "options": `In-Store Promo
Bad Quality
Customer Request`}
			],
			static: true
		});
		dialog.get_close_btn().show();

		dialog.fields_dict.ignore_pricing_rule.input.onclick = function() {
			frappe.model.set_value(item.doctype, item.name, "override_price_list_rate", 1);
			dialog.cancel();
		};

		if (current_pricing_rule) {
			frappe.call({
				method: 'frappe.client.get_value',
				args: {
					doctype: 'Pricing Rule',
					filters: { name: current_pricing_rule },
					fieldname:['valid_from','valid_upto', 'reason']
				},
				callback: function(res) {
					if (!res.exc) {
						$.each(res.message, function(k, v) {
							dialog.set_value(k, v);
						});
					}
				}

			});
		}

		dialog.set_primary_action(__('Update Special Price'), () => {
			var args = Object.assign({}, this._get_args(item), dialog.get_values());
			args.create_new = cint(args.create_new);

			dialog.hide();
			return frappe.call({
				method: "erpnext.accounts.doctype.pricing_rule.utils.update_special_price",
				args: {
					args: args
				},
				freeze: true,
				callback: function(r) {
					me.apply_price_list(item);
				}
			})
		});

		dialog.set_secondary_action(() => {
			if (!item.override_price_list_rate) me.apply_price_list(item)
		});

		dialog.show();
	},

	override_price_list_rate: function(doc, cdt, cdn) {
		var item = frappe.get_doc(cdt, cdn);
		if (item.override_price_list_rate) {
			frappe.model.set_value(item.doctype, item.name, "pricing_rules", "");
		} else {
			this.apply_price_list(item);
		}
		this.set_item_warning_color(item);
	},

	get_customer_default_items: function() {
		this.get_party_default_items();
	},

	set_item_warning_color: function(item) {
		if (item) {
			var color = 'inherit';
			var background = 'inherit';

			if (item.requires_authorization || (item.item_code && !item.rate) || item.override_price_list_rate || item.pricing_rules) {
				color = 'red';
			}
			if (item.item_code && !item.rate) {
				background = '#f8c3d7';
			}

			$("input, .static-area, a, .col", $("[data-fieldname='items'] .grid-row[data-idx="+item.idx+"]")).css({
				'color': color,
				'background-color': background
			});
		}
	},

	requires_authorization: function(doc, cdt, cdn) {
		this.set_item_warning_color(frappe.get_doc(cdt, cdn));
	},

	update_selected_item_fields: function() {
		this.update_selected_item_select_batch_button();
		this.update_selected_item_gross_profit();
	},

	update_selected_item_gross_profit: function() {
		var me = this;
		var grid_row = this.selected_item_dn ? this.frm.fields_dict['items'].grid.grid_rows_by_docname[this.selected_item_dn] : null;

		var all_fields = [];
		all_fields.push(...this.item_sales_gross_profit_fields);

		if(grid_row && (grid_row.doc.batch_no || grid_row.doc.item_code) && !me.frm.doc.is_return) {
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

	update_selected_item_select_batch_button() {
		var me = this;
		var grid_row = this.selected_item_dn ? this.frm.fields_dict['items'].grid.grid_rows_by_docname[this.selected_item_dn] : null;

		var show_select_batch = me.frm.doc.docstatus === 0 && !me.frm.doc.is_return && grid_row && grid_row.doc.has_batch_no
			&& (me.frm.doc.doctype === 'Delivery Note' || (me.frm.doc.doctype === 'Sales Invoice' && me.frm.doc.update_stock));

		me.toggle_select_batch_button(show_select_batch);
	},

	setup_queries: function() {
		var me = this;

		this.frm.set_query('shipping_rule', function() {
			return {
				filters: {
					"shipping_rule_type": "Selling"
				}
			};
		});

		this.frm.set_query("driver", function() {
			return {
				filters: {
					"is_delivery": 1
				}
			};
		});
		this.frm.set_query("packed_by", function() {
			return {
				filters: {
					"is_packing": 1
				}
			};
		});

		$.each([["customer", "customer"],
			["lead", "lead"]],
			function(i, opts) {
				if(me.frm.fields_dict[opts[0]])
					me.frm.set_query(opts[0], erpnext.queries[opts[1]]);
			});

		me.frm.set_query('contact_person', erpnext.queries.contact_query);
		me.frm.set_query('customer_address', erpnext.queries.address_query);
		me.frm.set_query('shipping_address_name', erpnext.queries.address_query);

		if(this.frm.fields_dict.taxes_and_charges) {
			this.frm.set_query("taxes_and_charges", function() {
				return {
					filters: [
						['Sales Taxes and Charges Template', 'company', '=', me.frm.doc.company],
						['Sales Taxes and Charges Template', 'docstatus', '!=', 2]
					]
				}
			});
		}

		if(this.frm.fields_dict.selling_price_list) {
			this.frm.set_query("selling_price_list", function() {
				return { filters: { selling: 1 } };
			});
		}

		if(this.frm.fields_dict.tc_name) {
			this.frm.set_query("tc_name", function() {
				return { filters: { selling: 1 } };
			});
		}

		if(!this.frm.fields_dict["items"]) {
			return;
		}

		if(this.frm.fields_dict["items"].grid.get_field('item_code')) {
			this.frm.set_query("item_code", "items", function() {
				return {
					query: "erpnext.controllers.queries.item_query",
					filters: {'is_sales_item': 1}
				}
			});
		}

		if(this.frm.fields_dict["packed_items"] &&
			this.frm.fields_dict["packed_items"].grid.get_field('batch_no')) {
			this.frm.set_query("batch_no", "packed_items", function(doc, cdt, cdn) {
				return me.set_query_for_batch(doc, cdt, cdn)
			});
		}

		if(this.frm.fields_dict["items"].grid.get_field('item_code')) {
			this.frm.set_query("item_tax_template", "items", function(doc, cdt, cdn) {
				return me.set_query_for_item_tax_template(doc, cdt, cdn)
			});
		}

	},

	refresh: function() {
		this._super();

		frappe.dynamic_link = {doc: this.frm.doc, fieldname: 'customer', doctype: 'Customer'}

		this.frm.toggle_display("customer_name",
			(this.frm.doc.customer_name && this.frm.doc.customer_name!==this.frm.doc.customer));
		if(this.frm.fields_dict.packed_items) {
			var packing_list_exists = (this.frm.doc.packed_items || []).length;
			this.frm.toggle_display("packing_list", packing_list_exists ? true : false);
		}

		var me =this;
		$.each(me.frm.doc.items || [], function (i, item) {
			me.set_item_warning_color(item);
		});

		if (me.frm.doc.docstatus == 0) {
			this.frm.fields_dict.items.grid.add_custom_button(__("Select Batches"), function() {
				if (me.selected_item_dn) {
					me.set_batch_number(me.frm.doc.doctype + " Item", me.selected_item_dn, true);
				}
			});
			this.frm.fields_dict.items.grid.custom_buttons[__("Select Batches")].addClass('hidden');
		}
	},

	customer: function() {
		var me = this;
		erpnext.utils.get_party_details(this.frm, null, null, function() {
			me.apply_price_list();
		});
	},

	customer_address: function() {
		erpnext.utils.get_address_display(this.frm, "customer_address");
		erpnext.utils.set_taxes_from_address(this.frm, "customer_address", "customer_address", "shipping_address_name");
	},

	shipping_address_name: function() {
		erpnext.utils.get_address_display(this.frm, "shipping_address_name", "shipping_address");
		erpnext.utils.set_taxes_from_address(this.frm, "shipping_address_name", "customer_address", "shipping_address_name");
	},

	sales_partner: function() {
		this.apply_pricing_rule();
	},

	campaign: function() {
		this.apply_pricing_rule();
	},

	selling_price_list: function() {
		this.apply_price_list();
		this.set_dynamic_labels();
	},

	price_list_rate: function(doc, cdt, cdn) {
		var item = frappe.get_doc(cdt, cdn);
		frappe.model.round_floats_in(item, ["price_list_rate", "discount_percentage"]);

		// check if child doctype is Sales Order Item/Qutation Item and calculate the rate
		if(in_list(["Quotation Item", "Sales Order Item", "Delivery Note Item", "Sales Invoice Item"]), cdt)
			this.apply_pricing_rule_on_item(item);
		else
			item.rate = flt(item.price_list_rate * (1 - item.discount_percentage / 100.0),
				precision("rate", item));

		if (cur_frm.cscript.set_item_warning_color) {
			cur_frm.cscript.set_item_warning_color(item);
		}
		this.calculate_taxes_and_totals();
	},

	validate_price_change: function(cdt, cdn) {
		if (this.frm.updating_item_details) {
			return;
		}

		var me = this;
		var item = frappe.get_doc(cdt, cdn);
		return this.frm.call({
			method: "erpnext.stock.get_item_details.validate_price_change",
			args: {
				item_code: item.item_code,
				price_list_rate: item.price_list_rate,
				rate: item.rate
			},
			callback: function(r){
				if (!r.exc) {
					frappe.model.set_value(item.doctype, item.name, 'requires_authorization', cint(r.message));
					me.set_price_override_authorization();
				}
			}
		});
	},

	set_price_override_authorization: function() {
		var me = this;

		if (this.frm.doc.authorize !== "Approved") {
			var required = false;
			$.each(me.frm.doc.items || [], function (i, d) {
				if (cint(d.requires_authorization)) {
					required = true;
				}
			});

			this.frm.doc.authorize = required ? "Required" : "Not Required";
			refresh_field('authorize');
		}
	},

	discount_percentage: function(doc, cdt, cdn) {
		var item = frappe.get_doc(cdt, cdn);
		item.discount_amount = 0.0;
		this.apply_discount_on_item(doc, cdt, cdn, 'discount_percentage');
	},

	discount_amount: function(doc, cdt, cdn) {

		if(doc.name === cdn) {
			return;
		}

		var item = frappe.get_doc(cdt, cdn);
		item.discount_percentage = 0.0;
		this.apply_discount_on_item(doc, cdt, cdn, 'discount_amount');
	},

	apply_discount_on_item: function(doc, cdt, cdn, field) {
		var item = frappe.get_doc(cdt, cdn);
		if(!item.price_list_rate) {
			item[field] = 0.0;
		} else {
			this.price_list_rate(doc, cdt, cdn);
		}
		this.set_gross_profit(item);
	},

	commission_rate: function() {
		this.calculate_commission();
		refresh_field("total_commission");
	},

	total_commission: function() {
		if(this.frm.doc.base_net_total) {
			frappe.model.round_floats_in(this.frm.doc, ["base_net_total", "total_commission"]);

			if(this.frm.doc.base_net_total < this.frm.doc.total_commission) {
				var msg = (__("[Error]") + " " +
					__(frappe.meta.get_label(this.frm.doc.doctype, "total_commission",
						this.frm.doc.name)) + " > " +
					__(frappe.meta.get_label(this.frm.doc.doctype, "base_net_total", this.frm.doc.name)));
				frappe.msgprint(msg);
				throw msg;
			}

			this.frm.set_value("commission_rate",
				flt(this.frm.doc.total_commission * 100.0 / this.frm.doc.base_net_total));
		}
	},

	allocated_percentage: function(doc, cdt, cdn) {
		var sales_person = frappe.get_doc(cdt, cdn);
		if(sales_person.allocated_percentage) {

			sales_person.allocated_percentage = flt(sales_person.allocated_percentage,
				precision("allocated_percentage", sales_person));

			sales_person.allocated_amount = flt(this.frm.doc.base_net_total *
				sales_person.allocated_percentage / 100.0,
				precision("allocated_amount", sales_person));
				refresh_field(["allocated_amount"], sales_person);

			this.calculate_incentive(sales_person);
			refresh_field(["allocated_percentage", "allocated_amount", "commission_rate","incentives"], sales_person.name,
				sales_person.parentfield);
		}
	},

	sales_person: function(doc, cdt, cdn) {
		var row = frappe.get_doc(cdt, cdn);
		this.calculate_incentive(row);
		refresh_field("incentives",row.name,row.parentfield);
	},

	warehouse: function(doc, cdt, cdn) {
		var me = this;
		var item = frappe.get_doc(cdt, cdn);

		let serial_no_count = item.serial_no
			? item.serial_no.split(`\n`).filter(d => d).length : 0;

		if (item.serial_no && item.qty === serial_no_count) {
			return;
		}

		if (item.serial_no && !item.batch_no) {
			item.serial_no = null;
		}

		var has_batch_no;
		frappe.db.get_value('Item', {'item_code': item.item_code}, 'has_batch_no', (r) => {
			has_batch_no = r && r.has_batch_no;
			if(item.item_code && item.warehouse) {
				return this.frm.call({
					method: "erpnext.stock.get_item_details.get_bin_details_and_serial_nos",
					child: item,
					args: {
						item_code: item.item_code,
						warehouse: item.warehouse,
						has_batch_no: has_batch_no || 0,
						stock_qty: item.stock_qty,
						serial_no: item.serial_no || "",
					},
					callback:function(r){
						if (in_list(['Delivery Note', 'Sales Invoice'], doc.doctype)) {

							if (doc.doctype === 'Sales Invoice' && (!doc.update_stock)) return;

							me.set_batch_number(cdt, cdn);
							me.batch_no(doc, cdt, cdn);
						}
					}
				});
			}
		})
	},

	calculate_commission: function() {
		if(this.frm.fields_dict.commission_rate) {
			if(this.frm.doc.commission_rate > 100) {
				var msg = __(frappe.meta.get_label(this.frm.doc.doctype, "commission_rate", this.frm.doc.name)) +
					" " + __("cannot be greater than 100");
				frappe.msgprint(msg);
				throw msg;
			}

			this.frm.doc.total_commission = flt(this.frm.doc.base_net_total * this.frm.doc.commission_rate / 100.0,
				precision("total_commission"));
		}
	},

	calculate_contribution: function() {
		var me = this;
		$.each(this.frm.doc.doctype.sales_team || [], function(i, sales_person) {
			frappe.model.round_floats_in(sales_person);
			if(sales_person.allocated_percentage) {
				sales_person.allocated_amount = flt(
					me.frm.doc.base_net_total * sales_person.allocated_percentage / 100.0,
					precision("allocated_amount", sales_person));
			}
		});
	},

	calculate_incentive: function(row) {
		if(row.allocated_amount)
		{
			row.incentives = flt(
					row.allocated_amount * row.commission_rate / 100.0,
					precision("incentives", row));
		}
	},

	get_valuation_rate: function(item_doc) {
		var me = this;
		if (item_doc && me.can_get_gross_profit()) {
			var args = me._get_args(item_doc);
			args = Object.assign(args, args.items[0]);
			delete args['items'];

			frappe.call({
				method: "erpnext.stock.get_item_details.get_valuation_rate",
				args: {
					args
				},
				callback: function(r) {
					if(r.message) {
						item_doc.valuation_rate = flt(r.message.valuation_rate);
						me.calculate_gross_profit();
						me.frm.refresh_fields();
					}
				}
			});
		}
	},

	batch_no: function(doc, cdt, cdn) {
		var item = frappe.get_doc(cdt, cdn);

		this.get_valuation_rate(item);

		item.serial_no = null;
		var has_serial_no;
		frappe.db.get_value('Item', {'item_code': item.item_code}, 'has_serial_no', (r) => {
			has_serial_no = r && r.has_serial_no;
			if(item.warehouse && item.item_code && item.batch_no) {
				return this.frm.call({
					method: "erpnext.stock.get_item_details.get_batch_qty_and_serial_no",
					child: item,
					args: {
						"batch_no": item.batch_no,
						"stock_qty": item.stock_qty || item.qty, //if stock_qty field is not available fetch qty (in case of Packed Items table)
						"warehouse": item.warehouse,
						"item_code": item.item_code,
						"has_serial_no": has_serial_no
					},
					"fieldname": "actual_batch_qty"
				});
			}
		})
	},

	set_dynamic_labels: function() {
		this._super();
		this.set_product_bundle_help(this.frm.doc);
	},

	set_product_bundle_help: function(doc) {
		if(!cur_frm.fields_dict.packing_list) return;
		if ((doc.packed_items || []).length) {
			$(cur_frm.fields_dict.packing_list.row.wrapper).toggle(true);

			if (in_list(['Delivery Note', 'Sales Invoice'], doc.doctype)) {
				var help_msg = "<div class='alert alert-warning'>" +
					__("For 'Product Bundle' items, Warehouse, Serial No and Batch No will be considered from the 'Packing List' table. If Warehouse and Batch No are same for all packing items for any 'Product Bundle' item, those values can be entered in the main Item table, values will be copied to 'Packing List' table.")+
				"</div>";
				frappe.meta.get_docfield(doc.doctype, 'product_bundle_help', doc.name).options = help_msg;
			}
		} else {
			$(cur_frm.fields_dict.packing_list.row.wrapper).toggle(false);
			if (in_list(['Delivery Note', 'Sales Invoice'], doc.doctype)) {
				frappe.meta.get_docfield(doc.doctype, 'product_bundle_help', doc.name).options = '';
			}
		}
		refresh_field('product_bundle_help');
	},

	margin_rate_or_amount: function(doc, cdt, cdn) {
		// calculated the revised total margin and rate on margin rate changes
		var item = locals[cdt][cdn];
		this.apply_pricing_rule_on_item(item)
		this.calculate_taxes_and_totals();
		cur_frm.refresh_fields();
	},

	margin_type: function(doc, cdt, cdn){
		// calculate the revised total margin and rate on margin type changes
		var item = locals[cdt][cdn];
		if(!item.margin_type) {
			frappe.model.set_value(cdt, cdn, "margin_rate_or_amount", 0);
		} else {
			this.apply_pricing_rule_on_item(item, doc,cdt, cdn)
			this.calculate_taxes_and_totals();
			cur_frm.refresh_fields();
		}
	},

	company_address: function() {
		var me = this;
		if(this.frm.doc.company_address) {
			frappe.call({
				method: "frappe.contacts.doctype.address.address.get_address_display",
				args: {"address_dict": this.frm.doc.company_address },
				callback: function(r) {
					if(r.message) {
						me.frm.set_value("company_address_display", r.message)
					}
				}
			})
		} else {
			this.frm.set_value("company_address_display", "");
		}
	},

	conversion_factor: function(doc, cdt, cdn, dont_fetch_price_list_rate, dont_fetch_batch_no) {
	    this._super(doc, cdt, cdn, dont_fetch_price_list_rate);
		if(!dont_fetch_batch_no) {
			this.set_batch_number(cdt, cdn);
		}
	},

	/* Determine appropriate batch number and set it in the form.
	* @param {string} cdt - Document Doctype
	* @param {string} cdn - Document name
	*/
	set_batch_number: function(cdt, cdn, show_dialog) {
		const doc = frappe.get_doc(cdt, cdn);
		if (doc && frappe.meta.get_docfield(cdt, "stock_qty", cdn)) {
			if (!doc.delivery_note && (this.frm.doc.update_stock || this.frm.doc.doctype != 'Sales Invoice') && !this.frm.doc.is_return) {
				this._set_batch_number(doc, show_dialog);
			}
		}
	},

	_set_batch_number: function(doc, show_dialog) {
		return;

		/*var me = this;

		if (doc.has_batch_no && frappe.meta.get_docfield(doc.doctype, "batch_no", doc.name)) {
			return frappe.call({
				method: 'erpnext.stock.doctype.batch.batch.get_sufficient_batch_or_fifo',
				args: {
					'item_code': doc.item_code,
					'warehouse': doc.s_warehouse || doc.warehouse,
					'qty': flt(doc.qty),
					'conversion_factor': flt(doc.conversion_factor)
				},
				callback: function (r) {
					if (r.message) {
						if (r.message.length === 1 && !show_dialog) {
							frappe.model.set_value(doc.doctype, doc.name, 'batch_no', r.message[0].batch_no);
						} else {
							erpnext.show_serial_batch_selector(me.frm, doc, (item) => {
								me.qty(item, item.doctype, item.name, true);
							}, null, true, (obj) => {
								obj.set_batch_nos(r.message);
								obj.update_total_qty(doc.qty);
							});
						}
					}
				}
			});
		}*/
	},

	auto_select_batches: function() {
		if (this.frm.doc.update_stock && !this.frm.doc.is_return) {
			var me = this;
			return frappe.call({
				method: 'auto_select_batches',
				doc: me.frm.doc,
				freeze: 1,
				callback: function (r) {
					if (!r.exc) {
						me.calculate_taxes_and_totals();
						me.frm.dirty();
					}
				}
			});
		}
	},

	po_cost_from_date: function() {
		this.update_item_valuation_rates();
	},

	po_cost_to_date: function() {
		this.update_item_valuation_rates();
	},

	update_item_valuation_rates: function() {
		if (this.can_get_gross_profit()) {
			var me = this;
			return frappe.call({
				method: 'update_item_valuation_rates',
				doc: me.frm.doc,
				freeze: 1,
				callback: function (r) {
					if (!r.exc) {
						me.get_item_custom_projected_qty && me.get_item_custom_projected_qty(); //workaround
						me.calculate_gross_profit();
						me.frm.refresh_fields();
					}
				}
			});
		}
	},

	toggle_select_batch_button: function(show) {
		var button = this.frm.fields_dict.items.grid.custom_buttons[__("Select Batches")];

		if (button) {
			if (show) {
				button.removeClass('hidden');
			} else {
				button.addClass('hidden');
			}
		}
	},

	update_auto_repeat_reference: function(doc) {
		if (doc.auto_repeat) {
			frappe.call({
				method:"frappe.automation.doctype.auto_repeat.auto_repeat.update_reference",
				args:{
					docname: doc.auto_repeat,
					reference:doc.name
				},
				callback: function(r){
					if (r.message=="success") {
						frappe.show_alert({message:__("Auto repeat document updated"), indicator:'green'});
					} else {
						frappe.show_alert({message:__("An error occurred during the update process"), indicator:'red'});
					}
				}
			})
		}
	}
});

frappe.ui.form.on(cur_frm.doctype,"project", function(frm) {
	if(in_list(["Delivery Note", "Sales Invoice"], frm.doc.doctype)) {
		if(frm.doc.project) {
			frappe.call({
				method:'erpnext.projects.doctype.project.project.get_cost_center_name' ,
				args: {	project: frm.doc.project	},
				callback: function(r, rt) {
					if(!r.exc) {
						$.each(frm.doc["items"] || [], function(i, row) {
							if(r.message) {
								frappe.model.set_value(row.doctype, row.name, "cost_center", r.message);
								frappe.msgprint(__("Cost Center For Item with Item Code '"+row.item_name+"' has been Changed to "+ r.message));
							}
						})
					}
				}
			})
		}
	}
})

frappe.ui.form.on(cur_frm.doctype, {
	set_as_lost_dialog: function(frm) {
		var dialog = new frappe.ui.Dialog({
			title: __("Set as Lost"),
			fields: [
				{"fieldtype": "Table MultiSelect",
				"label": __("Lost Reasons"),
				"fieldname": "lost_reason",
				"options": "Lost Reason Detail",
				"reqd": 1},

				{"fieldtype": "Text", "label": __("Detailed Reason"), "fieldname": "detailed_reason"},
			],
			primary_action: function() {
				var values = dialog.get_values();
				var reasons = values["lost_reason"];
				var detailed_reason = values["detailed_reason"];

				frm.call({
					doc: frm.doc,
					method: 'declare_enquiry_lost',
					args: {
						'lost_reasons_list': reasons,
						'detailed_reason': detailed_reason
					},
					callback: function(r) {
						dialog.hide();
						frm.reload_doc();
					},
				});
				refresh_field("lost_reason");
			},
			primary_action_label: __('Declare Lost')
		});

		dialog.show();
	}
})
