// CSV import so an existing Excel price sheet can be brought over.
import { uid, today, ensureItem, storeByName, CATEGORIES, categorize } from './store.js';
import { normUnit } from './units.js';

export function parseCSV(text) {
  const rows = [];
  let row = [], cell = '', q = false;
  const t = String(text).replace(/\r\n?/g, '\n');
  for (let i = 0; i < t.length; i++) {
    const ch = t[i];
    if (q) {
      if (ch === '"' && t[i + 1] === '"') { cell += '"'; i++; }
      else if (ch === '"') q = false;
      else cell += ch;
    } else if (ch === '"') q = true;
    else if (ch === ',' || ch === '\t') { row.push(cell); cell = ''; }
    else if (ch === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; }
    else cell += ch;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  return rows.filter((r) => r.some((c) => c.trim()));
}

const num = (v) => {
  const n = parseFloat(String(v ?? '').replace(/[$,\s]/g, ''));
  return isNaN(n) ? null : n;
};

function toDate(v) {
  if (!v) return today();
  const d = new Date(v);
  return isNaN(d) ? today() : d.toISOString().slice(0, 10);
}

const HEADER = {
  item: ['item', 'name', 'product', 'description', 'grocery'],
  store: ['store', 'shop', 'retailer', 'where'],
  price: ['price', 'cost', 'amount', 'paid'],
  qty: ['qty', 'quantity', 'size', 'amount size', 'pack size'],
  unit: ['unit', 'units', 'uom'],
  date: ['date', 'purchased', 'day'],
  category: ['category', 'aisle', 'type', 'department'],
  sale: ['sale', 'on sale', 'promo'],
};

/** Mutates state `s`. Accepts long format (one price per row) or wide format (one column per store). */
export function importPriceRows(s, rows) {
  if (!rows.length) return { items: 0, prices: 0, skipped: 0 };
  const head = rows[0].map((h) => h.trim().toLowerCase());
  const col = {};
  for (const [k, names] of Object.entries(HEADER)) {
    const i = head.findIndex((h) => names.includes(h));
    if (i >= 0) col[k] = i;
  }
  if (col.item == null) col.item = 0;
  // wide format: any header that names a known store
  const storeCols = head
    .map((h, i) => ({ i, store: Object.values(col).includes(i) ? null : storeByName(s, h) }))
    .filter((x) => x.store);

  const touched = new Set();
  let prices = 0, skipped = 0;
  for (const r of rows.slice(1)) {
    const name = (r[col.item] || '').trim();
    if (!name) { skipped++; continue; }
    const unit = normUnit(col.unit != null ? r[col.unit] : 'ea');
    const qty = (col.qty != null && num(r[col.qty])) || 1;
    const catRaw = col.category != null ? r[col.category]?.trim() : '';
    const category = CATEGORIES.find((c) => c.toLowerCase() === (catRaw || '').toLowerCase()) || categorize(name, catRaw);
    const date = toDate(col.date != null ? r[col.date] : '');
    const sale = col.sale != null && /^(y|yes|true|1|x|sale)$/i.test((r[col.sale] || '').trim());
    const pairs = [];
    if (col.store != null && col.price != null) {
      const st = storeByName(s, r[col.store]);
      const p = num(r[col.price]);
      if (st && p != null) pairs.push([st, p]);
    }
    for (const sc of storeCols) {
      const p = num(r[sc.i]);
      if (p != null) pairs.push([sc.store, p]);
    }
    if (!pairs.length) { skipped++; continue; }
    const it = ensureItem(s, { name, category, unit });
    touched.add(it.id);
    for (const [st, p] of pairs) {
      s.prices.push({ id: uid(), itemId: it.id, storeId: st.id, price: p, qty, unit, date, sale, source: 'import' });
      prices++;
    }
  }
  return { items: touched.size, prices, skipped };
}
