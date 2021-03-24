# Copyright (c) 2015, Frappe Technologies Pvt. Ltd. and Contributors
# License: GNU General Public License v3. See license.txt

from __future__ import unicode_literals
import frappe
from frappe import _, scrub
from frappe.utils import flt, nowdate, getdate, cstr, cint
from erpnext.stock.report.stock_ledger.stock_ledger import get_item_group_condition
from six import iteritems, string_types
from collections import OrderedDict
from erpnext.stock.doctype.item.item import convert_item_uom_for
import datetime
import json


def execute(filters=None):
	filters = frappe._dict(filters or {})
	filters.date = getdate(filters.date or nowdate())
	filters.from_date = filters.date
	filters.to_date = frappe.utils.add_days(filters.from_date, 4)

	if filters.buying_selling == "Selling":
		filters.standard_price_list = frappe.db.get_single_value("Selling Settings", "base_price_list")
	elif filters.buying_selling == "Buying":
		filters.standard_price_list = None

	stock_settings = frappe.get_single("Stock Settings")
	filters.item_groups_excluded = [d.item_group for d in stock_settings.price_list_excluded or []]

	data, price_lists = get_data(filters)
	columns = get_columns(filters, price_lists)

	item_group_wise_data = {}
	for d in data:
		item_group_wise_data.setdefault(d.item_group, []).append(d)

	res = []

	for item_group in stock_settings.price_list_order or []:
		if item_group.item_group in item_group_wise_data:
			res += sorted(item_group_wise_data[item_group.item_group], key=lambda d: d.item_code)
			del item_group_wise_data[item_group.item_group]

	for items in item_group_wise_data.values():
		res += sorted(items, key=lambda d: d.item_code)

	return columns, res


def get_printable_data(columns, data, filters):
	item_groups = OrderedDict()

	data = list(filter(lambda d: d.print_in_price_list, data))

	for i in range(len(data)):
		if not data[i].item_code:
			continue

		group = item_groups.setdefault(data[i].item_group, [])
		group.append(data[i])

	for item_group, items in iteritems(item_groups):
		item_groups[item_group] = sorted(items, key=lambda d: d.item_name)

	return item_groups

def get_data(filters):
	conditions = get_item_conditions(filters, use_doc_name=False)
	item_conditions = get_item_conditions(filters, use_doc_name=True)
	po_conditions = get_po_conditions(filters)
	show_amounts_role = frappe.db.get_single_value("Stock Settings", "restrict_amounts_in_report_to_role")

	price_lists, selected_price_list = get_price_lists(filters)
	price_lists_cond = " and p.price_list in ({0})".format(", ".join([frappe.db.escape(d) for d in price_lists]))

	item_data = frappe.db.sql("""
		select item.name as item_code, item.item_name, upper(c.code) as origin, item.item_group, item.print_in_price_list,
			item.stock_uom, item.sales_uom, item.purchase_uom, item.alt_uom, item.alt_uom_size
		from tabItem item
		left join tabCountry c on c.name = item.country_of_origin
		where disabled != 1 and is_sales_item = 1 {0}
	""".format(item_conditions), filters, as_dict=1)

	po_data = frappe.db.sql("""
		select
			item.item_code,
			sum(if(item.qty - item.received_qty < 0, 0, item.qty - item.received_qty) * item.conversion_factor) as po_qty,
			sum(if(item.qty - item.received_qty < 0, 0, item.qty - item.received_qty) * item.conversion_factor * item.landed_rate) as po_lc_amount
		from `tabPurchase Order Item` item
		inner join `tabPurchase Order` po on po.name = item.parent
		where item.docstatus < 2 and po.status != 'Closed' {0} {1}
		group by item.item_code
	""".format(conditions, po_conditions), filters, as_dict=1)

	bin_data = frappe.db.sql("""
		select
			bin.item_code,
			sum(bin.actual_qty) as actual_qty,
			sum(bin.stock_value) as stock_value
		from tabBin bin, tabItem item
		where item.name = bin.item_code {0}
		group by bin.item_code
	""".format(item_conditions), filters, as_dict=1)

	item_price_data = frappe.db.sql("""
		select p.name, p.price_list, p.item_code, p.price_list_rate, ifnull(p.valid_from, '2000-01-01') as valid_from, p.uom
		from `tabItem Price` p
		inner join `tabItem` item on item.name = p.item_code
		where %(date)s between ifnull(p.valid_from, '2000-01-01') and ifnull(p.valid_upto, '2500-12-31')
			{0} {1}
		order by p.uom
	""".format(item_conditions, price_lists_cond), filters, as_dict=1)

	if not filters.previous_price_date:
		# Get prev monday
		filters.previous_price_date = filters.date + datetime.timedelta(days=-filters.date.weekday())
		if filters.previous_price_date == filters.date:
			filters.previous_price_date = filters.previous_price_date + datetime.timedelta(weeks=-1)

	previous_price_date_cond = "and p.valid_upto >= %(previous_price_date)s"

	previous_item_prices = frappe.db.sql("""
		select p.price_list, p.item_code, p.price_list_rate, ifnull(p.valid_from, '2000-01-01') as valid_from, p.uom
		from `tabItem Price` as p
		inner join `tabItem` item on item.name = p.item_code
		where ifnull(p.valid_upto, '0000-00-00') != '0000-00-00' and p.valid_upto < %(date)s {0} {1} {2}
		order by p.valid_upto desc
	""".format(item_conditions, price_lists_cond, previous_price_date_cond), filters, as_dict=1)

	pricing_rule_map = {}
	if filters.get('customer'):
		pricing_rule_data = frappe.db.sql("""
			select pr.name, pr_item.item_code, pr.rate, pr.for_price_list
			from `tabPricing Rule` pr
			inner join `tabPricing Rule Item Code` pr_item on pr_item.parent = pr.name
			where pr.disable = 0 and pr.selling = 1
				and pr.apply_on = 'Item Code' and pr.price_or_product_discount = 'Price' and pr.rate_or_discount = 'Rate'
				and pr.applicable_for = 'Customer' and pr.customer = %(customer)s
				and %(date)s between ifnull(pr.valid_from, '2000-01-01') and ifnull(pr.valid_upto, '2500-12-31')
			order by ifnull(priority, 0) desc
		""", filters, as_dict=1)

		for d in pricing_rule_data:
			pricing_rule_map.setdefault(d.item_code, {}).setdefault(cstr(d.for_price_list), d)

	items_map = {}
	for d in item_data:
		default_uom = d.purchase_uom if filters.buying_selling == "Buying" else d.sales_uom
		if filters.uom:
			d['uom'] = filters.uom
		elif filters.default_uom == "Stock UOM":
			d['uom'] = d.stock_uom
		elif filters.default_uom == "Contents UOM":
			d['uom'] = d.alt_uom or default_uom
		else:
			d['uom'] = default_uom

		if not d.get('uom'):
			d['uom'] = d.stock_uom

		d['alt_uom_size'] = convert_item_uom_for(d.alt_uom_size, d.item_code, d.stock_uom, d.uom)
		items_map[d.item_code] = d

	for d in po_data:
		if d.item_code in items_map:
			items_map[d.item_code].update(d)

	for d in bin_data:
		if d.item_code in items_map:
			items_map[d.item_code].update(d)

	for item_prices in [item_price_data, previous_item_prices]:
		for d in item_prices:
			if d.item_code in items_map:
				d.price_list_rate = convert_item_uom_for(d.price_list_rate, d.item_code, d.uom, items_map[d.item_code]['uom'],
					null_if_not_convertible=True)

	item_price_map = {}
	for d in item_price_data:
		if d.item_code in items_map and d.price_list_rate is not None:
			current_item = items_map[d.item_code]
			show_amounts = show_amounts_role and show_amounts_role in frappe.get_roles()
			price = item_price_map.setdefault(d.item_code, {}).setdefault(d.price_list, frappe._dict())
			pick_price = (cstr(d.uom) == cstr(current_item.uom)
					or (cstr(price.reference_uom) != cstr(current_item.uom) and cstr(d.uom) != current_item.stock_uom)
					or not price)

			if pick_price:
				price.current_price = d.price_list_rate
				price.valid_from = d.valid_from
				price.reference_uom = d.uom

				if d.price_list == filters.standard_price_list:
					items_map[d.item_code].standard_rate = d.price_list_rate

				if show_amounts:
					price.item_price = d.name

			stock_price_list = selected_price_list or filters.standard_price_list
			if show_amounts and d.price_list == stock_price_list and d.uom == current_item.stock_uom:
				price.stock_item_price = d.name

	for d in previous_item_prices:
		if d.item_code in item_price_map and d.price_list in item_price_map[d.item_code] and d.price_list_rate is not None:
			price = item_price_map[d.item_code][d.price_list]
			if 'previous_price' not in price and d.valid_from < price.valid_from and cstr(price.reference_uom) == cstr(d.uom):
				price.previous_price = d.price_list_rate

	for item_code, d in iteritems(items_map):
		conversion_factor = convert_item_uom_for(1, d.item_code, d.stock_uom, d.uom)
		d.actual_qty = flt(d.actual_qty) / conversion_factor
		d.po_qty = flt(d.po_qty) / conversion_factor

		d.po_lc_rate = flt(d.po_lc_amount) / d.po_qty if d.po_qty else 0
		d.valuation_rate = flt(d.stock_value) / d.actual_qty if d.actual_qty else 0

		d.projected_qty = d.actual_qty + d.po_qty
		d.avg_lc_rate = (flt(d.stock_value) + flt(d.po_lc_amount)) / d.projected_qty if d.projected_qty else 0
		d.margin_rate = (d.standard_rate - d.avg_lc_rate) * 100 / d.standard_rate if d.standard_rate else None

		pricing_rule = pricing_rule_map.get(item_code, {}).get('')
		if pricing_rule:
			for price_list in price_lists:
				d['pricing_rule_' + scrub(price_list)] = pricing_rule.name
				d['pricing_rule_rate_' + scrub(price_list)] = pricing_rule.rate
		for price_list, pricing_rule in iteritems(pricing_rule_map.get(item_code, {})):
			if price_list:
				d['pricing_rule_' + scrub(price_list)] = pricing_rule.name
				d['pricing_rule_rate_' + scrub(price_list)] = pricing_rule.rate

		for price_list, price in iteritems(item_price_map.get(item_code, {})):
			d["rate_" + scrub(price_list)] = price.current_price
			if d.standard_rate is not None:
				d["rate_diff_" + scrub(price_list)] = flt(price.current_price) - flt(d.standard_rate)
			if price.previous_price is not None:
				d["rate_old_" + scrub(price_list)] = price.previous_price
			if price.item_price:
				d["item_price_" + scrub(price_list)] = price.item_price
			if price.stock_item_price:
				d["stock_item_price"] = price.stock_item_price

		if selected_price_list:
			d['print_rate'] = d.get("pricing_rule_rate_" + scrub(selected_price_list)) or d.get("rate_" + scrub(selected_price_list))
		else:
			d['print_rate'] = d.get("pricing_rule_rate_" + scrub(filters.standard_price_list)) or d.standard_rate

	if filters.filter_items_without_price:
		to_remove = []
		for item_code, d in iteritems(items_map):
			if not d.get('print_rate'):
				to_remove.append(item_code)
		for item_code in to_remove:
			del items_map[item_code]

	return items_map.values(), price_lists


def get_price_lists(filters):
	if filters.filter_price_list_by == "All":
		price_list_filter_cond = ""
	elif filters.filter_price_list_by == "Disabled":
		price_list_filter_cond = " and enabled = 0"
	else:
		price_list_filter_cond = " and enabled = 1"

	show_amounts_role = frappe.db.get_single_value("Stock Settings", "restrict_amounts_in_report_to_role")
	show_amounts = show_amounts_role and show_amounts_role in frappe.get_roles()
	if not show_amounts:
		buying_selling_cond = " and selling = 1"
	else:
		if filters.buying_selling == "Selling":
			buying_selling_cond = " and selling = 1"
		elif filters.buying_selling == "Buying":
			buying_selling_cond = " and buying = 1"
		else:
			buying_selling_cond = ""

	price_lists = []
	if filters.standard_price_list:
		price_lists.append(filters.standard_price_list)

	if filters.customer:
		filters.selected_price_list = frappe.db.get_value("Customer", filters.customer, 'default_price_list')

	if filters.selected_price_list:
		price_lists.append(filters.selected_price_list)

	def get_additional_price_lists():
		res = []
		for i in range(3):
			if filters.get('price_list_' + str(i+1)):
				res.append(filters.get('price_list_' + str(i+1)))
		return res

	additional_price_lists = get_additional_price_lists()
	if additional_price_lists:
		price_lists += additional_price_lists

	if not additional_price_lists and not filters.selected_price_list:
		price_lists += frappe.db.sql_list(
			"select name from `tabPrice List` where exclude_from_lc_based_prices_report = 0 {0} {1}"
				.format(price_list_filter_cond, buying_selling_cond))

	return price_lists, filters.selected_price_list


def get_item_conditions(filters, use_doc_name):
	conditions = []

	if filters.get("item_code"):
		conditions.append("item.{} = %(item_code)s".format("name" if use_doc_name else "item_code"))
	else:
		if filters.get("brand"):
			conditions.append("item.brand=%(brand)s")
		if filters.get("item_group"):
			conditions.append(get_item_group_condition(filters.get("item_group")))

	if filters.get("item_groups_excluded"):
		conditions.append("item.item_group not in ({})".format(", ".join([frappe.db.escape(d) for d in filters.get("item_groups_excluded")])))

	if use_doc_name and filters.get("filter_items_without_print"):
		conditions.append("item.print_in_price_list = 1")

	return " and " + " and ".join(conditions) if conditions else ""


def get_po_conditions(filters):
	po_conditions = []
	if filters.get('po_from_date'):
		po_conditions.append("po.schedule_date >= %(po_from_date)s")
	if filters.get('po_to_date'):
		po_conditions.append("po.schedule_date <= %(po_to_date)s")
	return "and {0}".format(" and ".join(po_conditions)) if po_conditions else ""


def get_columns(filters, price_lists):
	columns = [
		{"fieldname": "item_code", "label": _("Item Code"), "fieldtype": "Link", "options": "Item", "width": 80,
			"price_list_note": frappe.db.get_single_value("Stock Settings", "price_list_note")},
		{"fieldname": "item_name", "label": _("Item Name"), "fieldtype": "Data", "width": 150},
		{"fieldname": "print_in_price_list", "label": _("Print"), "fieldtype": "Check", "width": 50, "editable": True},
		{"fieldname": "uom", "label": _("UOM"), "fieldtype": "Data", "width": 50},
		{"fieldname": "alt_uom_size", "label": _("Per Unit"), "fieldtype": "Float", "width": 68},
		# {"fieldname": "item_group", "label": _("Item Group"), "fieldtype": "Link", "options": "Item Group", "width": 120},
		{"fieldname": "po_qty", "label": _("PO Qty"), "fieldtype": "Float", "width": 70, "restricted": True},
		{"fieldname": "po_lc_rate", "label": _("PO LC"), "fieldtype": "Currency", "width": 70, "restricted": True},
		{"fieldname": "actual_qty", "label": _("Stock Qty"), "fieldtype": "Float", "width": 80, "restricted": True},
		{"fieldname": "valuation_rate", "label": _("Stock LC"), "fieldtype": "Currency", "width": 70, "restricted": True},
		{"fieldname": "projected_qty", "label": _("Total Qty"), "fieldtype": "Float", "width": 80, "restricted": True},
		{"fieldname": "avg_lc_rate", "label": _("Avg LC"), "fieldtype": "Currency", "width": 70, "restricted": True},
	]

	if filters.standard_price_list:
		columns += [
			{"fieldname": "standard_rate", "label": _("Base Price"), "fieldtype": "Currency", "width": 80,
				"editable": True, "price_list": filters.standard_price_list, "is_base_price": True, "restricted": True},
			{"fieldname": "margin_rate", "label": _("% Margin"), "fieldtype": "Percent", "width": 80, "restricted": True},
		]

	for price_list in sorted(price_lists):
		if price_list != filters.standard_price_list:
			if filters.standard_price_list and not frappe.get_cached_value("Price List", price_list, 'prices_independent_of_base_price'):
				columns.append({
					"fieldname": "rate_diff_" + scrub(price_list),
					"label": "+/-",
					"fieldtype": "Currency",
					"width": 40,
					"editable": True,
					"price_list": price_list,
					"is_diff": True,
					"restricted": True
				})
			columns.append({
				"fieldname": "rate_" + scrub(price_list),
				"label": price_list,
				"fieldtype": "Currency",
				"width": 70,
				"editable": True,
				"price_list": price_list,
			})

	show_amounts_role = frappe.db.get_single_value("Stock Settings", "restrict_amounts_in_report_to_role")
	show_amounts = show_amounts_role and show_amounts_role in frappe.get_roles()
	if not show_amounts:
		columns = list(filter(lambda d: not d.get('restricted'), columns))
		for c in columns:
			if c.get('editable'):
				del c['editable']

	return columns

@frappe.whitelist()
def set_item_pl_rate(effective_date, item_code, price_list, price_list_rate, is_diff=False, uom=None, conversion_factor=None, filters=None, base_price_list=False):
	effective_date = getdate(effective_date)
	standard_price_list = frappe.db.get_single_value("Selling Settings", "base_price_list")

	if not price_list and base_price_list:
		price_list = standard_price_list

	old_standard_rate = frappe.db.sql_list("""
		select price_list_rate
		from `tabItem Price`
		where price_list = %s and item_code = %s
			and %s between ifnull(valid_from, '2000-01-01') and ifnull(valid_upto, '2500-12-31')
		order by datediff(%s, valid_from)
		limit 1
	""", [standard_price_list, item_code, effective_date, effective_date])

	if cint(is_diff):
		if not old_standard_rate:
			frappe.throw(_("Could not find Base Price for item {0}").format(item_code))
		else:
			price_list_rate = flt(old_standard_rate[0]) + flt(price_list_rate)

	dependent_item_prices = []
	if price_list == standard_price_list and old_standard_rate:
		dependent_item_prices = frappe.db.sql("""
			select p.price_list, p.price_list_rate - %s as diff, p.uom
			from `tabItem Price` p
			inner join `tabPrice List` pl on pl.name = p.price_list and pl.enabled = 1 and pl.selling = 1
			where p.item_code = %s and p.price_list != %s and pl.prices_independent_of_base_price != 1
				and %s between ifnull(valid_from, '2000-01-01') and ifnull(valid_upto, '2500-12-31')
		""", [old_standard_rate[0], item_code, price_list, effective_date], as_dict=1)

	_set_item_pl_rate(effective_date, item_code, price_list, price_list_rate, uom, conversion_factor)

	dependent_item_prices_by_price_list = {}
	for d in dependent_item_prices:
		dependent_item_prices_by_price_list.setdefault(d.price_list, []).append(d)

	for price_list in dependent_item_prices_by_price_list:
		dependent_item_prices_by_price_list[price_list] = sorted(dependent_item_prices_by_price_list[price_list],
			key=lambda d: (cstr(d.uom) == cstr(uom), bool(d.uom)), reverse=True)

	dependent_price_list_visited = set()
	for item_prices in dependent_item_prices_by_price_list.values():
		for d in item_prices:
			if d.price_list not in dependent_price_list_visited:
				dependent_price_list_visited.add(d.price_list)
				_set_item_pl_rate(effective_date, item_code, d.price_list, flt(price_list_rate) + flt(d.diff), uom, conversion_factor)

	if not filters:
		filters = {}
	if isinstance(filters, string_types):
		filters = json.loads(filters)
	filters['item_code'] = item_code
	return execute(filters)


@frappe.whitelist()
def set_multiple_item_pl_rate(effective_date, price_list, items):
	if isinstance(items, string_types):
		items = json.loads(items)

	for item in items:
		_set_item_pl_rate(effective_date, item.get('item_code'), price_list,
			item.get('price_list_rate'), item.get('uom'), item.get('conversion_factor'))


def _set_item_pl_rate(effective_date, item_code, price_list, price_list_rate, uom=None, conversion_factor=None):
	from frappe.model.utils import get_fetch_values
	from erpnext.stock.get_item_details import get_item_price

	if not item_code:
		frappe.throw(_("Item Code not provided to update price"))

	if not price_list:
		frappe.throw(_("Price List not provided to update price"))

	if not price_list_rate:
		frappe.msgprint(_("Rate for Item {0} is 0 in Price List {1}. Please confirm rate").format(item_code, price_list))

	effective_date = getdate(effective_date)
	item_price_args = {
		"item_code": item_code,
		"price_list": price_list,
		"uom": uom,
		"min_qty": 0,
		"transaction_date": effective_date,
	}
	current_effective_item_price = get_item_price(item_price_args, item_code)
	current_effective_item_price = current_effective_item_price[0] if current_effective_item_price else None

	existing_item_price = past_item_price = None
	if current_effective_item_price and getdate(current_effective_item_price[3]) == effective_date:
		existing_item_price = current_effective_item_price
	else:
		past_item_price = current_effective_item_price

	item_price_args['period'] = 'future'
	future_item_price = get_item_price(item_price_args, item_code)
	future_item_price = future_item_price[0] if future_item_price else None

	# Update or add item price
	if existing_item_price:
		doc = frappe.get_doc("Item Price", existing_item_price[0])
		doc.price_list_rate = convert_item_uom_for(price_list_rate, item_code, uom, doc.uom, conversion_factor)
	else:
		doc = frappe.new_doc("Item Price")
		doc.item_code = item_code
		doc.price_list = price_list
		doc.uom = uom
		doc.price_list_rate = flt(price_list_rate)
		doc.update(get_fetch_values("Item Price", 'item_code', item_code))
		doc.update(get_fetch_values("Item Price", 'price_list', price_list))

	doc.valid_from = effective_date
	if future_item_price:
		doc.valid_upto = frappe.utils.add_days(future_item_price[3], -1)
	doc.save()

	# Update previous item price
	before_effective_date = frappe.utils.add_days(effective_date, -1)
	if past_item_price and past_item_price[4] != before_effective_date:
		frappe.set_value("Item Price", past_item_price[0], 'valid_upto', before_effective_date)

	frappe.msgprint(_("Price updated for Item {0} in Price List {1}").format(item_code, price_list), alert=1)
