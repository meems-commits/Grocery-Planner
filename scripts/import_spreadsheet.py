#!/usr/bin/env python3
"""Convert the household grocery comparison workbook (grocery_delivery_comparison*.xlsx)
into a Grocery Planner backup (.json) that the app can load via
Settings -> Import backup.

    python3 scripts/import_spreadsheet.py path/to/workbook.xlsx -o grocery-planner-import.json --member wf

Sheets read: Cart Comparison, Giant Matches, Giant Receipts, Whole Foods Receipts.
Requires: openpyxl
"""
import argparse
import base64
import json
import random
import re
import string
import sys

import openpyxl

WF_CART_DATE = "2026-11-23"


def uid():
    return "".join(random.choices(string.ascii_lowercase + string.digits, k=12))


def num(v):
    if v is None or v == "":
        return None
    try:
        return float(v)
    except (TypeError, ValueError):
        m = re.search(r"-?\d+(\.\d+)?", str(v))
        return float(m.group()) if m else None


def unit_of(u):
    u = (u or "").strip().lower()
    return {"each": "ea", "": "ea", "ct": "ct", "oz": "oz", "lb": "lb", "fl oz": "fl oz"}.get(u, u or "ea")


CATEGORY_WORDS = [
    ("Baby", ["baby", "toddler", "pouch"]),
    ("Household", ["soap", "detergent"]),
    ("Meat & Seafood", ["chicken", "pork", "beef", "turkey", "salmon"]),
    ("Dairy & Eggs", ["cheese", "butter", "yogurt", "eggs", "milk", "mayonnaise"]),
    ("Cereal & Breakfast", ["cereal", "oats", "cheerios", "o's", "pancake", "flapjack"]),
    ("Snacks", ["cups", "wafer", "snack", "chocolate"]),
    ("Frozen", ["frozen"]),
    ("Bakery", ["bread", "sourdough", "loaf"]),
    ("Produce", ["banana", "apple", "pear", "plum", "avocado", "potato", "onion", "spinach", "clementine",
                 "beet", "squash", "blueberr", "raspberr", "carrot"]),
    ("Pantry", ["beans", "peanut butter", "tomatoes", "sugar", "flour", "starch", "pumpkin", "canned", "protein",
                "paprika", "broth", "cinnamon", "tofu", "peach", "mandarin"]),
]


def category_of(name, hint=None):
    n = name.lower()
    for cat, words in CATEGORY_WORDS:
        if any(w in n for w in words):
            return cat
    return {"Produce": "Produce", "Meat": "Meat & Seafood", "Dairy": "Dairy & Eggs", "Dairy alt": "Dairy & Eggs",
            "Pantry": "Pantry", "Household": "Household", "Bakery": "Bakery", "Baby": "Baby",
            "Snacks": "Snacks", "Frozen": "Frozen"}.get(hint or "", "Other")


def size_from_name(name):
    """'Organic Raspberries, 6 oz' -> (6, 'oz')"""
    m = re.search(r"(\d+(?:\.\d+)?)\s*(fl oz|oz|lb|ct|pint)\b", name, re.I)
    if not m:
        return None, None
    q, u = float(m.group(1)), m.group(2).lower()
    if u == "pint":
        return q * 16, "fl oz"
    return q, u


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("xlsx")
    ap.add_argument("-o", "--out", default="grocery-planner-import.json")
    ap.add_argument("--member", action="append", default=[], choices=["wf", "aldi", "giant"],
                    help="store where you have a delivery membership (repeatable)")
    ap.add_argument("--link", metavar="APP_URL",
                    help="also print a setup link (APP_URL#import=...) that loads the data when opened; "
                         "the data rides in the URL fragment, which is never sent to the server")
    a = ap.parse_args()

    wb = openpyxl.load_workbook(a.xlsx, data_only=True)
    cart = wb["Cart Comparison"]

    stores = [
        {"id": "wf", "name": "Whole Foods", "color": "#00674b", "enabled": True,
         "deliveryFee": 9.95, "serviceFeePct": 0, "deliveryMarkupPct": 0, "freeDeliveryOver": 0,
         "pickupFee": 0, "tipFlat": 0, "minOrder": 0, "membership": False, "membershipMin": 25,
         "membershipMonthly": 9.99,
         "notes": "Grocery delivery subscription: $9.99/month for unlimited free delivery on orders $25+. Without it, $9.95 per delivery with Prime. Pickup free."},
        {"id": "aldi", "name": "Aldi", "color": "#00448f", "enabled": True,
         "deliveryFee": 3.99, "serviceFeePct": 5, "deliveryMarkupPct": 15, "freeDeliveryOver": 0,
         "pickupFee": 1.99, "tipFlat": 0, "minOrder": 35, "membership": False, "membershipMin": 35,
         "notes": "Via Instacart: delivery from $3.99 on $35+, ~5% service fee, app prices ~12-17% above in-store. Pickup $1.99 on $35+."},
        {"id": "giant", "name": "Giant", "color": "#e4002b", "enabled": True,
         "deliveryFee": 7.95, "serviceFeePct": 0, "deliveryMarkupPct": 0, "freeDeliveryOver": 0,
         "pickupFee": 0, "tipFlat": 7, "minOrder": 60, "membership": False, "membershipMin": 0,
         "notes": "Delivery $7.95, $60 minimum, you tip $7/order. Delivery markup unconfirmed."},
    ]

    for st in stores:
        st["membership"] = st["id"] in a.member

    items, prices = [], []
    by_giant_name = {}  # Giant decoded product name -> item

    def add_price(item, store, price, qty, unit, date, **extra):
        if price is None or price <= 0:
            return
        prices.append({"id": uid(), "itemId": item["id"], "storeId": store, "price": round(price, 4),
                       "qty": qty or 1, "unit": unit, "date": date, "sale": False, "source": "spreadsheet", **extra})

    # --- Giant Matches: link + match quality per row
    gm = wb["Giant Matches"]
    giant_match = {}
    for r in range(5, gm.max_row + 1):
        wf_item = gm.cell(r, 1).value
        if wf_item:
            giant_match[wf_item.strip()] = {
                "product": gm.cell(r, 2).value, "match": gm.cell(r, 4).value,
                "comment": gm.cell(r, 5).value, "link": gm.cell(r, 6).value,
            }

    # --- Cart Comparison rows
    for r in range(5, cart.max_row + 1):
        name = cart.cell(r, 1).value
        if not name or str(name).startswith("Items subtotal"):
            if name and str(name).startswith("Items subtotal"):
                break
            continue
        name = str(name).strip()
        qty = num(cart.cell(r, 2).value) or 1
        kind = cart.cell(r, 3).value  # Staple / Brand-locked
        freq = cart.cell(r, 4).value
        wf_brand = cart.cell(r, 5).value
        wf_size = num(cart.cell(r, 6).value)
        unit = unit_of(cart.cell(r, 7).value)
        wf_total = num(cart.cell(r, 8).value)
        giant_prod = cart.cell(r, 14).value
        giant_size = num(cart.cell(r, 15).value)
        giant_total = num(cart.cell(r, 16).value)
        notes = cart.cell(r, 18).value or ""

        item = {"id": uid(), "name": name, "category": category_of(name), "unit": unit,
                "brandLocked": kind == "Brand-locked", "frequency": (freq or "").lower() or None,
                "notes": notes, "products": {}, "links": {}}
        if wf_brand:
            item["products"]["wf"] = wf_brand
        gmatch = giant_match.get(name)
        if gmatch and gmatch["product"] and gmatch["product"] != "(not selected)":
            item["products"]["giant"] = gmatch["product"]
            if gmatch["link"]:
                item["links"]["giant"] = gmatch["link"]
            if gmatch["match"] and gmatch["match"] != "Giant-sourced":
                item["match"] = {"giant": gmatch["match"]}
        if giant_prod:
            by_giant_name[str(giant_prod).strip().lower()] = item
        items.append(item)

        prime = "Prime price" in notes
        if wf_total is not None and (wf_size or unit != "lb"):
            add_price(item, "wf", wf_total / qty, wf_size or 1, unit, WF_CART_DATE, memberOnly=prime,
                      note=("Prime price" if prime else None))
            reg = re.search(r"regular \$(\d+\.\d+)", notes)
            if prime and reg and unit != "lb":
                # Prime-only price: treat as a sale that lapses after a week; keep the regular price too
                prices[-1].update(sale=True, saleEnds="2026-11-30")
                add_price(item, "wf", float(reg.group(1)), wf_size or 1, unit, WF_CART_DATE, note="regular (non-Prime)")
        if giant_total is not None and giant_size and unit != "lb":
            add_price(item, "giant", giant_total / qty, giant_size, unit, "2026-11-24")

    # --- Giant receipts: real shelf prices (by-weight produce as $/lb; bonus buys as sale)
    gr = wb["Giant Receipts"]
    for r in range(5, gr.max_row + 1):
        date = gr.cell(r, 1).value
        decoded = gr.cell(r, 4).value
        if not decoded or not date or str(date).startswith("Totals"):
            continue
        date = date.strftime("%Y-%m-%d") if hasattr(date, "strftime") else str(date)[:10]
        weight, per_lb = num(gr.cell(r, 5).value), num(gr.cell(r, 6).value)
        regular, bonus, paid = num(gr.cell(r, 7).value), num(gr.cell(r, 8).value) or 0, num(gr.cell(r, 9).value)
        key = str(decoded).strip().lower()
        item = by_giant_name.get(key) or next((i for k, i in by_giant_name.items() if k.startswith(key) or key.startswith(k)), None)
        if item is None and "banana" in key:
            item = next((i for i in items if i["name"].lower().startswith("banana")), None)
        if item is None:
            continue
        if weight and per_lb:
            already = any(p for p in prices if p["itemId"] == item["id"] and p["storeId"] == "giant")
            if already:
                continue
            item["unit"] = "lb"
            sale_per_lb = (paid / weight) if bonus else None
            add_price(item, "giant", per_lb, 1, "lb", date, note=f"{weight} lb on receipt")
            if sale_per_lb and sale_per_lb < per_lb - 0.005:
                add_price(item, "giant", round(sale_per_lb, 2), 1, "lb", date, note="Bonus Buy")
                prices[-1].update(sale=True, saleEnds=date)
        else:
            # replace the cart-derived price with the receipt's regular + bonus-buy price
            prices[:] = [p for p in prices if not (p["itemId"] == item["id"] and p["storeId"] == "giant")]
            q, u = size_from_name(str(decoded))
            unit = u or item["unit"]
            if u and item["unit"] == "ea":
                item["unit"] = u
            add_price(item, "giant", regular, q or 1, unit, date)
            if bonus:
                add_price(item, "giant", paid, q or 1, unit, date, note="Bonus Buy")
                prices[-1].update(sale=True, saleEnds=date)

    # --- Whole Foods receipts: $/lb for weighed produce, and items not on the cart list
    wr = wb["Whole Foods Receipts"]

    def find_item(name):
        n = name.lower()
        keys = [("banana", "banana"), ("bartlett pear", "pear, bartlett"), ("red plum", "plums"),
                ("sweet potato", "sweet potato"), ("chicken thigh", "chicken thighs, boneless skinless"),
                ("avocado", "avocado"), ("oatly", "oat milk"), ("cheerios", "cheerios")]
        for k, target in keys:
            if k in n:
                cands = [i for i in items if target in i["name"].lower()]
                if "365" in n and target.startswith("chicken"):
                    cands = [i for i in cands if i["name"].lower() == "chicken thighs, boneless skinless"]
                return cands[0] if cands else None
        return None

    sections = [(5, "2026-11-20", True), (39, WF_CART_DATE, False)]  # receipt 1 lines start row 5; receipt 2 row 39
    for start, date, add_new in sections:
        for r in range(start, wr.max_row + 1):
            name = wr.cell(r, 1).value
            if not name or str(name).startswith("Items subtotal"):
                break
            name = str(name).strip()
            cat = wr.cell(r, 2).value
            q = num(wr.cell(r, 3).value) or 1
            weight, per_lb = num(wr.cell(r, 4).value), num(wr.cell(r, 5).value)
            net = num(wr.cell(r, 8).value)
            note = (wr.cell(r, 10).value or "") if start == 5 else ""
            item = find_item(name)
            if item:
                if weight and per_lb and item["unit"] == "lb":
                    prices[:] = [p for p in prices if not (p["itemId"] == item["id"] and p["storeId"] == "wf" and p["unit"] == "lb" and p.get("note") != "receipt")]
                    add_price(item, "wf", per_lb, 1, "lb", date, note="receipt")
                continue
            if not add_new or note.startswith(("MATCH", "Close")) or not net:
                continue
            clean = re.sub(r",?\s*1 Each$", "", name).replace(" Conventional", "")
            size_q, size_u = size_from_name(clean)
            if weight and per_lb:
                unit, price, qty = "lb", per_lb, 1
            elif size_q:
                unit, price, qty = size_u, net / q, size_q
            else:
                unit, price, qty = "ea", net / q, 1
            it = {"id": uid(), "name": clean, "category": category_of(clean, cat), "unit": unit,
                  "brandLocked": False, "frequency": None, "notes": "", "products": {"wf": clean}, "links": {}}
            items.append(it)
            add_price(it, "wf", price, qty, unit, date, note="receipt")

    # drop duplicate observations (same store, price and size) keeping the latest
    seen, deduped = set(), []
    for pr in sorted(prices, key=lambda x: x["date"], reverse=True):
        k = (pr["itemId"], pr["storeId"], round(pr["price"], 2), pr["qty"], pr["unit"], pr["sale"])
        if k not in seen:
            seen.add(k)
            deduped.append(pr)
    prices[:] = deduped

    for i in items:
        if not i["products"]:
            del i["products"]
        if not i["links"]:
            del i["links"]
    for p in prices:
        if p.get("note") is None:
            p.pop("note", None)

    state = {
        "version": 1,
        "stores": stores,
        "items": items,
        "prices": prices,
        "pantry": [], "recipes": [], "list": [], "deals": [],
        "settings": {"apiKey": "", "zip": "", "mode": "store", "extraStopCost": 3, "tip": 0, "ordersPerMonth": 4},
    }
    with open(a.out, "w") as f:
        json.dump(state, f, indent=1)
    if a.link:
        comp = __import__("zlib").compressobj(9, __import__("zlib").DEFLATED, -15)
        raw = comp.compress(json.dumps(state, separators=(",", ":")).encode()) + comp.flush()
        print(a.link.split("#")[0] + "#import=" + base64.urlsafe_b64encode(raw).decode().rstrip("="))
    multi = sum(1 for i in items if len({p["storeId"] for p in prices if p["itemId"] == i["id"]}) > 1)
    print(f"{len(items)} items, {len(prices)} prices, {multi} items priced at 2+ stores -> {a.out}", file=sys.stderr)


if __name__ == "__main__":
    main()
