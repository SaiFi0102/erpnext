// Copyright (c) 2016, Frappe Technologies Pvt. Ltd. and contributors
// For license information, please see license.txt
{% include "erpnext/public/js/controllers/accounts.js" %}

frappe.ui.form.on('Payment Entry', {
	onload: function(frm) {
		if(frm.doc.__islocal) {
			if (!frm.doc.paid_from) frm.set_value("paid_from_account_currency", null);
			if (!frm.doc.paid_to) frm.set_value("paid_to_account_currency", null);
		}
	},

	setup: function(frm) {
		$(".control-value", frm.fields_dict.unallocated_advance_payments.$input_wrapper)
			.wrap("<a href='#' id='unallocated_advance_payments_link' target='_blank'></a>");

		frm.set_query("paid_from", function() {
			var account_types = in_list(["Pay", "Internal Transfer"], frm.doc.payment_type) ?
				["Bank", "Cash", "Long Term Liability"] : [frappe.boot.party_account_types[frm.doc.party_type]];

			return {
				filters: {
					"account_type": ["in", account_types],
					"is_group": 0,
					"company": frm.doc.company
				}
			}
		});
		frm.set_query("party_type", function() {
			return{
				"filters": {
					"name": ["in", Object.keys(frappe.boot.party_account_types)],
				}
			}
		});
		frm.set_query("contact_person", function() {
			if (frm.doc.party) {
				return {
					query: 'frappe.contacts.doctype.contact.contact.contact_query',
					filters: {
						link_doctype: frm.doc.party_type,
						link_name: frm.doc.party
					}
				};
			}
		});
		frm.set_query("paid_to", function() {
			var account_types = in_list(["Receive", "Internal Transfer"], frm.doc.payment_type) ?
				["Bank", "Cash", "Long Term Liability"] : [frappe.boot.party_account_types[frm.doc.party_type]];

			return {
				filters: {
					"account_type": ["in", account_types],
					"is_group": 0,
					"company": frm.doc.company
				}
			}
		});

		frm.set_query("account", "deductions", function() {
			return {
				filters: {
					"is_group": 0,
					"company": frm.doc.company
				}
			}
		});

		frm.set_query("cost_center", "deductions", function() {
			return {
				filters: {
					"is_group": 0,
					"company": frm.doc.company
				}
			}
		});

		frm.set_query("reference_doctype", "references", function() {
			if (frm.doc.party_type=="Customer") {
				var doctypes = ["Sales Order", "Sales Invoice", "Journal Entry"];
			} else if (frm.doc.party_type=="Supplier") {
				var doctypes = ["Purchase Order", "Purchase Invoice", "Landed Cost Voucher", "Journal Entry"];
			} else if (frm.doc.party_type=="Letter of Credit") {
				var doctypes = ["Purchase Invoice", "Landed Cost Voucher", "Journal Entry"];
			} else if (frm.doc.party_type=="Employee") {
				var doctypes = ["Expense Claim", "Journal Entry"];
			} else if (frm.doc.party_type=="Student") {
				var doctypes = ["Fees"];
			} else {
				var doctypes = ["Journal Entry"];
			}

			return {
				filters: { "name": ["in", doctypes] }
			};
		});

		frm.set_query("reference_name", "references", function(doc, cdt, cdn) {
			const child = locals[cdt][cdn];

			if(child.reference_doctype == "Journal Entry") {
				return {
					query: "erpnext.accounts.doctype.journal_entry.journal_entry.get_against_jv",
					filters: {
						account: doc.payment_type=="Receive" ? doc.paid_from : doc.paid_to,
						party_type: doc.party_type,
						party: doc.party
					}
				};
			}

			const filters = {"docstatus": 1, "company": doc.company};
			const party_type_doctypes = ['Sales Invoice', 'Sales Order', 'Purchase Invoice',
				'Purchase Order', 'Expense Claim', 'Fees'];

			if (in_list(party_type_doctypes, child.reference_doctype)) {
				filters[frappe.model.scrub(doc.party_type)] = doc.party;
			}

			if(child.reference_doctype == "Expense Claim") {
				filters["docstatus"] = 1;
				filters["is_paid"] = 0;
			}

			return {
				filters: filters
			};
		});
	},

	refresh: function(frm) {
		erpnext.hide_company();
		frm.events.hide_unhide_fields(frm);
		frm.events.set_dynamic_labels(frm);
		frm.events.show_general_ledger(frm);
		frm.events.unallocated_advance_payments(frm);

		var company_currency = frappe.get_doc(":Company", frm.doc.company).default_currency;
		if (frm.doc.docstatus == 1 && frm.doc.payment_type == "Internal Transfer" && frm.doc.paid_to_account_currency != company_currency) {
			frm.add_custom_button(__('Create Currency Exchange'), function () {
				var values = {
					"to_currency": frm.doc.paid_to_account_currency,
					"exchange_rate": frm.doc.target_exchange_rate,
					"date": frm.doc.posting_date
				};

				frappe.new_doc("Currency Exchange", values, (dialog) => {
					dialog.set_values(values);
				});
			});
		}

		frm.events.add_returned_cheque_button(frm);
	},

	add_returned_cheque_button: function(frm) {
		if (frm.doc.docstatus == 1 && frm.doc.payment_type == "Receive") {
			frm.add_custom_button(__('Create Return Entry'), function () {
				var returned_cheque_charges_account = frappe.get_doc(":Company", frm.doc.company).returned_cheque_charges_account;

				var create_journal_entry = function (returned_cheque_charges) {
					var values = {
						"return_against_pe": frm.doc.name,
						"voucher_type": "Returned Cheque",
						"cheque_no": frm.doc.reference_no,
						"cheque_date": frm.doc.reference_date
					};

					returned_cheque_charges = flt(returned_cheque_charges);

					frappe.new_doc("Journal Entry", values).then(r => {
						cur_frm.doc.cheque_no = frm.doc.reference_no;
						cur_frm.doc.cheque_date = frm.doc.reference_date;

						cur_frm.doc.accounts = [];
						var c1 = cur_frm.add_child('accounts', {
							account: frm.doc.paid_from,
							party_type: frm.doc.party_type,
							party: frm.doc.party,
							debit_in_account_currency: flt(frm.doc.received_amount) + returned_cheque_charges,
							debit: frm.doc.base_received_amount
						});
						var c2 = cur_frm.add_child('accounts', {
							account: frm.doc.paid_to,
							credit_in_account_currency: frm.doc.received_amount,
							credit: frm.doc.base_received_amount
						});

						if (returned_cheque_charges) {
							var c3 = cur_frm.add_child('accounts', {
								account: returned_cheque_charges_account,
								credit_in_account_currency: returned_cheque_charges,
								credit: returned_cheque_charges
							});
						}

						cur_frm.refresh_fields();
					});
				};

				if (returned_cheque_charges_account) {
					var dialog = new frappe.ui.Dialog({
						title: __("Create Returned Cheque"),
						fields: [
							{fieldtype: "Currency", fieldname: "charges", label: __("Returned Cheque Charges"), "default": 25},
						]
					});
					dialog.set_primary_action(__("Create Returned Cheque"), function() {
						create_journal_entry(dialog.get_value('charges'));
					});
					dialog.show()
				} else {
					create_journal_entry(0);
				}
			});
		}
	},

	company: function(frm) {
		frm.events.hide_unhide_fields(frm);
		frm.events.set_dynamic_labels(frm);
	},

	contact_person: function(frm) {
		frm.set_value("contact_email", "");
		erpnext.utils.get_contact_details(frm);
	},

	unallocated_advance_payments: function(frm) {
		$("a", frm.fields_dict.unallocated_advance_payments.$input_wrapper).attr("href",
			"desk#Form/Payment Reconciliation/Payment Reconciliation?company="+frm.doc.company+"&party_type="+frm.doc.party_type+"&party=" + frm.doc.party);
		$("a", frm.fields_dict.unallocated_advance_payments.$input_wrapper).css("color",
			flt(frm.doc.unallocated_advance_payments) >= 0.01 ? "red" : "inherit");
	},

	hide_unhide_fields: function(frm) {
		var company_currency = frm.doc.company? frappe.get_doc(":Company", frm.doc.company).default_currency: "";

		frm.toggle_display("source_exchange_rate",
			(frm.doc.paid_amount && frm.doc.paid_from_account_currency != company_currency));

		frm.toggle_display("target_exchange_rate", (frm.doc.received_amount &&
			frm.doc.paid_to_account_currency != company_currency &&
			frm.doc.paid_from_account_currency != frm.doc.paid_to_account_currency));

		frm.toggle_display("base_paid_amount", frm.doc.paid_from_account_currency != company_currency);

		frm.toggle_display("base_received_amount", (frm.doc.paid_to_account_currency != company_currency &&
			frm.doc.paid_from_account_currency != frm.doc.paid_to_account_currency));

		frm.toggle_display("received_amount", (frm.doc.payment_type=="Internal Transfer" ||
			frm.doc.paid_from_account_currency != frm.doc.paid_to_account_currency))

		frm.toggle_display(["base_total_allocated_amount"],
			(frm.doc.paid_amount && frm.doc.received_amount && frm.doc.base_total_allocated_amount &&
			((frm.doc.payment_type=="Receive" && frm.doc.paid_from_account_currency != company_currency) ||
			(frm.doc.payment_type=="Pay" && frm.doc.paid_to_account_currency != company_currency))));

		var party_amount = frm.doc.payment_type=="Receive" ?
			frm.doc.paid_amount : frm.doc.received_amount;

		frm.toggle_display("write_off_difference_amount", (frm.doc.difference_amount && frm.doc.party &&
			(frm.doc.total_allocated_amount > party_amount)));

		frm.toggle_display("set_exchange_gain_loss",
			(frm.doc.paid_amount && frm.doc.received_amount && frm.doc.difference_amount &&
				(frm.doc.paid_from_account_currency != company_currency || frm.doc.paid_to_account_currency != company_currency)));

		frm.refresh_fields();
	},

	set_dynamic_labels: function(frm) {
		var company_currency = frm.doc.company? frappe.get_doc(":Company", frm.doc.company).default_currency: "";

		frm.set_currency_labels(["base_paid_amount", "base_received_amount", "base_total_allocated_amount",
			"difference_amount"], company_currency);

		frm.set_currency_labels(["paid_amount"], frm.doc.paid_from_account_currency);
		frm.set_currency_labels(["received_amount"], frm.doc.paid_to_account_currency);

		var party_account_currency = frm.doc.payment_type=="Receive" ?
			frm.doc.paid_from_account_currency : frm.doc.paid_to_account_currency;

		frm.set_currency_labels(["total_allocated_amount", "unallocated_amount"], party_account_currency);

		var currency_field = (frm.doc.payment_type=="Receive") ? "paid_from_account_currency" : "paid_to_account_currency"
		frm.set_df_property("total_allocated_amount", "options", currency_field);
		frm.set_df_property("unallocated_amount", "options", currency_field);
		frm.set_df_property("party_balance", "options", currency_field);

		frm.set_currency_labels(["total_amount", "outstanding_amount", "allocated_amount"],
			party_account_currency, "references");

		$.each(["total_amount", "outstanding_amount", "allocated_amount"], function (i, f) {
			cur_frm.set_df_property(f, "options", party_account_currency);
		});

		frm.set_currency_labels(["amount"], company_currency, "deductions");

		cur_frm.set_df_property("source_exchange_rate", "description",
			("1 " + frm.doc.paid_from_account_currency + " = [?] " + company_currency));

		cur_frm.set_df_property("target_exchange_rate", "description",
			("1 " + frm.doc.paid_to_account_currency + " = [?] " + company_currency));

		if (frm.doc.payment_type == "Receive") {
			frm.fields_dict['paid_from'].set_label(__("Receivable Account"));
			frm.fields_dict['paid_to'].set_label(__("Account Deposited To"));
		} else if (frm.doc.payment_type == "Pay") {
			frm.fields_dict['paid_from'].set_label(__("Account Paid From"));
			frm.fields_dict['paid_to'].set_label(__("Payable Account"));
		} else {
			frm.fields_dict['paid_from'].set_label(__("Account Paid From"));
			frm.fields_dict['paid_to'].set_label(__("Account Paid To"));
		}

		frm.refresh_fields();
	},

	show_general_ledger: function(frm) {
		if(frm.doc.docstatus==1) {
			frm.add_custom_button(__('Ledger'), function() {
				frappe.route_options = {
					"voucher_no": frm.doc.name,
					"from_date": frm.doc.posting_date,
					"to_date": frm.doc.posting_date,
					"company": frm.doc.company,
					group_by: ""
				};
				frappe.set_route("query-report", "General Ledger");
			}, "fa fa-table");
		}
	},

	payment_type: function(frm) {
		frm.events.set_dynamic_labels(frm);
		if(frm.doc.payment_type == "Internal Transfer") {
			$.each(["party_type", "party", "party_balance", "paid_from", "paid_to",
				"references", "total_allocated_amount"], function(i, field) {
				frm.set_value(field, null);
			});
		} else {
			if(frm.doc.party) {
				frm.events.party(frm);
			}

			if(frm.doc.mode_of_payment) {
				frm.events.mode_of_payment(frm);
			}
		}
	},

	party_type: function(frm) {
		if(frm.doc.party) {
			$.each(["party", "party_balance", "paid_from", "paid_to",
				"paid_from_account_currency", "paid_from_account_balance",
				"paid_to_account_currency", "paid_to_account_balance",
				"references", "total_allocated_amount"],
				function(i, field) {
					frm.set_value(field, null);
				})
		}
	},

	party: function(frm) {
		if (frm.doc.contact_email || frm.doc.contact_person) {
			frm.set_value("contact_email", "");
			frm.set_value("contact_person", "");
		}
		if(frm.doc.payment_type && frm.doc.party_type && frm.doc.party) {
			if(!frm.doc.posting_date) {
				frappe.msgprint(__("Please select Posting Date before selecting Party"))
				frm.set_value("party", "");
				return ;
			}
			frm.set_party_account_based_on_party = true;

			return frappe.call({
				method: "erpnext.accounts.doctype.payment_entry.payment_entry.get_party_details",
				args: {
					company: frm.doc.company,
					party_type: frm.doc.party_type,
					party: frm.doc.party,
					date: frm.doc.posting_date,
					cost_center: frm.doc.cost_center
				},
				callback: function(r, rt) {
					if(r.message) {
						frappe.run_serially([
							() => {
								if(frm.doc.payment_type == "Receive") {
									frm.set_value("paid_from", r.message.party_account);
									frm.set_value("paid_from_account_currency", r.message.party_account_currency);
									frm.set_value("paid_from_account_balance", r.message.account_balance);
								} else if (frm.doc.payment_type == "Pay"){
									frm.set_value("paid_to", r.message.party_account);
									frm.set_value("paid_to_account_currency", r.message.party_account_currency);
									frm.set_value("paid_to_account_balance", r.message.account_balance);
								}
							},
							() => frm.set_value("party_balance", r.message.party_balance),
							() => frm.set_value("unallocated_advance_payments", r.message.unallocated_advance_payments),
							() => frm.events.unallocated_advance_payments(frm),
							() => frm.set_value("party_name", r.message.party_name),
							() => frm.events.get_outstanding_documents(frm),
							() => frm.events.hide_unhide_fields(frm),
							() => frm.events.set_dynamic_labels(frm),
							() => {
								frm.set_party_account_based_on_party = false;
								if (r.message.bank_account) {
									frm.set_value("bank_account", r.message.bank_account);
								}
							}
						]);
					}
				}
			});
		}
	},

	paid_from: function(frm) {
		if(frm.set_party_account_based_on_party) return;

		frm.events.set_account_currency_and_balance(frm, frm.doc.paid_from,
			"paid_from_account_currency", "paid_from_account_balance", function(frm) {
				if (frm.doc.payment_type == "Receive") {
					frm.events.get_outstanding_documents(frm);
				} else if (frm.doc.payment_type == "Pay") {
					frm.events.paid_amount(frm);
				}
			}
		);
	},

	paid_to: function(frm) {
		if(frm.set_party_account_based_on_party) return;

		frm.events.set_account_currency_and_balance(frm, frm.doc.paid_to,
			"paid_to_account_currency", "paid_to_account_balance", function(frm) {
				if(frm.doc.payment_type == "Pay") {
					frm.events.get_outstanding_documents(frm);
				} else if (frm.doc.payment_type == "Receive") {
					if(frm.doc.paid_from_account_currency == frm.doc.paid_to_account_currency) {
						if(frm.doc.source_exchange_rate) {
							frm.set_value("target_exchange_rate", frm.doc.source_exchange_rate);
						}
						frm.set_value("received_amount", frm.doc.paid_amount);

					} else {
						frm.events.received_amount(frm);
					}
				}
			}
		);
	},

	set_account_currency_and_balance: function(frm, account, currency_field,
			balance_field, callback_function) {
		if (frm.doc.posting_date && account) {
			frappe.call({
				method: "erpnext.accounts.doctype.payment_entry.payment_entry.get_account_details",
				args: {
					"account": account,
					"date": frm.doc.posting_date,
					"cost_center": frm.doc.cost_center
				},
				callback: function(r, rt) {
					if(r.message) {
						frappe.run_serially([
							() => frm.set_value(currency_field, r.message['account_currency']),
							() => {
								frm.set_value(balance_field, r.message['account_balance']);

								if(frm.doc.payment_type=="Receive" && currency_field=="paid_to_account_currency") {
									frm.toggle_reqd(["reference_no", "reference_date"],
										(r.message['account_type'] == "Bank" ? 1 : 0));
									if(!frm.doc.received_amount && frm.doc.paid_amount)
										frm.events.paid_amount(frm);
								} else if(frm.doc.payment_type=="Pay" && currency_field=="paid_from_account_currency") {
									frm.toggle_reqd(["reference_no", "reference_date"],
										(r.message['account_type'] == "Bank" ? 1 : 0));

									if(!frm.doc.paid_amount && frm.doc.received_amount)
										frm.events.received_amount(frm);
								}
							},
							() => {
								if(callback_function) callback_function(frm);

								frm.events.hide_unhide_fields(frm);
								frm.events.set_dynamic_labels(frm);
							}
						]);
					}
				}
			});
		}
	},

	paid_from_account_currency: function(frm) {
		if(!frm.doc.paid_from_account_currency) return;
		var company_currency = frappe.get_doc(":Company", frm.doc.company).default_currency;

		if (frm.doc.paid_from_account_currency == company_currency) {
			frm.set_value("source_exchange_rate", 1);
		} else if (frm.doc.paid_from){
			if (in_list(["Internal Transfer", "Pay"], frm.doc.payment_type)) {
				frappe.call({
					method: "erpnext.accounts.doctype.journal_entry.journal_entry.get_average_exchange_rate",
					args: {
						account: frm.doc.paid_from,
						from_currency: frm.doc.paid_from_account_currency,
						to_currency: company_currency,
						transaction_date: frm.doc.posting_date
					},
					callback: function(r, rt) {
						frm.set_value("source_exchange_rate", r.message);
					}
				})
			} else {
				frm.events.set_current_exchange_rate(frm, "source_exchange_rate",
					frm.doc.paid_from_account_currency, company_currency);
			}
		}
	},

	paid_to_account_currency: function(frm) {
		if(!frm.doc.paid_to_account_currency) return;
		var company_currency = frappe.get_doc(":Company", frm.doc.company).default_currency;

		frm.events.set_current_exchange_rate(frm, "target_exchange_rate",
			frm.doc.paid_to_account_currency, company_currency);
	},

	set_current_exchange_rate: function(frm, exchange_rate_field, from_currency, to_currency) {
		frappe.call({
			method: "erpnext.setup.utils.get_exchange_rate",
			args: {
				transaction_date: frm.doc.posting_date,
				from_currency: from_currency,
				to_currency: to_currency
			},
			callback: function(r, rt) {
				frm.set_value(exchange_rate_field, r.message);
			}
		})
	},

	posting_date: function(frm) {
		frm.events.paid_from_account_currency(frm);
	},

	source_exchange_rate: function(frm) {
		if (frm.doc.paid_amount) {
			frm.set_value("base_paid_amount", flt(frm.doc.paid_amount) * flt(frm.doc.source_exchange_rate));
			if(!frm.set_paid_amount_based_on_received_amount &&
					(frm.doc.paid_from_account_currency == frm.doc.paid_to_account_currency)) {
				frm.set_value("target_exchange_rate", frm.doc.source_exchange_rate);
				frm.set_value("base_received_amount", frm.doc.base_paid_amount);
			}

			frm.events.set_unallocated_amount(frm);
		}

		// Make read only if Accounts Settings doesn't allow stale rates
		frm.set_df_property("source_exchange_rate", "read_only", erpnext.stale_rate_allowed() ? 0 : 1);
	},

	target_exchange_rate: function(frm) {
		frm.set_paid_amount_based_on_received_amount = true;

		if (frm.doc.received_amount) {
			frm.set_value("base_received_amount",
				flt(frm.doc.received_amount) * flt(frm.doc.target_exchange_rate));

			if(!frm.doc.source_exchange_rate &&
					(frm.doc.paid_from_account_currency == frm.doc.paid_to_account_currency)) {
				frm.set_value("source_exchange_rate", frm.doc.target_exchange_rate);
				frm.set_value("base_paid_amount", frm.doc.base_received_amount);
			}

			frm.events.set_unallocated_amount(frm);
		}
		frm.set_paid_amount_based_on_received_amount = false;

		// Make read only if Accounts Settings doesn't allow stale rates
		frm.set_df_property("target_exchange_rate", "read_only", erpnext.stale_rate_allowed() ? 0 : 1);
	},

	paid_amount: function(frm) {
		frm.set_value("base_paid_amount", flt(frm.doc.paid_amount) * flt(frm.doc.source_exchange_rate));
		frm.trigger("reset_received_amount");
	},

	received_amount: function(frm) {
		frm.set_paid_amount_based_on_received_amount = true;

		if(!frm.doc.paid_amount && frm.doc.paid_from_account_currency == frm.doc.paid_to_account_currency) {
			frm.set_value("paid_amount", frm.doc.received_amount);

			if(frm.doc.target_exchange_rate) {
				frm.set_value("source_exchange_rate", frm.doc.target_exchange_rate);
			}
			frm.set_value("base_paid_amount", frm.doc.base_received_amount);
		}

		frm.set_value("base_received_amount",
			flt(frm.doc.received_amount) * flt(frm.doc.target_exchange_rate));

		if(frm.doc.payment_type == "Pay")
			frm.events.allocate_party_amount_against_ref_docs(frm, frm.doc.received_amount);
		else
			frm.events.set_unallocated_amount(frm);

		frm.set_paid_amount_based_on_received_amount = false;
	},

	reset_received_amount: function(frm) {
		if(!frm.set_paid_amount_based_on_received_amount &&
				(frm.doc.paid_from_account_currency == frm.doc.paid_to_account_currency)) {

			frm.set_value("received_amount", frm.doc.paid_amount);

			if(frm.doc.source_exchange_rate) {
				frm.set_value("target_exchange_rate", frm.doc.source_exchange_rate);
			}
			frm.set_value("base_received_amount", frm.doc.base_paid_amount);
		}

       /////////////////////Our Code
	   
	   if(frm.doc.payment_type == "Internal Transfer" || frm.doc.payment_type == "Pay")
		{
			if(frm.doc.paid_from_account_currency == "CAD" && frm.doc.paid_to_account_currency == "USD")
			{
				if(frm.doc.target_exchange_rate)
				{
					frm.set_value("received_amount", flt(frm.doc.base_paid_amount/frm.doc.target_exchange_rate), precision("received_amount"));
				}
			}
			if(frm.doc.paid_from_account_currency == "USD" && frm.doc.paid_to_account_currency == "CAD")
			{
				frm.set_value("received_amount", frm.doc.base_paid_amount);
			}
			if(frm.doc.paid_from_account_currency == frm.doc.paid_to_account_currency)
			{
				frm.set_value("received_amount", frm.doc.paid_amount);
			}
		}
	   
	   ///////////////////////Our Code

		if(frm.doc.payment_type == "Receive")
			frm.events.allocate_party_amount_against_ref_docs(frm, frm.doc.paid_amount);
		else
			frm.events.set_unallocated_amount(frm);
	},

	get_outstanding_invoices: function(frm) {
		frm.events.get_outstanding_documents(frm);
	},

	get_outstanding_documents: function(frm) {
		frm.clear_table("references");

		if(!frm.doc.party) return;

		frm.events.check_mandatory_to_fetch(frm);
		var company_currency = frappe.get_doc(":Company", frm.doc.company).default_currency;

		return  frappe.call({
			method: 'erpnext.accounts.doctype.payment_entry.payment_entry.get_outstanding_reference_documents',
			args: {
				args: {
					"posting_date": frm.doc.posting_date,
					"company": frm.doc.company,
					"party_type": frm.doc.party_type,
					"payment_type": frm.doc.payment_type,
					"party": frm.doc.party,
					"party_account": frm.doc.payment_type=="Receive" ? frm.doc.paid_from : frm.doc.paid_to,
					"cost_center": frm.doc.cost_center
				}
			},
			callback: function(r, rt) {
				if(r.message) {
					var total_positive_outstanding = 0;
					var total_negative_outstanding = 0;
					
					r.message.sort(function(a,b){return a.voucher_no < b.voucher_no ? -1 : 1});
					//////Sorder Array/
					
					$.each(r.message, function(i, d) {
						
						if(d.voucher_type != "Purchase Order")    ///////// Condition to remove Purchase Order
						{ 
							var c = frm.add_child("references");
							c.reference_doctype = d.voucher_type;
							c.reference_name = d.voucher_no;
							c.due_date = d.due_date
							c.reference_date = d.reference_date;
							c.total_amount = d.invoice_amount;
							c.outstanding_amount = d.outstanding_amount;
							c.bill_no = d.bill_no;

							if(!in_list(["Sales Order", "Purchase Order", "Expense Claim", "Fees"], d.voucher_type)) {
								if(flt(d.outstanding_amount) > 0)
									total_positive_outstanding += flt(d.outstanding_amount);
								else
									total_negative_outstanding += Math.abs(flt(d.outstanding_amount));
							}

							var party_account_currency = frm.doc.payment_type=="Receive" ?
								frm.doc.paid_from_account_currency : frm.doc.paid_to_account_currency;

							if(party_account_currency != company_currency) {
								c.exchange_rate = d.exchange_rate;
							} else {
								c.exchange_rate = 1;
							}
							if (in_list(['Sales Invoice', 'Purchase Invoice', "Expense Claim", "Fees"], d.reference_doctype)){
								c.due_date = d.due_date;
							}
						}   ///////// Condition to remove Purchase Order
					});

					if(
						(frm.doc.payment_type=="Receive" && frm.doc.party_type=="Customer") ||
						(frm.doc.payment_type=="Pay" && frm.doc.party_type=="Supplier")  ||
						(frm.doc.payment_type=="Pay" && frm.doc.party_type=="Employee") ||
						(frm.doc.payment_type=="Receive" && frm.doc.party_type=="Student")
					) {
						if(total_positive_outstanding > total_negative_outstanding)
							frm.set_value(frm.doc.paid_from_account_currency == frm.doc.paid_to_account_currency ?
								"paid_amount" : "received_amount", total_positive_outstanding - total_negative_outstanding);
					} else if (
						total_negative_outstanding &&
						total_positive_outstanding < total_negative_outstanding
					) {
						frm.set_value(frm.doc.paid_from_account_currency == frm.doc.paid_to_account_currency ?
							"received_amount" : "paid_amount", total_negative_outstanding - total_positive_outstanding);
					}
				}

				frm.events.allocate_party_amount_against_ref_docs(frm,
					(frm.doc.payment_type=="Receive" ? frm.doc.paid_amount : frm.doc.received_amount));
			}
		});
	},

	allocate_payment_amount: function(frm) {
		if(frm.doc.payment_type == 'Internal Transfer'){
			return
		}

		if(frm.doc.references.length == 0){
			frm.events.get_outstanding_documents(frm);
		}
		else if(frm.doc.payment_type == 'Receive') {
			frm.events.allocate_party_amount_against_ref_docs(frm, frm.doc.paid_amount);
		} else {
			frm.events.allocate_party_amount_against_ref_docs(frm, frm.doc.received_amount);
		}
	},

	allocate_party_amount_against_ref_docs: function(frm, paid_amount) {
		var total_positive_outstanding_including_order = 0;
		var total_negative_outstanding = 0;
		var total_deductions = frappe.utils.sum($.map(frm.doc.deductions || [],
			function(d) { return flt(d.amount) }));

		paid_amount -= total_deductions;

		$.each(frm.doc.references || [], function(i, row) {
			if(flt(row.outstanding_amount) > 0)
				total_positive_outstanding_including_order += flt(row.outstanding_amount);
			else
				total_negative_outstanding += Math.abs(flt(row.outstanding_amount));
		})

		var allocated_negative_outstanding = 0;
		if (
				(frm.doc.payment_type=="Receive" && in_list(["Customer", "Student"], frm.doc.party_type)) ||
				(frm.doc.payment_type=="Pay" && in_list(["Supplier", "Letter of Credit", "Employee"], frm.doc.party_type))
			) {
				if(total_positive_outstanding_including_order > paid_amount) {
					var remaining_outstanding = total_positive_outstanding_including_order - paid_amount;
					allocated_negative_outstanding = total_negative_outstanding < remaining_outstanding ?
						total_negative_outstanding : remaining_outstanding;
			}

			var allocated_positive_outstanding =  paid_amount + allocated_negative_outstanding;
		} else if (in_list(["Customer", "Supplier", "Letter of Credit"], frm.doc.party_type)) {
			if(paid_amount > total_negative_outstanding) {
				if(total_negative_outstanding == 0) {
					frappe.msgprint(__("Cannot {0} {1} {2} without any negative outstanding invoice",
						[frm.doc.payment_type,
							(frm.doc.party_type=="Customer" ? "to" : "from"), frm.doc.party_type]));
					return false
				} else {
					frappe.msgprint(__("Paid Amount cannot be greater than total negative outstanding amount {0}", [total_negative_outstanding]));
					return false;
				}
			} else {
				allocated_positive_outstanding = total_negative_outstanding - paid_amount;
				allocated_negative_outstanding = paid_amount +
					(total_positive_outstanding_including_order < allocated_positive_outstanding ?
						total_positive_outstanding_including_order : allocated_positive_outstanding)
			}
		}

		$.each(frm.doc.references || [], function(i, row) {
			row.allocated_amount = 0 //If allocate payment amount checkbox is unchecked, set zero to allocate amount
			if(frm.doc.allocate_payment_amount){
				if(row.outstanding_amount > 0 && allocated_positive_outstanding > 0) {
					if(row.outstanding_amount >= allocated_positive_outstanding) {
						row.allocated_amount = allocated_positive_outstanding;
					} else {
						row.allocated_amount = row.outstanding_amount;
					}

					allocated_positive_outstanding -= flt(row.allocated_amount);
				} else if (row.outstanding_amount < 0 && allocated_negative_outstanding) {
					if(Math.abs(row.outstanding_amount) >= allocated_negative_outstanding)
						row.allocated_amount = -1*allocated_negative_outstanding;
					else row.allocated_amount = row.outstanding_amount;

					allocated_negative_outstanding -= Math.abs(flt(row.allocated_amount));
				}
			}
		})
		
		/////// Our Code
		var chkd = 0;
		(frm.fields_dict.references.grid.grid_rows || []).forEach(function(row) { 
				if(row.doc.__checked) 
				{ 
					chkd = chkd + 1;
				} 
				
			})
		$.each(frm.doc.references || [], function(i, row) {
			row.allocated_amount = 0 //If allocate payment amount checkbox is unchecked, set zero to allocate amount
			if(frm.doc.allocate_payment_amount){
				
				if(chkd > 0)
				{
					if(row.__checked) 
					{ 
						if(row.outstanding_amount > 0 && allocated_positive_outstanding > 0) {
							if(row.outstanding_amount >= allocated_positive_outstanding) {
								row.allocated_amount = allocated_positive_outstanding;
							} else {
								row.allocated_amount = row.outstanding_amount;
							}

						allocated_positive_outstanding -= flt(row.allocated_amount);
						} else if (row.outstanding_amount < 0 && allocated_negative_outstanding) {
							if(Math.abs(row.outstanding_amount) >= allocated_negative_outstanding)
								row.allocated_amount = -1*allocated_negative_outstanding;
							else row.allocated_amount = row.outstanding_amount;

							allocated_negative_outstanding -= Math.abs(flt(row.allocated_amount));
						}
					}
					else
					{
						row.allocated_amount = 0;
					}
				}
				else 
				{
					if(row.outstanding_amount > 0 && allocated_positive_outstanding > 0) {
						if(row.outstanding_amount >= allocated_positive_outstanding) {
							row.allocated_amount = allocated_positive_outstanding;
						} else {
							row.allocated_amount = row.outstanding_amount;
						}

						allocated_positive_outstanding -= flt(row.allocated_amount);
					} else if (row.outstanding_amount < 0 && allocated_negative_outstanding) {
						if(Math.abs(row.outstanding_amount) >= allocated_negative_outstanding)
							row.allocated_amount = -1*allocated_negative_outstanding;
						else row.allocated_amount = row.outstanding_amount;

						allocated_negative_outstanding -= Math.abs(flt(row.allocated_amount));
					}
				}
			}
			else
			{
				if(chkd > 0)
				{
					if(row.__checked) 
					{ 
						if(row.outstanding_amount > 0 && allocated_positive_outstanding > 0) {
							if(row.outstanding_amount >= allocated_positive_outstanding) {
								row.allocated_amount = allocated_positive_outstanding;
							} else {
								row.allocated_amount = row.outstanding_amount;
							}

						allocated_positive_outstanding -= flt(row.allocated_amount);
						} else if (row.outstanding_amount < 0 && allocated_negative_outstanding) {
							if(Math.abs(row.outstanding_amount) >= allocated_negative_outstanding)
								row.allocated_amount = -1*allocated_negative_outstanding;
							else row.allocated_amount = row.outstanding_amount;

							allocated_negative_outstanding -= Math.abs(flt(row.allocated_amount));
						}
						
						if(frm.doc.payment_type == "Pay"  && !frm.doc.is_reverse )
						{
							row.allocated_amount = row.outstanding_amount;
						}
					}
					else
					{
						row.allocated_amount = 0;
					}
				}
				else if(frm.doc.payment_type=="Pay"  && frm.doc.is_reverse && chkd < 1)
				{
						if(row.outstanding_amount > 0 && allocated_positive_outstanding > 0) {
							if(row.outstanding_amount >= allocated_positive_outstanding) {
								row.allocated_amount = allocated_positive_outstanding;
							} else {
								row.allocated_amount = row.outstanding_amount;
							}

							allocated_positive_outstanding -= flt(row.allocated_amount);
							row.__checked = 1;
						} else if (row.outstanding_amount < 0 && allocated_negative_outstanding) {
							if(Math.abs(row.outstanding_amount) >= allocated_negative_outstanding)
								row.allocated_amount = -1*allocated_negative_outstanding;
							else row.allocated_amount = row.outstanding_amount;

							allocated_negative_outstanding -= Math.abs(flt(row.allocated_amount));
							row.__checked = 1;
						}
				}
			}
		})
		///////Our Code
		frm.refresh_fields()
		frm.events.set_total_allocated_amount(frm);
		
		
		////////////Our Code
		
		if(frm.doc.payment_type == "Receive")
		{
			for(var i=0; i<frm.doc.references.length;i++)
			{
				var child = frm.doc.references[i];
				if((frm.doc.received_amount == frm.doc.total_allocated_amount) && !child.__checked)
				{
					frm.fields_dict.references.grid.grid_rows[i].row.find('.grid-row-check').attr('disabled',true);
					$('div[data-fieldname="references"] .grid-heading-row .grid-row-check').attr('disabled',true);
				}
				else
				{
					frm.fields_dict.references.grid.grid_rows[i].row.find('.grid-row-check').removeAttr('disabled');
					$('div[data-fieldname="references"] .grid-heading-row .grid-row-check').removeAttr('disabled');
				}
			}
		}
		
		///////////Our Code
	},

	set_total_allocated_amount: function(frm) {
		var total_allocated_amount = 0.0;
		var base_total_allocated_amount = 0.0;
		$.each(frm.doc.references || [], function(i, row) {
			if (row.allocated_amount) {
				total_allocated_amount += flt(row.allocated_amount);
				base_total_allocated_amount += flt(flt(row.allocated_amount)*flt(row.exchange_rate),
					precision("base_paid_amount"));
			}
		});
		frm.set_value("total_allocated_amount", Math.abs(total_allocated_amount));
		frm.set_value("base_total_allocated_amount", Math.abs(base_total_allocated_amount));
		
		////Our Code
			if(frm.doc.payment_type == "Pay" &&  !frm.doc.is_reverse )
			{
				if(frm.doc.paid_from_account_currency == "CAD")
				{
					frm.set_value("paid_amount", Math.abs(base_total_allocated_amount));
				}
				if(frm.doc.paid_from_account_currency == "USD")
				{
					frm.set_value("paid_amount", Math.abs(total_allocated_amount));
				}
			
			}
		
		//////Our Code End
		
		
		
		frm.events.set_unallocated_amount(frm);
	},

	set_unallocated_amount: function(frm) {
		var unallocated_amount = 0;
		var total_deductions = frappe.utils.sum($.map(frm.doc.deductions || [],
			function(d) { return flt(d.amount) }));

		if(frm.doc.party) {
			if(frm.doc.payment_type == "Receive"
				&& frm.doc.base_total_allocated_amount < frm.doc.base_received_amount + total_deductions
				&& frm.doc.total_allocated_amount < frm.doc.paid_amount + (total_deductions / frm.doc.source_exchange_rate)) {
					unallocated_amount = (frm.doc.base_received_amount + total_deductions
						- frm.doc.base_total_allocated_amount) / frm.doc.source_exchange_rate;
			} else if (frm.doc.payment_type == "Pay"
				&& frm.doc.base_total_allocated_amount < frm.doc.base_paid_amount - total_deductions
				&& frm.doc.total_allocated_amount < frm.doc.received_amount + (total_deductions / frm.doc.target_exchange_rate)) {
					unallocated_amount = (frm.doc.base_paid_amount - (total_deductions
						+ frm.doc.base_total_allocated_amount)) / frm.doc.target_exchange_rate;
			}
		}
		frm.set_value("unallocated_amount", unallocated_amount);
		frm.trigger("set_difference_amount");
	},

	set_difference_amount: function(frm) {
		var difference_amount = 0;
		var base_unallocated_amount = flt(frm.doc.unallocated_amount) *
			(frm.doc.payment_type=="Receive" ? frm.doc.source_exchange_rate : frm.doc.target_exchange_rate);

		var base_party_amount = flt(frm.doc.base_total_allocated_amount) + base_unallocated_amount;

		if(frm.doc.payment_type == "Receive") {
			difference_amount = base_party_amount - flt(frm.doc.base_received_amount);
		} else if (frm.doc.payment_type == "Pay") {
			difference_amount = flt(frm.doc.base_paid_amount) - base_party_amount;
		} else {
			difference_amount = flt(frm.doc.base_paid_amount) - flt(frm.doc.base_received_amount);
		}

		var total_deductions = frappe.utils.sum($.map(frm.doc.deductions || [],
			function(d) { return flt(d.amount) }));

		frm.set_value("difference_amount", difference_amount - total_deductions);

		frm.events.hide_unhide_fields(frm);
	},

	unallocated_amount: function(frm) {
		frm.trigger("set_difference_amount");
	},

	check_mandatory_to_fetch: function(frm) {
		$.each(["Company", "Party Type", "Party", "payment_type"], function(i, field) {
			if(!frm.doc[frappe.model.scrub(field)]) {
				frappe.msgprint(__("Please select {0} first", [field]));
				return false;
			}

		});
	},

	validate_reference_document: function(frm, row) {
		var _validate = function(i, row) {
			if (!row.reference_doctype) {
				return;
			}

			if(frm.doc.party_type=="Customer" &&
				!in_list(["Sales Order", "Sales Invoice", "Journal Entry"], row.reference_doctype)
			) {
				frappe.model.set_value(row.doctype, row.name, "reference_doctype", null);
				frappe.msgprint(__("Row #{0}: Reference Document Type must be one of Sales Order, Sales Invoice or Journal Entry", [row.idx]));
				return false;
			}

			if(frm.doc.party_type=="Supplier" &&
				!in_list(["Purchase Order", "Purchase Invoice", "Landed Cost Voucher", "Journal Entry"], row.reference_doctype)
			) {
				frappe.model.set_value(row.doctype, row.name, "against_voucher_type", null);
				frappe.msgprint(__("Row #{0}: Reference Document Type must be one of Purchase Order, Purchase Invoice, Landed Cost Voucher or Journal Entry", [row.idx]));
				return false;
			}

			if(frm.doc.party_type=="Employee" &&
				!in_list(["Expense Claim", "Journal Entry"], row.reference_doctype)
			) {
				frappe.model.set_value(row.doctype, row.name, "against_voucher_type", null);
				frappe.msgprint(__("Row #{0}: Reference Document Type must be one of Expense Claim or Journal Entry", [row.idx]));
				return false;
			}
		}

		if (row) {
			_validate(0, row);
		} else {
			$.each(frm.doc.vouchers || [], _validate);
		}
	},

	write_off_difference_amount: function(frm) {
		frm.events.set_deductions_entry(frm, "write_off_account");
	},

	set_exchange_gain_loss: function(frm) {
		frm.events.set_deductions_entry(frm, "exchange_gain_loss_account");
	},

	set_deductions_entry: function(frm, account) {
		if(frm.doc.difference_amount) {
			frappe.call({
				method: "erpnext.accounts.doctype.payment_entry.payment_entry.get_company_defaults",
				args: {
					company: frm.doc.company
				},
				callback: function(r, rt) {
					if(r.message) {
						var write_off_row = $.map(frm.doc["deductions"] || [], function(t) {
							return t.account==r.message[account] ? t : null; });

						var row = [];

						var difference_amount = flt(frm.doc.difference_amount,
							precision("difference_amount"));

						if (!write_off_row.length && difference_amount) {
							row = frm.add_child("deductions");
							row.account = r.message[account];
							row.cost_center = r.message["cost_center"];
						} else {
							row = write_off_row[0];
						}

						if (row) {
							row.amount = flt(row.amount) + difference_amount;
						} else {
							frappe.msgprint(__("No gain or loss in the exchange rate"))
						}

						refresh_field("deductions");

						frm.events.set_unallocated_amount(frm);
					}
				}
			})
		}
	},

	bank_account: function(frm) {
		const field = frm.doc.payment_type == "Pay" ? "paid_from":"paid_to";
		if (frm.doc.bank_account && in_list(['Pay', 'Receive'], frm.doc.payment_type)) {
			frappe.call({
				method: "erpnext.accounts.doctype.bank_account.bank_account.get_bank_account_details",
				args: {
					bank_account: frm.doc.bank_account
				},
				callback: function(r) {
					if (r.message) {
						frm.set_value(field, r.message.account);
						frm.set_value('bank', r.message.bank);
						frm.set_value('bank_account_no', r.message.bank_account_no);
					}
				}
			});
		}
	}
});


frappe.ui.form.on('Payment Entry Reference', {
	reference_doctype: function(frm, cdt, cdn) {
		var row = locals[cdt][cdn];
		frm.events.validate_reference_document(frm, row);
	},

	reference_name: function(frm, cdt, cdn) {
		var row = locals[cdt][cdn];
		if (row.reference_name && row.reference_doctype) {
			return frappe.call({
				method: "erpnext.accounts.doctype.payment_entry.payment_entry.get_reference_details",
				args: {
					reference_doctype: row.reference_doctype,
					reference_name: row.reference_name,
					party_account_currency: frm.doc.payment_type=="Receive" ?
						frm.doc.paid_from_account_currency : frm.doc.paid_to_account_currency,
					party_type: frm.doc.party_type,
					party: frm.doc.party,
					account: frm.doc.payment_type=="Receive" ? frm.doc.paid_from : frm.doc.paid_to
				},
				callback: function(r, rt) {
					if(r.message) {
						$.each(r.message, function(field, value) {
							frappe.model.set_value(cdt, cdn, field, value);
						})

						let allocated_amount = frm.doc.unallocated_amount > row.outstanding_amount ?
							row.outstanding_amount : frm.doc.unallocated_amount;

						frappe.model.set_value(cdt, cdn, 'allocated_amount', allocated_amount);
						frm.refresh_fields();
					}
				}
			})
		}
	},

	allocated_amount: function(frm) {
		frm.events.set_total_allocated_amount(frm);
	},

	references_remove: function(frm) {
		frm.events.set_total_allocated_amount(frm);
	}
})

frappe.ui.form.on('Payment Entry Deduction', {
	amount: function(frm) {
		frm.events.set_unallocated_amount(frm);
	},

	deductions_remove: function(frm) {
		frm.events.set_unallocated_amount(frm);
	}
})
frappe.ui.form.on('Payment Entry', {
	cost_center: function(frm){
		if (frm.doc.posting_date && (frm.doc.paid_from||frm.doc.paid_to)) {
			return frappe.call({
				method: "erpnext.accounts.doctype.payment_entry.payment_entry.get_party_and_account_balance",
				args: {
					company: frm.doc.company,
					date: frm.doc.posting_date,
					paid_from: frm.doc.paid_from,
					paid_to: frm.doc.paid_to,
					ptype: frm.doc.party_type,
					pty: frm.doc.party,
					cost_center: frm.doc.cost_center
				},
				callback: function(r, rt) {
					if(r.message) {
						frappe.run_serially([
							() => {
								frm.set_value("paid_from_account_balance", r.message.paid_from_account_balance);
								frm.set_value("paid_to_account_balance", r.message.paid_to_account_balance);
								frm.set_value("party_balance", r.message.party_balance);
							},
							() => {
								if(frm.doc.payment_type != "Internal") {
									frm.events.get_outstanding_documents(frm);
								}
							}
						]);

					}
				}
			});
		}
	},
})

frappe.ui.form.on("Payment Entry", {
	'onload_post_render': function(frm) {

		    frm.fields_dict.references.grid.wrapper.on('click', '.grid-row-check', function(e) {
			if(frm.doc.payment_type == 'Internal Transfer')
			{
				frm.events.allocate_party_amount_against_ref_docs(frm, frm.doc.paid_amount);
			}
			else
			{
				frm.events.allocate_party_amount_against_ref_docs(frm, frm.doc.received_amount);
			}
			frm.events.get_selected_totals(frm);

		});
	},
	is_reverse: function(frm) {
		frm.events.allocate_party_amount_against_ref_docs(frm, frm.doc.received_amount);
		frm.events.get_selected_totals(frm);
	},
	allocate_payment_amount: function(frm) {
		frm.events.get_selected_totals(frm);
	},
	'get_selected_totals': function(frm) {
		var ttl = 0;
			(frm.fields_dict.references.grid.grid_rows || []).forEach(function(row) {
				if(row.doc.__checked)
				{
					var amount = flt(row.doc.allocated_amount);
					//console.log(amount);
					ttl = ttl+amount;
				}

			})
			frm.refresh_field("references");
			frm.refresh_fields();
			frm.set_value("total_selected_allocated_amount", ttl.toFixed(2));
	},
	'refresh': function(frm) {
		frm.page.sidebar.remove(); // this removes the sidebar
    		frm.page.wrapper.find(".layout-main-section-wrapper").removeClass("col-md-10");
    		frm.page.wrapper.find(".layout-main-section-wrapper").addClass("col-md-12");
			frm.events.set_dynamic_labels1(frm);

		if(frm.doc.payment_type=="Receive")
		{

			//$('div[data-fieldname="paid_amount"] .control-label').html("Received Amount (" + frm.doc.paid_to_account_currency+ ")");
			$('.grid-heading-row div[data-fieldname="due_date"] .static-area').html("Posting Date");
			$('div[data-fieldname="party"] .control-label').html("Customer");

			if(!frm.doc.reference_date)
			{
				frm.doc.reference_date = frm.doc.posting_date;
			}
			if(!frm.doc.reference_no)
			{
				//frm.doc.reference_no = frm.doc.posting_date;
			}
		}
		else
		{
			//$('div[data-fieldname="paid_amount"] .control-label').html("Paid Amount (" + frm.doc.paid_from_account_currency+ ")");
			$('.grid-heading-row div[data-fieldname="due_date"] .static-area').html("Received Date");
			$('div[data-fieldname="party"] .control-label').html("Supplier");
		}
	},
	'set_dynamic_labels1':function(frm){

		if(frm.doc.payment_type=="Receive")
		{
			//cur_frm.set_df_property("paid_amount", "options", "Received Amount" + //frm.doc.paid_to_account_currency);
			if(frm.doc.paid_from_account_currency == frm.doc.paid_to_account_currency)
			{
				$('div[data-fieldname="paid_amount"] .control-label').html("Received Amount (" + frm.doc.paid_to_account_currency+ ")");
			}
			else
			{
				$('div[data-fieldname="paid_amount"] .control-label').html("Paid Amount (" + frm.doc.paid_from_account_currency+ ")");
			}

			$('.grid-heading-row div[data-fieldname="due_date"] .static-area').html("Posting Date");

			$('div[data-fieldname="paid_from"] .control-label').html("Receivable Account");
			$('div[data-fieldname="paid_to"] .control-label').html("Account Deposited To");
		}
		else
		{
			$('div[data-fieldname="paid_amount"] .control-label').html("Paid Amount (" + frm.doc.paid_from_account_currency+ ")");
			$('.grid-heading-row div[data-fieldname="due_date"] .static-area').html("Account Paid From");

			$('div[data-fieldname="paid_from"] .control-label').html("Account Paid From");
			$('div[data-fieldname="paid_to"] .control-label').html("Payable Account");
		}

	},
	payment_type: function(frm) {
		if(frm.doc.payment_type == "Internal Transfer") {
			frm.doc.naming_series = "PE-";
			refresh_field("naming_series");
		} else {
			if(frm.doc.payment_type == "Receive")
			{
				frm.doc.party_type = "Customer";
				frm.doc.naming_series = "PR-";
				refresh_field("party_type");
				refresh_field("naming_series");
				$('div[data-fieldname="party"] .control-label').html("Customer");
				if(!frm.doc.reference_date)
				{
					frm.doc.reference_date = frm.doc.posting_date;
				}
				if(!frm.doc.reference_no)
				{
					//frm.doc.reference_no = frm.doc.posting_date;
				}
			}
			if(frm.doc.payment_type == "Pay")
			{
				frm.doc.party_type = "Supplier";
				frm.doc.naming_series = "PE-";
				refresh_field("party_type");
				refresh_field("naming_series");
				$('div[data-fieldname="party"] .control-label').html("Supplier");
			}
		}
	},
	mode_of_payment: function(frm) {
		if(frm.doc.payment_type == "Internal Transfer")
		{
			frm.set_value("paid_from", null);
			frm.set_value("paid_to", null);
			frm.refresh_fields();
		}
	},
});
frappe.ui.form.on('Payment Entry Reference', {
	allocated_amount: function(frm, cdt, cdn) {
		frm.events.get_selected_totals(frm);
	}
});
