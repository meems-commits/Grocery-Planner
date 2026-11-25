import { getState, update, subscribe, replaceState, uid, today, CATEGORIES, itemById, storeById, searchItems, ensureItem, findItem, storeByName, sampleData } from './store.js';
import { optimizeList, compareItem, bestPriceAt, recipeCoverage, ageDays, isSaleActive, showdown } from './optimize.js';
import { UNIT_OPTIONS, normUnit, fmtQty, unitPrice } from './units.js';
import { parseCSV, importPriceRows } from './csv.js';

// ai.js pulls in the SDK bundle; load it only when an AI feature is used.
const ai = () => import('./ai.js');

const $ = (sel, root = document) => root.querySelector(sel);
const view = $('#view');
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const money = (n) => (n == null || isNaN(n) ? '—' : '$' + Number(n).toFixed(2));
const perUnit = (n, unit) => (n == null ? '—' : `${money(n)}/${unit}`);
const ago = (d) => {
  const n = ageDays(d);
  if (n == null) return '';
  if (n <= 0) return 'today';
  if (n === 1) return 'yesterday';
  if (n < 14) return `${n}d ago`;
  if (n < 60) return `${Math.round(n / 7)}wk ago`;
  return `${Math.round(n / 30)}mo ago`;
};
const storeDot = (s) => `<span class="dot" style="background:${esc(s?.color || '#999')}"></span>`;

let tab = localStorage.getItem('gp-tab') || 'list';
let kitchenTab = 'pantry';
let receiptDraft = null; // parsed receipt awaiting review
let busy = null; // {label}

function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => (t.hidden = true), 2600);
}

// ------------------------------------------------------------------ sheet
function openSheet(html) {
  $('#sheetBody').innerHTML = html;
  $('#sheet').hidden = false;
}
function closeSheet() {
  $('#sheet').hidden = true;
  $('#sheetBody').innerHTML = '';
  sheetRenderer = null;
}
let sheetRenderer = null;
function sheet(fn) {
  sheetRenderer = fn;
  openSheet(fn());
}
function refreshSheet() {
  if (sheetRenderer && !$('#sheet').hidden) $('#sheetBody').innerHTML = sheetRenderer();
}

// ------------------------------------------------------------------ render
function render() {
  document.querySelectorAll('#tabbar button').forEach((b) => b.classList.toggle('active', b.dataset.tab === tab));
  const r = { list: renderList, prices: renderPrices, scan: renderScan, deals: renderDeals, kitchen: renderKitchen }[tab] || renderList;
  view.innerHTML = r();
  if (!quietSheet) refreshSheet();
}
// Edits made inside a sheet shouldn't rebuild it (that would steal focus mid-form).
let quietSheet = false;
subscribe(render);

function itemPicker(id, placeholder) {
  return `<div class="picker"><input type="search" data-picker="${id}" placeholder="${esc(placeholder)}" autocomplete="off" enterkeyhint="done"><div class="suggest" data-suggest="${id}" hidden></div></div>`;
}

function fillSuggest(input) {
  const id = input.dataset.picker;
  const box = document.querySelector(`[data-suggest="${id}"]`);
  const q = input.value.trim();
  if (!q) { box.hidden = true; return; }
  const matches = searchItems(q).slice(0, 6);
  const exact = findItem(q);
  box.innerHTML =
    matches.map((i) => `<button data-action="pick" data-picker="${id}" data-item="${i.id}">${esc(i.name)} <span class="muted small">${esc(i.category)}</span></button>`).join('') +
    (exact ? '' : `<button data-action="pick" data-picker="${id}" data-new="${esc(q)}">+ Add “${esc(q)}”</button>`);
  box.hidden = false;
}

// ------------------------------------------------------------------ LIST
function renderList() {
  const s = getState();
  const mode = s.settings.mode || 'store';
  const opt = optimizeList({ list: s.list, items: s.items, stores: s.stores, prices: s.prices, mode, settings: s.settings });
  const checked = s.list.filter((e) => e.checked);
  const activeCount = s.list.length - checked.length;

  let html = `
    <div class="seg">
      <button data-action="mode" data-mode="store" class="${mode === 'store' ? 'on' : ''}">🛒 In store</button>
      <button data-action="mode" data-mode="pickup" class="${mode === 'pickup' ? 'on' : ''}">🚗 Pickup</button>
      <button data-action="mode" data-mode="delivery" class="${mode === 'delivery' ? 'on' : ''}">🚚 Delivery</button>
    </div>
    ${itemPicker('list', 'Add to list… (e.g. Cheerios)')}
    ${s.items.some((i) => i.frequency === 'weekly' && !s.list.some((e) => e.itemId === i.id && !e.checked)) ? `<button class="btn sm" style="margin-top:8px" data-action="addStaples">+ Add weekly staples</button>` : ''}`;

  if (!s.list.length) {
    html += `<div class="empty"><p>Your list is empty.</p>${s.items.length ? '' : `<p class="small">New here? Load sample data to see how it works, or scan a receipt to start building your price book.</p><button class="btn" data-action="sample">Load sample data</button>`}</div>`;
    return html;
  }

  if (opt.plan.groups.length) {
    const stops = opt.plan.groups.length;
    const online = mode !== 'store';
    html += `<div class="card" style="margin-top:12px">
      <div class="row between"><div><div class="muted small">Cheapest plan · ${stops} ${online ? (stops > 1 ? 'orders' : 'order') : stops > 1 ? 'stops' : 'stop'}</div><div class="big money">${money(opt.plan.total)}</div></div>
      <div class="right small muted">${activeCount} item${activeCount === 1 ? '' : 's'}${opt.unpriced.length ? `<br>${opt.unpriced.length} without prices` : ''}</div></div>
      ${opt.savingsVsSingle > 0.005 && stops > 1 ? `<div class="savings">Saves ${money(opt.savingsVsSingle)} vs. all at ${esc(opt.bestSingle.store.name)}</div>` : ''}
      ${stops === 1 && opt.singles.length > 1 ? `<div class="savings">One ${online ? 'order' : 'stop'} is cheapest once ${online ? 'fees and app markups' : 'your extra-trip cost'} are counted.</div>` : ''}
      ${opt.plan.belowMin ? `<div class="savings" style="background:var(--sale-soft);color:var(--sale)">Below a store's order minimum. Add items or switch stores.</div>` : ''}
    </div>`;

    for (const g of opt.plan.groups) {
      html += `<div class="card"><div class="row between"><div class="store-head">${storeDot(g.store)} ${esc(g.store.name)}</div><div class="money">${money(g.total)}</div></div><ul class="list">`;
      for (const l of g.lines) html += listLine(l.entry, l.item, l.cost, l.best, l.byStore, g.store);
      if (g.overhead > 0.005) html += `<li class="small muted"><span class="grow">${mode === 'delivery' ? 'Delivery, service fee & tip' : mode === 'pickup' ? 'Pickup fee' + (g.overhead > (Number(g.store.pickupFee) || 0) + 0.005 ? ' + extra stop' : '') : 'Extra stop (your trip cost)'}</span><span class="money">${money(g.overhead)}</span></li>`;
      if (g.belowMin) html += `<li class="small" style="color:var(--sale)">Under ${esc(g.store.name)}'s ${money(g.store.minOrder)} minimum</li>`;
      if (online && Number(g.store.deliveryMarkupPct)) html += `<li class="small muted">Prices include ~${esc(g.store.deliveryMarkupPct)}% app markup</li>`;
      html += `</ul></div>`;
    }

    if (opt.singles.length > 1) {
      html += `<div class="section-title">If you only use one store</div><div class="card"><ul class="list">`;
      for (const x of opt.singles) {
        html += `<li><span class="row grow">${storeDot(x.store)} ${esc(x.store.name)}</span>
          <span class="right">${x.missingCount && x.total > 0 ? `<span class="pill warn">${x.missingCount} unpriced</span> ` : ''}${x.belowMin ? `<span class="pill warn">under min.</span> ` : ''}${x.total > 0 ? `<span class="money">${money(x.total)}</span>` : '<span class="muted small">no prices yet</span>'}</span></li>`;
      }
      html += `</ul><p class="small muted" style="margin:6px 0 0">${online ? 'Includes fees, tips and app markups from Settings.' : 'Based on your latest prices and current sales.'}</p></div>`;
    }
  }

  if (opt.unpriced.length) {
    html += `<div class="section-title">No prices yet</div><div class="card"><ul class="list">`;
    for (const c of opt.unpriced) html += listLine(c.entry, c.item, null, null);
    html += `</ul><p class="small muted" style="margin:6px 0 0">Tap an item to add a price, or scan a receipt.</p></div>`;
  }

  if (checked.length) {
    html += `<div class="section-title row between"><span>In the cart (${checked.length})</span></div><div class="card"><ul class="list">`;
    for (const e of checked) {
      const it = itemById(e.itemId);
      if (it) html += listLine(e, it, null, null);
    }
    html += `</ul><div class="btn-row" style="margin-top:8px"><button class="btn sm" data-action="checkedToPantry">Move to pantry</button><button class="btn sm danger" data-action="clearChecked">Clear</button></div></div>`;
  }
  return html;
}

function listLine(entry, item, cost, best, byStore, store) {
  let alt = '';
  if (byStore && store) {
    const others = Object.entries(byStore).filter(([id]) => id !== store.id).sort((a, b) => a[1].cost - b[1].cost);
    if (others.length) {
      const [oid, oc] = others[0];
      const diff = oc.cost - cost;
      alt = diff > 0.005 ? ` · ${money(diff)} more at ${esc(storeById(oid)?.name)}` : '';
    }
  }
  return `<li class="${entry.checked ? 'checked' : ''}">
    <button class="cbox ${entry.checked ? 'on' : ''}" data-action="toggle" data-id="${entry.id}" aria-label="Check off">${entry.checked ? '✓' : ''}</button>
    <button class="tap" data-action="editEntry" data-id="${entry.id}">
      <div class="name ellipsis">${esc(item.name)}</div>
      <div class="small muted ellipsis">${fmtQty(entry.qty || 1, entry.unit || item.unit)}${best ? ` · ${perUnit(best.perUnit, item.unit)}` : ''}${alt}</div>
    </button>
    <div class="right">${cost != null ? `<div class="money">${money(cost)}</div>` : ''}${best?.onSale ? '<span class="pill sale">Sale</span>' : ''}</div>
  </li>`;
}

function entrySheet(id) {
  sheet(() => {
    const s = getState();
    const e = s.list.find((x) => x.id === id);
    if (!e) return '<p>Removed.</p>';
    const it = itemById(e.itemId);
    return `<h2>${esc(it.name)}</h2>
      <div class="fields-2">
        <label class="field"><span>Quantity</span><input type="number" step="any" min="0" inputmode="decimal" value="${esc(e.qty)}" data-change="entryQty" data-id="${id}"></label>
        <label class="field"><span>Unit</span><select data-change="entryUnit" data-id="${id}">${UNIT_OPTIONS.map((u) => `<option ${normUnit(e.unit || it.unit) === u ? 'selected' : ''}>${u}</option>`).join('')}</select></label>
      </div>
      ${compareBlock(it)}
      <div class="btn-row" style="margin-top:12px">
        <button class="btn" data-action="itemDetail" data-item="${it.id}">Prices & history</button>
        <button class="btn danger" data-action="removeEntry" data-id="${id}">Remove</button>
      </div>`;
  });
}

function compareBlock(it) {
  const s = getState();
  const rows = compareItem(it, s.stores, s.prices);
  if (!rows.length) return `<div class="card"><p class="muted" style="margin:0">No prices yet.</p><button class="btn sm" style="margin-top:8px" data-action="addPrice" data-item="${it.id}">Add a price</button></div>`;
  const missing = s.stores.filter((st) => st.enabled !== false && !rows.find((r) => r.store.id === st.id));
  return `<div class="card"><h3>Price per ${esc(it.unit)}</h3>
    ${rows.map((r, i) => `<div class="compare-row">
        <div class="row">${storeDot(r.store)} <strong class="${i === 0 && rows.length > 1 ? 'winner' : ''}">${esc(r.store.name)}</strong> ${r.best.onSale ? '<span class="pill sale">Sale</span>' : ''} ${i === 0 && rows.length > 1 ? '<span class="pill good">Cheapest</span>' : ''}</div>
        <div class="money right ${i === 0 && rows.length > 1 ? 'winner' : ''}">${perUnit(r.best.perUnit, it.unit)}</div>
        <div class="small muted">${money(r.best.price)} for ${fmtQty(r.best.qty || 1, r.best.unit)} · ${ago(r.best.date)}${r.best.onSale && r.best.saleEnds ? ` · ends ${esc(r.best.saleEnds)}` : ''}${r.best.memberOnly ? ' · members' : ''}${r.best.note ? ` · ${esc(r.best.note)}` : ''}
          ${it.products?.[r.store.id] ? `<br>${esc(it.products[r.store.id])}` : ''}${it.match?.[r.store.id] && it.match[r.store.id] !== 'Exact' ? ` <span class="pill warn">${esc(it.match[r.store.id])} match</span>` : ''}${it.links?.[r.store.id] ? ` <a href="${esc(it.links[r.store.id])}" target="_blank" rel="noopener">view</a>` : ''}</div>
        <div class="small muted right">${r.best.onSale && r.best.regularPerUnit ? `reg ${perUnit(r.best.regularPerUnit, it.unit)}` : ''}</div>
      </div>`).join('')}
    ${rows.length > 1 ? `<p class="small" style="margin:8px 0 0">${esc(rows[0].store.name)} is ${Math.round((1 - rows[0].best.perUnit / rows[1].best.perUnit) * 100)}% cheaper than ${esc(rows[1].store.name)}.</p>` : ''}
    ${missing.length ? `<p class="small muted" style="margin:6px 0 0">No price yet at ${missing.map((m) => esc(m.name)).join(', ')}.</p><button class="btn sm" style="margin-top:6px" data-action="lookupOne" data-item="${it.id}">🔎 Look up online</button>` : ''}
    ${it.notes ? `<details style="margin-top:8px"><summary class="small">Notes</summary><p class="small muted" style="white-space:pre-wrap">${esc(it.notes)}</p></details>` : ''}
  </div>`;
}

// ------------------------------------------------------------------ PRICES
function renderShowdown() {
  const s = getState();
  const active = s.stores.filter((st) => st.enabled !== false);
  const sd = showdown(s.items, active, s.prices);
  const pct = (x) => `${Math.round(Math.abs(x) * 100)}%`;
  let html = '';

  // headline per pair of stores
  for (const p of sd.pairs) {
    const cheaper = p.ta <= p.tb ? p.a : p.b;
    const pricier = cheaper === p.a ? p.b : p.a;
    const lo = Math.min(p.ta, p.tb), hi = Math.max(p.ta, p.tb);
    html += `<div class="card">
      <div class="row between"><div class="store-head">${storeDot(p.a)} ${esc(p.a.name)} <span class="muted small">vs</span> ${storeDot(p.b)} ${esc(p.b.name)}</div><span class="small muted">${p.n} item${p.n === 1 ? '' : 's'}</span></div>
      <div class="vs-bar"><div style="flex:${p.aw || 0.001};background:${esc(p.a.color)}"></div><div style="flex:${Math.max(p.n - p.aw - p.bw, 0) || 0.001};background:var(--line)"></div><div style="flex:${p.bw || 0.001};background:${esc(p.b.color)}"></div></div>
      <div class="row between small"><span>${esc(p.a.name)} cheaper on <strong>${p.aw}</strong></span><span><strong>${p.bw}</strong> at ${esc(p.b.name)}</span></div>
      ${hi - lo > 0.005 ? `<div class="savings">Same items cost ${money(lo)} at ${esc(cheaper.name)} vs ${money(hi)} at ${esc(pricier.name)}: <strong>${pct((hi - lo) / hi)} less</strong></div>` : ''}
    </div>`;
  }
  const totalItems = sd.rows.length;
  html += `<div class="card"><div class="row between"><div><strong>${sd.compared.length}</strong> of ${totalItems} items have prices at 2+ stores</div></div>
    <div class="bar" style="margin:8px 0"><div style="width:${totalItems ? Math.round((sd.compared.length / totalItems) * 100) : 0}%"></div></div>
    <p class="small muted" style="margin:0 0 8px">More prices = a better answer. Scan receipts, or let Claude look up prices on store websites.</p>
    <button class="btn sm block" data-action="fillGaps">🔎 Fill in missing prices</button></div>`;

  html += `<div class="seg"><button data-action="sdf" data-k="compared" class="${showdownFilter === 'compared' ? 'on' : ''}">Compared (${sd.compared.length})</button><button data-action="sdf" data-k="missing" class="${showdownFilter === 'missing' ? 'on' : ''}">One store only (${sd.missing.length})</button></div>`;

  const rows = (showdownFilter === 'compared' ? sd.compared : sd.missing).slice();
  rows.sort((a, b) => (b.yearly || 0) - (a.yearly || 0) || (b.pctSaved || 0) - (a.pctSaved || 0) || a.item.name.localeCompare(b.item.name));
  if (!rows.length) return html + `<div class="empty">${showdownFilter === 'compared' ? 'No items priced at two stores yet.' : 'Every item is priced at 2+ stores.'}</div>`;
  html += `<div class="card sd-table"><div class="sd-head" style="grid-template-columns:repeat(${active.length},1fr)">${active.map((st) => `<div>${storeDot(st)} ${esc(st.name)}</div>`).join('')}</div>`;
  for (const r of rows) {
    html += `<button class="sd-row" data-action="itemDetail" data-item="${r.item.id}">
      <div class="row between"><span class="ellipsis grow">${esc(r.item.name)}</span>${r.compared && r.pctSaved > 0.005 ? `<span class="pill good">${pct(r.pctSaved)} less at ${esc(r.cheapest.name)}</span>` : ''}</div>
      <div class="sd-prices" style="grid-template-columns:repeat(${active.length},1fr)">${active.map((st) => {
        const b = r.byStore[st.id];
        if (!b) return `<div class="muted">—</div>`;
        const win = r.compared && r.cheapest.id === st.id;
        return `<div class="${win ? 'sd-win' : ''}">${perUnit(b.perUnit, r.item.unit)}${b.onSale ? ' <span class="pill sale">sale</span>' : ''}${r.item.match?.[st.id] && r.item.match[st.id] !== 'Exact' ? ' <span class="pill warn">≈</span>' : ''}</div>`;
      }).join('')}</div>
      ${r.yearly > 0.5 ? `<div class="small" style="color:var(--accent)">≈ ${money(r.yearly)}/yr at ${esc(r.item.frequency)} buying</div>` : ''}
    </button>`;
  }
  html += `</div><p class="small muted">≈ = substitute or close match, not identical. Prices are per unit so different sizes compare fairly.</p>`;
  return html;
}

function fillGapsSheet(onlyItemId) {
  const s = getState();
  const active = s.stores.filter((st) => st.enabled !== false);
  sheet(() => {
    const st = getState();
    if (lookup?.loading) return `<h2>Looking up prices</h2><div class="empty"><div class="spinner"></div><p>${esc(lookup.label || 'Searching store websites…')}</p><p class="small">About a minute.</p></div>`;
    if (lookup?.error) return `<h2>Look up prices</h2><p>${esc(lookup.error)}</p><button class="btn block" data-action="lookupReset">Back</button>`;
    if (lookup?.results) {
      const nf = lookup.results.filter((x) => x.found).length;
      return `<h2>Found ${nf} price${nf === 1 ? '' : 's'} at ${esc(storeById(lookup.storeId)?.name)}</h2>
        <p class="small muted">Check these against the store's app before relying on them.</p>
        ${lookup.results.map((x, i) => `<div class="card" style="${x.found ? '' : 'opacity:.55'}">
          <label class="check"><input type="checkbox" ${x.found ? 'checked' : 'disabled'} data-change="luPick" data-i="${i}"> <strong>${esc(x.item)}</strong></label>
          ${x.found ? `<div class="small">${esc(x.product)} · <span class="money">${money(x.price)}</span> for ${fmtQty(x.size_qty, x.size_unit)}${x.on_sale ? ' <span class="pill sale">Sale</span>' : ''} <span class="pill ${x.match === 'exact' ? 'good' : 'warn'}">${esc(x.match)}</span></div>
          <div class="small muted">${esc(x.note || '')} ${x.source_url ? `<a href="${esc(x.source_url)}" target="_blank" rel="noopener">source</a>` : ''}</div>` : `<div class="small muted">${esc(x.note || 'Not found')}</div>`}
        </div>`).join('')}
        <div class="btn-row"><button class="btn" data-action="lookupReset">Discard</button><button class="btn primary" data-action="lookupSave">Save checked</button></div>`;
    }
    const opts = active.map((x) => {
      const missing = st.items.filter((i) => (!onlyItemId || i.id === onlyItemId) && !st.prices.some((p) => p.itemId === i.id && p.storeId === x.id));
      return { store: x, missing };
    });
    return `<h2>Fill in missing prices</h2>
      <p class="small muted">Claude searches each store's website (and Instacart listings) for the items you don't have a price for yet${s.settings.zip ? ` near ${esc(s.settings.zip)}` : ''}. Up to 15 items per search, most-bought first.</p>
      ${opts.map((o) => `<div class="card row between"><div>${storeDot(o.store)} <strong>${esc(o.store.name)}</strong><div class="small muted">${o.missing.length} item${o.missing.length === 1 ? '' : 's'} missing</div></div>
        <button class="btn sm" data-action="lookupRun" data-store="${o.store.id}" data-only="${onlyItemId || ''}" ${o.missing.length ? '' : 'disabled'}>Search</button></div>`).join('')}
      ${s.settings.apiKey ? '' : '<p class="small" style="color:var(--warn)">Add your Anthropic API key in Settings first.</p>'}`;
  });
}

let lookup = null;
async function runLookup(storeId, onlyItemId) {
  const s = getState();
  const store = storeById(storeId);
  const freqRank = { weekly: 0, biweekly: 1, monthly: 2 };
  const missing = s.items
    .filter((i) => (!onlyItemId || i.id === onlyItemId) && !s.prices.some((p) => p.itemId === i.id && p.storeId === storeId))
    .sort((a, b) => (freqRank[a.frequency] ?? 9) - (freqRank[b.frequency] ?? 9) || (s.list.some((e) => e.itemId === b.id) - s.list.some((e) => e.itemId === a.id)))
    .slice(0, 15);
  lookup = { loading: true, storeId };
  refreshSheet();
  try {
    const { lookupPrices } = await ai();
    const r = await lookupPrices({
      storeName: store.name,
      zip: s.settings.zip,
      items: missing.map((i) => {
        const known = s.prices.filter((p) => p.itemId === i.id).sort((a, b) => (b.date || '').localeCompare(a.date || ''))[0];
        return { name: i.name, wanted: i.products?.[storeId] || null, link: i.links?.[storeId] || null, brandLocked: !!i.brandLocked,
          reference: known ? `${i.products?.[known.storeId] || ''} ${known.qty} ${known.unit}`.trim() : null };
      }),
      onStatus: (label) => { lookup = { ...lookup, label }; refreshSheet(); },
    });
    lookup = { storeId, results: r.results.map((x) => ({ ...x, keep: x.found })) };
  } catch (e) {
    lookup = { error: e.message };
  }
  refreshSheet();
}


let priceQuery = '';
let priceTab = 'showdown';
let showdownFilter = 'compared';
function renderPrices() {
  const s = getState();
  const seg = `<div class="seg"><button data-action="ptab" data-k="showdown" class="${priceTab === 'showdown' ? 'on' : ''}">Store showdown</button><button data-action="ptab" data-k="all" class="${priceTab === 'all' ? 'on' : ''}">All items</button></div>`;
  if (priceTab === 'showdown' && s.items.length) return seg + renderShowdown();
  const items = searchItems(priceQuery);
  let html = seg + `<input type="search" placeholder="Search items…" value="${esc(priceQuery)}" data-input="priceQuery" style="margin-bottom:10px">
    <div class="btn-row" style="margin-bottom:12px"><button class="btn sm" data-action="addPrice">+ Add price</button><button class="btn sm" data-action="importCsv">Import from spreadsheet</button></div>`;
  if (!s.items.length) {
    return html + `<div class="empty"><p>No prices yet. Scan a receipt, add prices by hand, or import your Excel sheet (save it as CSV).</p><button class="btn" data-action="sample">Load sample data</button></div>`;
  }
  const byCat = {};
  for (const it of items) (byCat[it.category || 'Other'] ||= []).push(it);
  for (const cat of CATEGORIES.filter((c) => byCat[c]).concat(Object.keys(byCat).filter((c) => !CATEGORIES.includes(c)))) {
    html += `<div class="section-title">${esc(cat)}</div><div class="card"><ul class="list">`;
    for (const it of byCat[cat]) {
      const rows = compareItem(it, s.stores, s.prices);
      const w = rows[0];
      const diff = rows.length > 1 ? Math.round((1 - rows[0].best.perUnit / rows[1].best.perUnit) * 100) : null;
      html += `<li><button class="tap" data-action="itemDetail" data-item="${it.id}">
          <div class="ellipsis">${esc(it.name)}</div>
          <div class="small muted row">${w ? `${storeDot(w.store)} ${rows.length > 1 ? `Cheapest at ${esc(w.store.name)}${diff > 0 ? ` (${diff}% less)` : ''}` : `Only priced at ${esc(w.store.name)}`}` : 'No prices'}</div>
        </button>
        <div class="right">${w ? `<div class="money">${perUnit(w.best.perUnit, it.unit)}</div>` : ''}${w?.best.onSale ? '<span class="pill sale">Sale</span>' : ''}</div></li>`;
    }
    html += `</ul></div>`;
  }
  return html;
}

function itemDetailSheet(itemId) {
  sheet(() => {
    const s = getState();
    const it = itemById(itemId);
    if (!it) return '<p>Deleted.</p>';
    const hist = s.prices.filter((p) => p.itemId === it.id).sort((a, b) => (b.date || '').localeCompare(a.date || ''));
    const inList = s.list.some((e) => e.itemId === it.id && !e.checked);
    return `<h2>${esc(it.name)}</h2>
      ${compareBlock(it)}
      <div class="btn-row"><button class="btn primary" data-action="addToList" data-item="${it.id}" ${inList ? 'disabled' : ''}>${inList ? 'On your list' : 'Add to list'}</button><button class="btn" data-action="addPrice" data-item="${it.id}">+ Price</button></div>
      <div class="section-title">Price history</div>
      <div class="card"><ul class="list">${hist.map((p) => `<li>
        <span class="grow"><span class="row">${storeDot(storeById(p.storeId))} ${esc(storeById(p.storeId)?.name || '?')} ${p.sale ? '<span class="pill sale">Sale</span>' : ''}</span>
        <span class="small muted">${esc(p.date)} · ${money(p.price)} / ${fmtQty(p.qty || 1, p.unit)} · ${esc(p.source || 'manual')}</span></span>
        <span class="money">${perUnit(unitPrice(p.price, p.qty, p.unit, it.unit), it.unit)}</span>
        <button class="btn sm" data-action="delPrice" data-id="${p.id}" aria-label="Delete price">✕</button></li>`).join('') || '<li class="muted">None</li>'}</ul></div>
      <details class="card"><summary>Edit item</summary>
        <label class="field"><span>Name</span><input type="text" value="${esc(it.name)}" data-change="itemName" data-item="${it.id}"></label>
        <div class="fields-2">
          <label class="field"><span>Category</span><select data-change="itemCat" data-item="${it.id}">${CATEGORIES.map((c) => `<option ${c === it.category ? 'selected' : ''}>${c}</option>`).join('')}</select></label>
          <label class="field"><span>Compare price per</span><select data-change="itemUnit" data-item="${it.id}">${UNIT_OPTIONS.map((u) => `<option ${u === it.unit ? 'selected' : ''}>${u}</option>`).join('')}</select></label>
        </div>
        <label class="field"><span>How often you buy it</span><select data-change="itemFreq" data-item="${it.id}">${['', 'weekly', 'biweekly', 'monthly'].map((f) => `<option value="${f}" ${f === (it.frequency || '') ? 'selected' : ''}>${f || 'Occasionally'}</option>`).join('')}</select></label>
        <button class="btn danger sm" data-action="delItem" data-item="${it.id}">Delete item & its prices</button>
      </details>`;
  });
}

function saveLookup() {
  const { storeId, results } = lookup;
  let n = 0;
  update((s) => {
    for (const x of results) {
      if (!x.found || !x.keep || !(x.price > 0)) continue;
      const it = s.items.find((i) => i.name === x.item) || findItem(x.item);
      if (!it) continue;
      s.prices.push({ id: uid(), itemId: it.id, storeId, price: x.price, qty: x.size_qty || 1, unit: normUnit(x.size_unit), date: today(), sale: !!x.on_sale, source: 'web lookup', note: x.product });
      if (x.on_sale && x.regular_price) s.prices.push({ id: uid(), itemId: it.id, storeId, price: x.regular_price, qty: x.size_qty || 1, unit: normUnit(x.size_unit), date: today(), sale: false, source: 'web lookup', note: x.product });
      it.products = { ...(it.products || {}), [storeId]: x.product };
      if (x.match !== 'exact') it.match = { ...(it.match || {}), [storeId]: x.match === 'close' ? 'Close' : 'Substitute' };
      if (x.source_url) it.links = { ...(it.links || {}), [storeId]: x.source_url };
      n++;
    }
  });
  lookup = null;
  closeSheet();
  toast(`Saved ${n} price${n === 1 ? '' : 's'}`);
}

function addPriceSheet(itemId) {
  const s = getState();
  const it = itemId ? itemById(itemId) : null;
  sheet(() => `<h2>Add a price</h2>
    <form data-submit="savePrice">
      ${it ? `<input type="hidden" name="itemId" value="${it.id}"><p><strong>${esc(it.name)}</strong></p>` : `<label class="field"><span>Item</span><input type="text" name="name" required placeholder="e.g. Bananas" list="itemNames"></label><datalist id="itemNames">${s.items.map((i) => `<option value="${esc(i.name)}">`).join('')}</datalist>`}
      <label class="field"><span>Store</span><select name="storeId">${s.stores.map((st) => `<option value="${st.id}">${esc(st.name)}</option>`).join('')}</select></label>
      <div class="fields-3">
        <label class="field"><span>Price $</span><input type="number" name="price" step="0.01" min="0" inputmode="decimal" required></label>
        <label class="field"><span>For qty</span><input type="number" name="qty" step="any" min="0" value="1" inputmode="decimal"></label>
        <label class="field"><span>Unit</span><select name="unit">${UNIT_OPTIONS.map((u) => `<option ${it && u === it.unit ? 'selected' : ''}>${u}</option>`).join('')}</select></label>
      </div>
      <div class="fields-2">
        <label class="field"><span>Date</span><input type="date" name="date" value="${today()}"></label>
        <label class="field"><span>Sale ends (if sale)</span><input type="date" name="saleEnds"></label>
      </div>
      <label class="check" style="margin-bottom:12px"><input type="checkbox" name="sale"> Sale price</label>
      ${it ? '' : `<label class="field"><span>Category</span><select name="category">${CATEGORIES.map((c) => `<option>${c}</option>`).join('')}</select></label>`}
      <button class="btn primary block">Save price</button>
    </form>`);
}

// ------------------------------------------------------------------ SCAN
function renderScan() {
  const s = getState();
  if (busy?.where === 'scan') return `<div class="empty"><div class="spinner"></div><p>${esc(busy.label)}</p><p class="small">This usually takes 15–40 seconds.</p></div>`;
  if (receiptDraft) return renderReceiptReview();
  return `
    <div class="card">
      <h2>Scan a receipt</h2>
      <p class="muted small" style="margin-top:0">Snap a paper receipt, or upload a screenshot / PDF of an emailed or delivery receipt. Prices go into your price book and groceries go into your pantry.</p>
      <label class="dropzone" style="display:block">
        <input type="file" accept="image/*,application/pdf" multiple capture="environment" data-change="receiptFiles" hidden>
        <div style="font-size:34px">📷</div><strong>Take photo or choose file</strong><div class="small muted">Long receipt? Add several photos.</div>
      </label>
      <div class="btn-row" style="margin-top:8px"><label class="btn"><input type="file" accept="image/*,application/pdf" multiple data-change="receiptFiles" hidden>Choose from library</label></div>
      <details style="margin-top:12px"><summary>Paste receipt text instead</summary>
        <textarea data-input="receiptText" placeholder="Paste the text of an emailed receipt or order confirmation…"></textarea>
        <button class="btn block" style="margin-top:8px" data-action="readReceiptText">Read pasted text</button>
      </details>
      ${s.settings.apiKey ? '' : `<p class="small" style="color:var(--warn)">Receipt reading uses Claude. Add your Anthropic API key in Settings first.</p>`}
    </div>
    <div class="card"><h3>No receipt?</h3><p class="small muted" style="margin-top:0">Jot down a shelf price while you shop.</p><button class="btn block" data-action="addPrice">+ Add a price by hand</button></div>`;
}

let receiptText = '';
async function runReceipt(files, text) {
  busy = { where: 'scan', label: 'Reading your receipt…' };
  tab = 'scan';
  render();
  try {
    const { readReceipt } = await ai();
    const r = await readReceipt({ files, text });
    const s = getState();
    const st = storeByName(s, r.store);
    receiptDraft = {
      storeId: st?.id || s.stores[0]?.id,
      storeGuess: r.store,
      date: r.date || today(),
      isDelivery: r.is_delivery,
      total: r.total,
      lines: r.lines.map((l) => {
        const existing = (l.match && findItem(l.match)) || findItem(l.name);
        const count = l.count > 0 ? l.count : 1;
        return {
          include: true,
          pantry: l.is_food !== false,
          name: existing ? existing.name : l.name,
          matched: !!existing,
          raw: l.raw,
          category: existing?.category || (CATEGORIES.includes(l.category) ? l.category : 'Other'),
          count,
          price: Math.round((l.line_total / count) * 100) / 100,
          qty: l.size_qty || 1,
          unit: normUnit(l.size_unit),
          sale: !!l.on_sale,
          regular: l.regular_price ? Math.round((l.regular_price / count) * 100) / 100 : null,
        };
      }),
    };
  } catch (e) {
    toast(e.message);
  } finally {
    busy = null;
    render();
  }
}

function renderReceiptReview() {
  const s = getState();
  const d = receiptDraft;
  const sum = d.lines.filter((l) => l.include).reduce((t, l) => t + l.price * l.count, 0);
  return `<div class="card">
    <h2>Check & save</h2>
    <div class="fields-2">
      <label class="field"><span>Store${d.storeGuess && !storeByName(s, d.storeGuess) ? ` (receipt says “${esc(d.storeGuess)}”)` : ''}</span><select data-change="rdStore">${s.stores.map((st) => `<option value="${st.id}" ${st.id === d.storeId ? 'selected' : ''}>${esc(st.name)}</option>`).join('')}<option value="__new">+ New store…</option></select></label>
      <label class="field"><span>Date</span><input type="date" value="${esc(d.date)}" data-change="rdDate"></label>
    </div>
    <p class="small muted" style="margin:0">${d.lines.length} lines · selected ${money(sum)}${d.total ? ` · receipt total ${money(d.total)}` : ''}${d.isDelivery ? ' · delivery order' : ''}</p>
  </div>
  ${d.lines.map((l, i) => `<div class="card" style="${l.include ? '' : 'opacity:.55'}">
    <div class="row"><label class="check"><input type="checkbox" ${l.include ? 'checked' : ''} data-change="rdInclude" data-i="${i}"></label>
      <input type="text" value="${esc(l.name)}" data-change="rdName" data-i="${i}" class="grow"></div>
    <div class="small muted" style="margin:4px 0 8px">${esc(l.raw)} ${l.matched ? '<span class="pill good">Known item</span>' : '<span class="pill">New item</span>'} ${l.sale ? '<span class="pill sale">Sale</span>' : ''}</div>
    <div class="fields-3">
      <label class="field"><span>Each $</span><input type="number" step="0.01" inputmode="decimal" value="${l.price}" data-change="rdPrice" data-i="${i}"></label>
      <label class="field"><span>Size</span><input type="number" step="any" inputmode="decimal" value="${l.qty}" data-change="rdQty" data-i="${i}"></label>
      <label class="field"><span>Unit</span><select data-change="rdUnit" data-i="${i}">${UNIT_OPTIONS.map((u) => `<option ${u === l.unit ? 'selected' : ''}>${u}</option>`).join('')}</select></label>
    </div>
    <div class="row between small"><span class="muted">× ${l.count} · ${esc(l.category)}</span><label class="check"><input type="checkbox" ${l.pantry ? 'checked' : ''} data-change="rdPantry" data-i="${i}"> Add to pantry</label></div>
  </div>`).join('')}
  <div class="btn-row"><button class="btn" data-action="rdCancel">Discard</button><button class="btn primary" data-action="rdSave">Save ${d.lines.filter((l) => l.include).length} items</button></div>`;
}

function saveReceipt() {
  const d = receiptDraft;
  let n = 0;
  update((s) => {
    for (const l of d.lines) {
      if (!l.include || !l.name.trim()) continue;
      const unit = normUnit(l.unit);
      const it = ensureItem(s, { name: l.name, category: l.category, unit });
      s.prices.push({ id: uid(), itemId: it.id, storeId: d.storeId, price: Number(l.price), qty: Number(l.qty) || 1, unit, date: d.date, sale: l.sale, source: d.isDelivery ? 'delivery receipt' : 'receipt' });
      if (l.sale && l.regular) s.prices.push({ id: uid(), itemId: it.id, storeId: d.storeId, price: Number(l.regular), qty: Number(l.qty) || 1, unit, date: d.date, sale: false, source: 'receipt (regular)' });
      if (l.pantry) {
        const p = s.pantry.find((x) => x.itemId === it.id);
        if (p) { p.qty = (p.qty || 0) + l.count; p.addedDate = d.date; } else s.pantry.push({ id: uid(), itemId: it.id, qty: l.count, addedDate: d.date });
      }
      // bought it — check it off the list
      s.list.forEach((e) => { if (e.itemId === it.id) e.checked = true; });
      n++;
    }
  });
  receiptDraft = null;
  toast(`Saved ${n} items`);
  render();
}

// ------------------------------------------------------------------ DEALS
function renderDeals() {
  const s = getState();
  const enabled = s.stores.filter((st) => st.enabled !== false);
  let html = `<div class="card"><h2>This week's deals</h2>
    <p class="small muted" style="margin-top:0">Claude searches the current weekly ads for ${enabled.map((x) => esc(x.name)).join(' & ')}${s.settings.zip ? ` near ${esc(s.settings.zip)}` : ''}, focusing on what's on your list and in your price book.</p>
    ${busy?.where === 'deals' ? `<div class="row"><span class="spinner"></span><span>${esc(busy.label)}</span></div><p class="small muted">Searching takes about a minute.</p>` : `<button class="btn primary block" data-action="findDeals">🔎 Find deals now</button>`}
    ${s.settings.zip ? '' : `<p class="small" style="color:var(--warn)">Tip: add your ZIP code in Settings so prices match your local stores.</p>`}
    ${s.dealsFetchedAt ? `<p class="small muted" style="margin-bottom:0">Last checked ${new Date(s.dealsFetchedAt).toLocaleString()}</p>` : ''}
  </div>`;
  const deals = (s.deals || []).filter((d) => !d.valid_to || d.valid_to >= today());
  if (!deals.length) return html + (s.dealsFetchedAt ? `<div class="empty">No current deals saved.</div>` : '');

  const matched = deals.filter((d) => d.itemId);
  if (matched.length) {
    html += `<div class="section-title row between"><span>Items you buy (${matched.length})</span></div>
      <button class="btn sm block" style="margin-bottom:10px" data-action="saveAllDeals">Use all these sale prices in my price book</button>`;
    html += matched.map(dealCard).join('');
  }
  const byStore = {};
  for (const d of deals.filter((x) => !x.itemId)) (byStore[d.store] ||= []).push(d);
  for (const [store, list] of Object.entries(byStore)) {
    html += `<div class="section-title">More at ${esc(store)}</div>` + list.map(dealCard).join('');
  }
  if (s.dealsNotes) html += `<details class="card"><summary>Notes from the search</summary><p class="small">${esc(s.dealsNotes)}</p></details>`;
  return html;
}

function dealCard(d) {
  const s = getState();
  const st = storeByName(s, d.store);
  const it = d.itemId ? itemById(d.itemId) : null;
  let cmp = '';
  if (it) {
    const rows = compareItem(it, s.stores, s.prices.filter((p) => p.dealId !== d.id));
    const dealPU = unitPrice(d.sale_price, d.size_qty, d.size_unit, it.unit);
    const best = rows[0];
    if (best && dealPU != null) {
      const diff = best.best.perUnit - dealPU;
      cmp = diff > 0.005 ? `<span class="pill good">${money(diff)}/${esc(it.unit)} under your best</span>` : `<span class="pill">Not better than ${esc(best.store.name)}</span>`;
    }
  }
  return `<div class="card">
    <div class="row between"><div class="grow"><div class="row small muted">${storeDot(st)} ${esc(d.store)}${d.member_only ? ' · members' : ''}</div><strong>${esc(d.item)}</strong></div>
      <div class="right"><div class="money" style="color:var(--sale)">${money(d.sale_price)}</div><div class="small muted">${fmtQty(d.size_qty || 1, d.size_unit)}</div></div></div>
    <div class="small" style="margin:6px 0">${esc(d.deal_text)}${d.regular_price ? ` · reg ${money(d.regular_price)}` : ''}${d.valid_to ? ` · through ${esc(d.valid_to)}` : ''} ${cmp}</div>
    <div class="btn-row">${d.saved ? '<span class="pill good">In price book</span>' : `<button class="btn sm" data-action="saveDeal" data-id="${d.id}">Save price</button>`}
      <button class="btn sm" data-action="dealToList" data-id="${d.id}">Add to list</button>
      ${d.source_url ? `<a class="btn sm" href="${esc(d.source_url)}" target="_blank" rel="noopener">Source</a>` : ''}</div>
  </div>`;
}

function saveDealPrice(s, d) {
  const st = storeByName(s, d.store);
  if (!st) return false;
  const it = d.itemId ? s.items.find((i) => i.id === d.itemId) : ensureItem(s, { name: d.item, category: CATEGORIES.includes(d.category) ? d.category : 'Other', unit: normUnit(d.size_unit) });
  d.itemId = it.id;
  s.prices.push({ id: uid(), dealId: d.id, itemId: it.id, storeId: st.id, price: d.sale_price, qty: d.size_qty || 1, unit: normUnit(d.size_unit), date: today(), sale: true, saleStarts: d.valid_from || '', saleEnds: d.valid_to || '', memberOnly: d.member_only, source: 'weekly ad' });
  if (d.regular_price) s.prices.push({ id: uid(), itemId: it.id, storeId: st.id, price: d.regular_price, qty: d.size_qty || 1, unit: normUnit(d.size_unit), date: today(), sale: false, source: 'weekly ad (regular)' });
  d.saved = true;
  return true;
}

async function runDeals() {
  const s = getState();
  const stores = s.stores.filter((st) => st.enabled !== false);
  const watch = [...new Set([...s.list.map((e) => itemById(e.itemId)?.name), ...s.items.map((i) => i.name)].filter(Boolean))].slice(0, 80);
  busy = { where: 'deals', label: 'Starting search…' };
  render();
  try {
    const { findDeals } = await ai();
    const r = await findDeals({
      storeNames: stores.map((x) => x.name),
      watchList: watch,
      zip: s.settings.zip,
      onStatus: (label) => { busy = { where: 'deals', label }; render(); },
    });
    update((st) => {
      st.deals = r.deals.map((d) => {
        const it = d.match ? findItem(d.match) : null;
        return { ...d, id: uid(), itemId: it?.id || null };
      });
      st.dealsNotes = r.notes;
      st.dealsFetchedAt = Date.now();
    });
    toast(`Found ${r.deals.length} deals`);
  } catch (e) {
    toast(e.message);
  } finally {
    busy = null;
    render();
  }
}

// ------------------------------------------------------------------ KITCHEN
function renderKitchen() {
  return `<div class="seg"><button data-action="ktab" data-k="pantry" class="${kitchenTab === 'pantry' ? 'on' : ''}">On hand</button><button data-action="ktab" data-k="recipes" class="${kitchenTab === 'recipes' ? 'on' : ''}">What to cook</button></div>` +
    (kitchenTab === 'pantry' ? renderPantry() : renderRecipes());
}

function renderPantry() {
  const s = getState();
  let html = itemPicker('pantry', 'Add something you have…');
  if (!s.pantry.length) return html + `<div class="empty">Nothing recorded yet. Scanned receipts add groceries here automatically.</div>`;
  const byCat = {};
  for (const p of s.pantry) {
    const it = itemById(p.itemId);
    if (it) (byCat[it.category || 'Other'] ||= []).push({ p, it });
  }
  for (const cat of Object.keys(byCat).sort((a, b) => CATEGORIES.indexOf(a) - CATEGORIES.indexOf(b))) {
    html += `<div class="section-title">${esc(cat)}</div><div class="card"><ul class="list">`;
    for (const { p, it } of byCat[cat].sort((a, b) => a.it.name.localeCompare(b.it.name))) {
      const age = ageDays(p.addedDate);
      const stale = cat === 'Produce' && age >= 5;
      html += `<li><div class="grow"><div class="ellipsis">${esc(it.name)}</div><div class="small muted">${p.qty > 1 ? `${p.qty} · ` : ''}bought ${ago(p.addedDate)} ${stale ? '<span class="pill warn">use soon</span>' : ''}</div></div>
        <button class="btn sm" data-action="pantryToList" data-item="${it.id}" aria-label="Add to list">+ List</button>
        <button class="btn sm" data-action="usedUp" data-id="${p.id}">Used up</button></li>`;
    }
    html += `</ul></div>`;
  }
  return html;
}

function renderRecipes() {
  const s = getState();
  const scored = s.recipes.map((r) => ({ r, c: recipeCoverage(r, s.pantry, s.items) })).sort((a, b) => b.c.pct - a.c.pct);
  let html = `<div class="btn-row" style="margin-bottom:12px"><button class="btn primary" data-action="recipeIdeas">✨ Ideas from what I have</button><button class="btn" data-action="newRecipe">+ Recipe</button></div>`;
  if (!scored.length) return html + `<div class="empty">Save your go-to recipes and we'll tell you which ones you can make with what's on hand.</div>`;
  for (const { r, c } of scored) {
    const missing = c.status.filter((x) => !x.have);
    html += `<div class="card">
      <div class="row between"><h3 style="margin:0">${esc(r.name)}</h3><span class="pill ${c.pct === 1 ? 'good' : ''}">${c.haveCount}/${c.total}</span></div>
      <div class="bar" style="margin:8px 0"><div style="width:${Math.round(c.pct * 100)}%"></div></div>
      ${missing.length ? `<div class="small">Need: ${missing.map((m) => esc(m.name)).join(', ')}</div>` : `<div class="small" style="color:var(--accent)">You have everything!</div>`}
      <details style="margin-top:6px"><summary class="small">Ingredients & steps</summary>
        <ul class="small">${c.status.map((x) => `<li>${x.have ? '✓' : '○'} ${esc(x.amount ? x.amount + ' ' : '')}${esc(x.name)}</li>`).join('')}${r.ingredients.filter((x) => x.staple).map((x) => `<li class="muted">${esc(x.name)} (staple)</li>`).join('')}</ul>
        <p class="small" style="white-space:pre-wrap">${esc(r.instructions || '')}</p>
        <button class="btn sm danger" data-action="delRecipe" data-id="${r.id}">Delete recipe</button>
      </details>
      ${missing.length ? `<button class="btn sm" style="margin-top:8px" data-action="missingToList" data-id="${r.id}">Add ${missing.length} missing to list</button>` : ''}
    </div>`;
  }
  return html;
}

function newRecipeSheet() {
  sheet(() => `<h2>New recipe</h2><form data-submit="saveRecipe">
    <label class="field"><span>Name</span><input type="text" name="name" required></label>
    <label class="field"><span>Ingredients (one per line — start with * for staples like salt or oil)</span><textarea name="ingredients" rows="6" placeholder="spaghetti&#10;garlic&#10;*olive oil"></textarea></label>
    <label class="field"><span>Steps</span><textarea name="instructions" rows="4"></textarea></label>
    <button class="btn primary block">Save recipe</button></form>`);
}

let ideas = null;
async function runIdeas() {
  const s = getState();
  ideas = { loading: true };
  sheet(ideasSheet);
  try {
    const { recipeIdeas } = await ai();
    const onSale = (s.deals || []).map((d) => `${d.item} at ${d.store}`).slice(0, 30);
    const r = await recipeIdeas({ onHand: s.pantry.map((p) => itemById(p.itemId)?.name).filter(Boolean), onSale });
    ideas = { recipes: r.recipes };
  } catch (e) {
    ideas = { error: e.message };
  }
  refreshSheet();
}
function ideasSheet() {
  if (!ideas || ideas.loading) return `<h2>Recipe ideas</h2><div class="empty"><div class="spinner"></div><p>Looking at what you have…</p></div>`;
  if (ideas.error) return `<h2>Recipe ideas</h2><p>${esc(ideas.error)}</p>`;
  return `<h2>Recipe ideas</h2>` + ideas.recipes.map((r, i) => `<div class="card"><div class="row between"><h3 style="margin:0">${esc(r.name)}</h3><span class="small muted">${r.minutes} min</span></div>
    <ul class="small">${r.ingredients.map((x) => `<li>${x.match ? '✓' : x.staple ? '·' : '○'} ${esc(x.amount)} ${esc(x.name)}</li>`).join('')}</ul>
    <details><summary class="small">Steps</summary><p class="small" style="white-space:pre-wrap">${esc(r.instructions)}</p></details>
    <button class="btn sm" data-action="saveIdea" data-i="${i}" ${r.saved ? 'disabled' : ''}>${r.saved ? 'Saved' : 'Save recipe'}</button></div>`).join('');
}

// ------------------------------------------------------------------ SETTINGS
function settingsSheet() {
  sheet(() => {
    const s = getState();
    return `<h2>Settings</h2>
    <div class="card"><h3>Claude (receipts, deals, ideas)</h3>
      <label class="field"><span>Anthropic API key</span><input type="password" value="${esc(s.settings.apiKey)}" data-change="setApiKey" placeholder="sk-ant-…" autocomplete="off"></label>
      <p class="small muted" style="margin:0">Stored only on this phone and sent only to Anthropic. Get one at console.anthropic.com.</p>
      <label class="field" style="margin-top:10px"><span>ZIP code (for local weekly ads)</span><input type="text" inputmode="numeric" value="${esc(s.settings.zip)}" data-change="setZip"></label>
    </div>
    <div class="card"><h3>Trip & delivery costs</h3>
      <label class="field"><span>Cost of an extra store stop (gas + time), $</span><input type="number" step="0.5" inputmode="decimal" value="${esc(s.settings.extraStopCost)}" data-change="setExtraStop"></label>
      <label class="field"><span>Extra tip on every delivery order, $ (per-store tips are below)</span><input type="number" step="0.5" inputmode="decimal" value="${esc(s.settings.tip)}" data-change="setTip"></label>
      <p class="small muted" style="margin:0">Splitting a trip is only recommended when it saves more than this.</p>
    </div>
    <div class="section-title">Stores</div>
    ${s.stores.map((st) => `<div class="card">
      <div class="row"><input type="color" value="${esc(st.color)}" data-change="storeColor" data-id="${st.id}" style="width:44px;height:44px;border:0;background:none;padding:0"><input type="text" value="${esc(st.name)}" data-change="storeName" data-id="${st.id}" class="grow"></div>
      <label class="check" style="margin:8px 0"><input type="checkbox" ${st.enabled !== false ? 'checked' : ''} data-change="storeEnabled" data-id="${st.id}"> Include when planning</label>
      <div class="fields-2">
        <label class="field"><span>Delivery fee $</span><input type="number" step="0.01" inputmode="decimal" value="${esc(st.deliveryFee)}" data-change="storeNum" data-k="deliveryFee" data-id="${st.id}"></label>
        <label class="field"><span>Free delivery over $</span><input type="number" step="1" inputmode="decimal" value="${esc(st.freeDeliveryOver)}" data-change="storeNum" data-k="freeDeliveryOver" data-id="${st.id}"></label>
        <label class="field"><span>Delivery price markup %</span><input type="number" step="1" inputmode="decimal" value="${esc(st.deliveryMarkupPct)}" data-change="storeNum" data-k="deliveryMarkupPct" data-id="${st.id}"></label>
        <label class="field"><span>Service fee %</span><input type="number" step="0.5" inputmode="decimal" value="${esc(st.serviceFeePct)}" data-change="storeNum" data-k="serviceFeePct" data-id="${st.id}"></label>
        <label class="field"><span>Tip per delivery $</span><input type="number" step="0.5" inputmode="decimal" value="${esc(st.tipFlat || 0)}" data-change="storeNum" data-k="tipFlat" data-id="${st.id}"></label>
        <label class="field"><span>Order minimum $</span><input type="number" step="1" inputmode="decimal" value="${esc(st.minOrder || 0)}" data-change="storeNum" data-k="minOrder" data-id="${st.id}"></label>
        <label class="field"><span>Pickup fee $</span><input type="number" step="0.01" inputmode="decimal" value="${esc(st.pickupFee || 0)}" data-change="storeNum" data-k="pickupFee" data-id="${st.id}"></label>
        <label class="field"><span>Membership free delivery over $</span><input type="number" step="1" inputmode="decimal" value="${esc(st.membershipMin || 0)}" data-change="storeNum" data-k="membershipMin" data-id="${st.id}"></label>
      </div>
      <label class="check" style="margin-bottom:8px"><input type="checkbox" ${st.membership ? 'checked' : ''} data-change="storeMember" data-id="${st.id}"> I have a delivery membership here (waives the delivery fee)</label>
      ${st.notes ? `<p class="small muted" style="margin-top:0">${esc(st.notes)}</p>` : ''}
      <button class="btn sm danger" data-action="delStore" data-id="${st.id}">Remove store</button>
    </div>`).join('')}
    <button class="btn block" data-action="addStore">+ Add store</button>
    <p class="small muted">Delivery markup: Instacart and similar apps often price items 10–20% above in-store. Compare a delivery receipt to an in-store one to set this.</p>
    <div class="section-title">Your data</div>
    <div class="card">
      <p class="small muted" style="margin-top:0">Everything is saved on this device. To share with your household, export a backup and import it on the other phone.</p>
      <div class="btn-row"><button class="btn" data-action="exportJson">Export backup</button><label class="btn"><input type="file" accept="application/json,.json" data-change="importJson" hidden>Import backup</label></div>
      <div class="btn-row" style="margin-top:8px"><button class="btn" data-action="importCsv">Import spreadsheet (CSV)</button></div>
      <div class="btn-row" style="margin-top:8px"><button class="btn" data-action="sample">Load sample data</button><button class="btn danger" data-action="wipe">Erase all</button></div>
    </div>`;
  });
}

function csvSheet() {
  sheet(() => `<h2>Import from a spreadsheet</h2>
    <p class="small">In Excel: <em>File → Save As → CSV</em>. Columns are matched by header name:</p>
    <div class="card small"><code>item, store, price, qty, unit, date, category, sale</code><br><span class="muted">Only item, store and price are required. Extra columns named after a store (e.g. “Whole Foods”, “Giant”) also work — each becomes a price at that store.</span></div>
    <label class="btn block"><input type="file" accept=".csv,text/csv" data-change="csvFile" hidden>Choose CSV file</label>
    <details style="margin-top:12px"><summary>…or paste rows</summary><textarea data-input="csvText" placeholder="item,store,price,qty,unit&#10;Cheerios 18 oz,Giant,5.49,18,oz"></textarea><button class="btn block" style="margin-top:8px" data-action="csvPaste">Import pasted rows</button></details>`);
}

let csvText = '';
function doCsvImport(text) {
  const rows = parseCSV(text);
  let res;
  update((s) => { res = importPriceRows(s, rows); });
  closeSheet();
  toast(`Imported ${res.prices} prices for ${res.items} items${res.skipped ? ` (${res.skipped} rows skipped)` : ''}`);
}

// ------------------------------------------------------------------ events
const actions = {
  mode: (d) => update((s) => (s.settings.mode = d.mode)),
  ptab: (d) => { priceTab = d.k; render(); },
  sdf: (d) => { showdownFilter = d.k; render(); },
  fillGaps: () => { lookup = null; fillGapsSheet(); },
  lookupOne: (d) => { lookup = null; fillGapsSheet(d.item); },
  lookupRun: (d) => runLookup(d.store, d.only || null),
  lookupReset: () => { lookup = null; refreshSheet(); },
  lookupSave: () => saveLookup(),
  addStaples: () => {
    let n = 0;
    update((s) => {
      for (const it of s.items.filter((i) => i.frequency === 'weekly')) {
        const ex = s.list.find((e) => e.itemId === it.id);
        if (ex && !ex.checked) continue;
        if (ex) { ex.checked = false; n++; continue; }
        const last = s.prices.filter((p) => p.itemId === it.id).sort((a, b) => (b.date || '').localeCompare(a.date || ''))[0];
        s.list.push({ id: uid(), itemId: it.id, qty: last ? last.qty : 1, unit: last ? last.unit : it.unit, checked: false });
        n++;
      }
    });
    toast(`Added ${n} weekly staple${n === 1 ? '' : 's'}`);
  },
  pick: (d) => {
    const input = document.querySelector(`[data-picker="${d.picker}"]`);
    update((s) => {
      const it = d.item ? s.items.find((i) => i.id === d.item) : ensureItem(s, { name: d.new });
      if (d.picker === 'list') {
        const ex = s.list.find((e) => e.itemId === it.id);
        if (ex) ex.checked = false;
        else {
          const last = s.prices.filter((p) => p.itemId === it.id).sort((a, b) => (b.date || '').localeCompare(a.date || ''))[0];
          s.list.push({ id: uid(), itemId: it.id, qty: last ? last.qty : 1, unit: last ? last.unit : it.unit, checked: false });
        }
      } else if (d.picker === 'pantry') {
        if (!s.pantry.find((p) => p.itemId === it.id)) s.pantry.push({ id: uid(), itemId: it.id, qty: 1, addedDate: today() });
      }
    });
    if (input) input.value = '';
    toast('Added');
  },
  toggle: (d) => update((s) => { const e = s.list.find((x) => x.id === d.id); if (e) e.checked = !e.checked; }),
  editEntry: (d) => entrySheet(d.id),
  removeEntry: (d) => { update((s) => (s.list = s.list.filter((e) => e.id !== d.id))); closeSheet(); },
  clearChecked: () => update((s) => (s.list = s.list.filter((e) => !e.checked))),
  checkedToPantry: () => update((s) => {
    for (const e of s.list.filter((x) => x.checked)) {
      const p = s.pantry.find((x) => x.itemId === e.itemId);
      if (p) { p.qty = (p.qty || 0) + 1; p.addedDate = today(); } else s.pantry.push({ id: uid(), itemId: e.itemId, qty: 1, addedDate: today() });
    }
    s.list = s.list.filter((e) => !e.checked);
  }),
  itemDetail: (d) => itemDetailSheet(d.item),
  addPrice: (d) => addPriceSheet(d.item),
  addToList: (d) => { actions.pick({ picker: 'list', item: d.item }); },
  delPrice: (d) => update((s) => (s.prices = s.prices.filter((p) => p.id !== d.id))),
  delItem: (d) => {
    if (!confirm('Delete this item and all its prices?')) return;
    update((s) => {
      s.items = s.items.filter((i) => i.id !== d.item);
      s.prices = s.prices.filter((p) => p.itemId !== d.item);
      s.list = s.list.filter((e) => e.itemId !== d.item);
      s.pantry = s.pantry.filter((p) => p.itemId !== d.item);
    });
    closeSheet();
  },
  importCsv: () => csvSheet(),
  csvPaste: () => doCsvImport(csvText),
  readReceiptText: () => { if (receiptText.trim()) runReceipt([], receiptText); },
  rdCancel: () => { receiptDraft = null; render(); },
  rdSave: () => saveReceipt(),
  findDeals: () => runDeals(),
  saveDeal: (d) => update((s) => { const deal = s.deals.find((x) => x.id === d.id); if (deal && !saveDealPrice(s, deal)) toast(`Add “${deal.store}” as a store in Settings first`); }),
  saveAllDeals: () => { let n = 0; update((s) => s.deals.filter((x) => x.itemId && !x.saved).forEach((x) => saveDealPrice(s, x) && n++)); toast(`Saved ${n} sale prices`); },
  dealToList: (d) => {
    const s = getState();
    const deal = s.deals.find((x) => x.id === d.id);
    if (!deal.saved) update((st) => saveDealPrice(st, st.deals.find((x) => x.id === d.id)));
    const it = getState().deals.find((x) => x.id === d.id).itemId;
    if (it) actions.pick({ picker: 'list', item: it });
  },
  ktab: (d) => { kitchenTab = d.k; render(); },
  pantryToList: (d) => actions.pick({ picker: 'list', item: d.item }),
  usedUp: (d) => update((s) => (s.pantry = s.pantry.filter((p) => p.id !== d.id))),
  missingToList: (d) => {
    const s = getState();
    const r = s.recipes.find((x) => x.id === d.id);
    const miss = recipeCoverage(r, s.pantry, s.items).status.filter((x) => !x.have);
    update((st) => {
      for (const m of miss) {
        const it = m.itemId ? st.items.find((i) => i.id === m.itemId) : ensureItem(st, { name: m.name });
        if (!st.list.find((e) => e.itemId === it.id && !e.checked)) st.list.push({ id: uid(), itemId: it.id, qty: 1, unit: it.unit, checked: false });
      }
    });
    toast(`Added ${miss.length} to list`);
  },
  delRecipe: (d) => update((s) => (s.recipes = s.recipes.filter((r) => r.id !== d.id))),
  newRecipe: () => newRecipeSheet(),
  recipeIdeas: () => runIdeas(),
  saveIdea: (d) => {
    const r = ideas.recipes[d.i];
    update((s) => s.recipes.push({
      id: uid(), name: r.name, servings: r.servings, instructions: r.instructions,
      ingredients: r.ingredients.map((x) => ({ name: x.name, amount: x.amount, staple: x.staple, itemId: x.match ? findItem(x.match)?.id : undefined })),
    }));
    r.saved = true;
    refreshSheet();
  },
  addStore: () => update((s) => s.stores.push({ id: uid(), name: 'New store', color: '#6b7280', enabled: true, deliveryFee: 0, serviceFeePct: 0, deliveryMarkupPct: 0, freeDeliveryOver: 0 })),
  delStore: (d) => {
    if (!confirm('Remove this store and its prices?')) return;
    update((s) => { s.stores = s.stores.filter((x) => x.id !== d.id); s.prices = s.prices.filter((p) => p.storeId !== d.id); });
  },
  exportJson: () => {
    const blob = new Blob([JSON.stringify({ ...getState(), settings: { ...getState().settings, apiKey: '' } }, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `grocery-planner-${today()}.json`;
    a.click();
  },
  sample: () => {
    if (getState().items.length && !confirm('Replace your data with sample data?')) return;
    replaceState(sampleData());
    closeSheet();
    toast('Sample data loaded');
  },
  wipe: () => {
    if (!confirm('Erase everything on this device?')) return;
    const keep = getState().settings;
    replaceState({ settings: keep });
    closeSheet();
  },
};

const changes = {
  entryQty: (el) => update((s) => { const e = s.list.find((x) => x.id === el.dataset.id); if (e) e.qty = Number(el.value) || 1; }),
  entryUnit: (el) => update((s) => { const e = s.list.find((x) => x.id === el.dataset.id); if (e) e.unit = el.value; }),
  itemName: (el) => update((s) => { const i = s.items.find((x) => x.id === el.dataset.item); if (i && el.value.trim()) i.name = el.value.trim(); }),
  itemCat: (el) => update((s) => { const i = s.items.find((x) => x.id === el.dataset.item); if (i) i.category = el.value; }),
  itemFreq: (el) => update((s) => { const i = s.items.find((x) => x.id === el.dataset.item); if (i) i.frequency = el.value || null; }),
  itemUnit: (el) => update((s) => { const i = s.items.find((x) => x.id === el.dataset.item); if (i) i.unit = el.value; }),
  receiptFiles: (el) => { const files = [...el.files]; if (files.length) runReceipt(files, ''); },
  rdStore: (el) => {
    if (el.value === '__new') {
      const name = prompt('Store name', receiptDraft.storeGuess || '');
      if (name) { const id = uid(); update((s) => s.stores.push({ id, name, color: '#6b7280', enabled: true, deliveryFee: 0, serviceFeePct: 0, deliveryMarkupPct: 0, freeDeliveryOver: 0 })); receiptDraft.storeId = id; }
    } else receiptDraft.storeId = el.value;
    render();
  },
  rdDate: (el) => (receiptDraft.date = el.value),
  rdInclude: (el) => { receiptDraft.lines[el.dataset.i].include = el.checked; render(); },
  rdPantry: (el) => (receiptDraft.lines[el.dataset.i].pantry = el.checked),
  rdName: (el) => { const l = receiptDraft.lines[el.dataset.i]; l.name = el.value; const ex = findItem(el.value); l.matched = !!ex; if (ex) l.category = ex.category; },
  rdPrice: (el) => (receiptDraft.lines[el.dataset.i].price = Number(el.value)),
  rdQty: (el) => (receiptDraft.lines[el.dataset.i].qty = Number(el.value)),
  rdUnit: (el) => (receiptDraft.lines[el.dataset.i].unit = el.value),
  setApiKey: (el) => update((s) => (s.settings.apiKey = el.value.trim())),
  setZip: (el) => update((s) => (s.settings.zip = el.value.trim())),
  setExtraStop: (el) => update((s) => (s.settings.extraStopCost = Number(el.value) || 0)),
  setTip: (el) => update((s) => (s.settings.tip = Number(el.value) || 0)),
  storeName: (el) => update((s) => { const st = s.stores.find((x) => x.id === el.dataset.id); if (st && el.value.trim()) st.name = el.value.trim(); }),
  storeColor: (el) => update((s) => { const st = s.stores.find((x) => x.id === el.dataset.id); if (st) st.color = el.value; }),
  storeMember: (el) => update((s) => { const st = s.stores.find((x) => x.id === el.dataset.id); if (st) st.membership = el.checked; }),
  luPick: (el) => (lookup.results[el.dataset.i].keep = el.checked),
  storeEnabled: (el) => update((s) => { const st = s.stores.find((x) => x.id === el.dataset.id); if (st) st.enabled = el.checked; }),
  storeNum: (el) => update((s) => { const st = s.stores.find((x) => x.id === el.dataset.id); if (st) st[el.dataset.k] = Number(el.value) || 0; }),
  importJson: async (el) => {
    const f = el.files[0];
    if (!f) return;
    try {
      const data = JSON.parse(await f.text());
      if (!Array.isArray(data.items)) throw new Error('Not a Grocery Planner backup');
      if (!confirm('Replace data on this device with the backup?')) return;
      const key = getState().settings.apiKey;
      replaceState({ ...data, settings: { ...data.settings, apiKey: key } });
      closeSheet();
      toast('Backup imported');
    } catch (e) {
      toast(e.message);
    }
  },
  csvFile: async (el) => { const f = el.files[0]; if (f) doCsvImport(await f.text()); },
};

const inputs = {
  priceQuery: (el) => {
    priceQuery = el.value;
    const pos = el.selectionStart;
    render();
    const n = $('[data-input="priceQuery"]');
    n.focus();
    n.setSelectionRange(pos, pos);
  },
  receiptText: (el) => (receiptText = el.value),
  csvText: (el) => (csvText = el.value),
};

const submits = {
  savePrice: (form) => {
    const f = Object.fromEntries(new FormData(form));
    update((s) => {
      const it = f.itemId ? s.items.find((i) => i.id === f.itemId) : ensureItem(s, { name: f.name, category: f.category, unit: f.unit });
      s.prices.push({ id: uid(), itemId: it.id, storeId: f.storeId, price: Number(f.price), qty: Number(f.qty) || 1, unit: f.unit, date: f.date || today(), sale: !!f.sale, saleEnds: f.saleEnds || '', source: 'manual' });
    });
    closeSheet();
    toast('Price saved');
  },
  saveRecipe: (form) => {
    const f = Object.fromEntries(new FormData(form));
    const ingredients = String(f.ingredients).split('\n').map((x) => x.trim()).filter(Boolean).map((line) => {
      const staple = line.startsWith('*');
      const name = line.replace(/^\*\s*/, '');
      return { name, staple, itemId: findItem(name)?.id };
    });
    update((s) => s.recipes.push({ id: uid(), name: f.name, ingredients, instructions: f.instructions }));
    closeSheet();
  },
};

document.addEventListener('click', (ev) => {
  const tabBtn = ev.target.closest('#tabbar button');
  if (tabBtn) {
    tab = tabBtn.dataset.tab;
    localStorage.setItem('gp-tab', tab);
    window.scrollTo(0, 0);
    render();
    return;
  }
  if (ev.target.closest('[data-close]')) return closeSheet();
  const a = ev.target.closest('[data-action]');
  if (a && actions[a.dataset.action]) {
    ev.preventDefault();
    actions[a.dataset.action]({ ...a.dataset }, a);
  }
});
document.addEventListener('change', (ev) => {
  const el = ev.target.closest('[data-change]');
  if (!el || !changes[el.dataset.change]) return;
  quietSheet = !!el.closest('#sheet') && el.type !== 'file';
  try { changes[el.dataset.change](el); } finally { quietSheet = false; }
});
document.addEventListener('input', (ev) => {
  if (ev.target.dataset.picker) return fillSuggest(ev.target);
  const el = ev.target.closest('[data-input]');
  if (el && inputs[el.dataset.input]) inputs[el.dataset.input](el);
});
document.addEventListener('keydown', (ev) => {
  if (ev.key === 'Enter' && ev.target.dataset?.picker) {
    ev.preventDefault();
    const first = document.querySelector(`[data-suggest="${ev.target.dataset.picker}"] button`);
    if (first) first.click();
  }
});
document.addEventListener('submit', (ev) => {
  const f = ev.target.closest('[data-submit]');
  if (f && submits[f.dataset.submit]) {
    ev.preventDefault();
    submits[f.dataset.submit](f);
  }
});
$('#settingsBtn').addEventListener('click', settingsSheet);

if ('serviceWorker' in navigator && location.protocol !== 'file:') navigator.serviceWorker.register('sw.js').catch(() => {});

render();
