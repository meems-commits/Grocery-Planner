// Pure pricing + shopping-list optimization. No DOM, no storage — testable in Node.
import { convert, unitPrice } from './units.js';

const DAY = 86400000;

export function isSaleActive(p, now = Date.now()) {
  if (!p.sale) return false;
  if (p.saleEnds) {
    const end = new Date(p.saleEnds + 'T23:59:59').getTime();
    if (end < now) return false;
  }
  if (p.saleStarts) {
    const start = new Date(p.saleStarts + 'T00:00:00').getTime();
    if (start > now) return false;
  }
  return true;
}

/**
 * Best current price for an item at one store, as a price per item.unit.
 * Uses an active sale if one exists, else the most recent non-sale price
 * (falling back to the most recent price of any kind).
 */
export function bestPriceAt(item, storeId, prices, now = Date.now()) {
  const mine = prices.filter((p) => p.itemId === item.id && p.storeId === storeId);
  if (!mine.length) return null;
  const withUnit = (p) => ({ ...p, perUnit: unitPrice(p.price, p.qty, p.unit, item.unit) });
  const usable = mine.map(withUnit).filter((p) => p.perUnit != null);
  if (!usable.length) return null;

  const sales = usable.filter((p) => isSaleActive(p, now)).sort((a, b) => a.perUnit - b.perUnit);
  const byDate = (a, b) => (b.date || '').localeCompare(a.date || '');
  const regular = usable.filter((p) => !p.sale).sort(byDate)[0] || usable.slice().sort(byDate)[0];

  if (sales.length && (!regular || sales[0].perUnit <= regular.perUnit)) {
    return { ...sales[0], regularPerUnit: regular && !regular.sale ? regular.perUnit : null, onSale: true };
  }
  return { ...regular, regularPerUnit: regular.perUnit, onSale: false };
}

/** Per-store comparison for one item, cheapest first. */
export function compareItem(item, stores, prices, now = Date.now()) {
  const rows = stores
    .map((s) => ({ store: s, best: bestPriceAt(item, s.id, prices, now) }))
    .filter((r) => r.best);
  rows.sort((a, b) => a.best.perUnit - b.best.perUnit);
  return rows;
}

export function ageDays(dateStr, now = Date.now()) {
  if (!dateStr) return null;
  return Math.floor((now - new Date(dateStr + 'T12:00:00').getTime()) / DAY);
}

/** Cost of a list entry at a store, before trip/delivery fees. null if unknown. */
export function entryCost(entry, item, store, prices, mode, now = Date.now()) {
  const best = bestPriceAt(item, store.id, prices, now);
  if (!best) return null;
  const qty = convert(entry.qty || 1, entry.unit || item.unit, item.unit);
  if (qty == null) return null;
  let cost = best.perUnit * qty;
  // app/online prices (delivery and pickup) can be marked up over shelf prices
  if (mode === 'delivery' || mode === 'pickup') cost *= 1 + (Number(store.deliveryMarkupPct) || 0) / 100;
  return { cost, best };
}

/** Fees for one store order/stop. Returns {fee, belowMin}. */
export function storeOverhead(store, subtotal, mode, isExtraStop, settings = {}) {
  const minOrder = Number(store.minOrder) || 0;
  const belowMin = (mode === 'delivery' || mode === 'pickup') && minOrder > 0 && subtotal < minOrder;
  if (mode === 'delivery') {
    const freeOver = Number(store.freeDeliveryOver) || 0;
    const memberFree = store.membership && subtotal >= (Number(store.membershipMin) || 0);
    const deliveryFee = memberFree || (freeOver && subtotal >= freeOver) ? 0 : Number(store.deliveryFee) || 0;
    const svc = ((Number(store.serviceFeePct) || 0) / 100) * subtotal;
    const tip = (Number(store.tipFlat) || 0) + (Number(settings.tip) || 0);
    return { fee: deliveryFee + svc + tip, belowMin };
  }
  if (mode === 'pickup') return { fee: (Number(store.pickupFee) || 0) + (isExtraStop ? Number(settings.extraStopCost) || 0 : 0), belowMin };
  return { fee: isExtraStop ? Number(settings.extraStopCost) || 0 : 0, belowMin: false };
}

/**
 * Find the cheapest way to buy the list.
 * Enumerates every subset of stores (household-scale: a handful of stores),
 * assigns each item to its cheapest store in the subset, adds fees, and
 * picks the minimum total. Also returns single-store totals for comparison.
 */
export function optimizeList({ list, items, stores, prices, mode = 'store', settings = {}, now = Date.now() }) {
  const itemById = Object.fromEntries(items.map((i) => [i.id, i]));
  const active = list.filter((e) => !e.checked && itemById[e.itemId]);
  const activeStores = stores.filter((s) => s.enabled !== false);

  // cost matrix
  const costs = active.map((e) => {
    const item = itemById[e.itemId];
    const byStore = {};
    for (const s of activeStores) {
      const c = entryCost(e, item, s, prices, mode, now);
      if (c) byStore[s.id] = c;
    }
    return { entry: e, item, byStore };
  });

  const priced = costs.filter((c) => Object.keys(c.byStore).length);
  const unpriced = costs.filter((c) => !Object.keys(c.byStore).length);

  const evaluate = (subset, allowIncomplete) => {
    const assign = {};
    const missing = [];
    for (const c of priced) {
      let bestStore = null;
      for (const s of subset) {
        const sc = c.byStore[s.id];
        if (sc && (!bestStore || sc.cost < c.byStore[bestStore.id].cost)) bestStore = s;
      }
      if (!bestStore) {
        if (!allowIncomplete) return null;
        missing.push(c);
        continue;
      }
      (assign[bestStore.id] ||= []).push({ ...c, cost: c.byStore[bestStore.id].cost, best: c.byStore[bestStore.id].best });
    }
    const used = subset.filter((s) => assign[s.id]);
    // order stops by subtotal so the biggest stop is the "main" (non-extra) one
    const groups = used
      .map((s) => {
        const lines = assign[s.id];
        const subtotal = lines.reduce((t, l) => t + l.cost, 0);
        return { store: s, lines, subtotal };
      })
      .sort((a, b) => b.subtotal - a.subtotal)
      .map((g, i) => {
        const { fee, belowMin } = storeOverhead(g.store, g.subtotal, mode, i > 0, settings);
        return { ...g, overhead: fee, belowMin, total: g.subtotal + fee };
      });
    const total = groups.reduce((t, g) => t + g.total, 0);
    return { groups, total, missing, belowMin: groups.some((g) => g.belowMin) };
  };

  let best = null;
  let fallback = null; // best plan that misses an order minimum, if nothing else works
  const n = activeStores.length;
  for (let mask = 1; mask < 1 << n; mask++) {
    const subset = activeStores.filter((_, i) => mask & (1 << i));
    const r = evaluate(subset, false);
    if (r && r.belowMin) { fallback = !fallback || r.total < fallback.total ? r : fallback; continue; }
    if (r && (!best || r.total < best.total - 0.005 || (Math.abs(r.total - best.total) < 0.005 && r.groups.length < best.groups.length))) {
      best = r;
    }
  }
  if (!best) best = fallback;
  if (!best && priced.length) best = evaluate(activeStores, true);

  const singles = activeStores.map((s) => {
    const r = evaluate([s], true);
    return { store: s, total: r.total, missingCount: r.missing.length, missing: r.missing, belowMin: r.belowMin };
  }).sort((a, b) => a.missingCount - b.missingCount || a.total - b.total);

  const bestSingleComplete = singles.find((s) => s.missingCount === 0 && !s.belowMin) || singles.find((s) => s.missingCount === 0);
  const savingsVsSingle = best && bestSingleComplete ? bestSingleComplete.total - best.total : null;

  return {
    plan: best || { groups: [], total: 0, missing: [] },
    singles,
    unpriced,
    savingsVsSingle,
    bestSingle: bestSingleComplete || null,
  };
}

/** Recipe coverage against pantry contents (name/item match). */
export function recipeCoverage(recipe, pantry, items) {
  const itemById = Object.fromEntries(items.map((i) => [i.id, i]));
  const haveIds = new Set(pantry.filter((p) => (p.qty ?? 1) > 0).map((p) => p.itemId));
  const haveNames = [...haveIds].map((id) => (itemById[id]?.name || '').toLowerCase());
  const need = recipe.ingredients.filter((ing) => !ing.staple);
  const status = need.map((ing) => {
    let have = ing.itemId ? haveIds.has(ing.itemId) : false;
    if (!have) {
      const key = (ing.name || '').toLowerCase().trim();
      have = !!key && haveNames.some((n) => n.includes(key) || (n && key.includes(n)));
    }
    return { ...ing, have };
  });
  const haveCount = status.filter((s) => s.have).length;
  return { status, haveCount, total: need.length, pct: need.length ? haveCount / need.length : 1 };
}

/**
 * Head-to-head comparison of stores across every item they both price.
 * Returns per-item rows, win counts and pairwise totals.
 */
export function showdown(items, stores, prices, { now = Date.now() } = {}) {
  const active = stores.filter((s) => s.enabled !== false);
  const perYear = { weekly: 52, biweekly: 26, monthly: 12 };
  const rows = [];
  for (const item of items) {
    const cmp = compareItem(item, active, prices, now);
    if (!cmp.length) continue;
    const byStore = Object.fromEntries(cmp.map((r) => [r.store.id, r.best]));
    const [cheapest, second] = cmp;
    const pctSaved = second ? 1 - cheapest.best.perUnit / second.best.perUnit : null;
    // yearly savings at the item's purchase frequency, one typical package each time
    const typicalQty = convert(cheapest.best.qty || 1, cheapest.best.unit, item.unit) || 1;
    const times = perYear[item.frequency] || null;
    const yearly = second && times ? (second.best.perUnit - cheapest.best.perUnit) * typicalQty * times : null;
    rows.push({ item, byStore, cheapest: cheapest.store, compared: cmp.length > 1, pctSaved, yearly });
  }
  const compared = rows.filter((r) => r.compared);
  const wins = Object.fromEntries(active.map((s) => [s.id, 0]));
  for (const r of compared) wins[r.cheapest.id]++;
  const pairs = [];
  for (let i = 0; i < active.length; i++) {
    for (let j = i + 1; j < active.length; j++) {
      const a = active[i], b = active[j];
      let ta = 0, tb = 0, n = 0, aw = 0, bw = 0;
      for (const r of rows) {
        const pa = r.byStore[a.id], pb = r.byStore[b.id];
        if (!pa || !pb) continue;
        const q = convert(pa.qty || 1, pa.unit, r.item.unit) || 1;
        ta += pa.perUnit * q; tb += pb.perUnit * q; n++;
        if (pa.perUnit < pb.perUnit - 1e-9) aw++; else if (pb.perUnit < pa.perUnit - 1e-9) bw++;
      }
      if (n) pairs.push({ a, b, n, ta, tb, aw, bw });
    }
  }
  return { rows, compared, wins, pairs, missing: rows.filter((r) => !r.compared) };
}
