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
  if (mode === 'delivery') cost *= 1 + (Number(store.deliveryMarkupPct) || 0) / 100;
  return { cost, best };
}

function storeOverhead(store, subtotal, mode, isExtraStop, settings) {
  if (mode === 'delivery') {
    const fee = Number(store.deliveryFee) || 0;
    const svc = ((Number(store.serviceFeePct) || 0) / 100) * subtotal;
    const freeOver = Number(store.freeDeliveryOver) || 0;
    const deliveryFee = freeOver && subtotal >= freeOver ? 0 : fee;
    return deliveryFee + svc + (Number(settings.tip) || 0);
  }
  return isExtraStop ? Number(settings.extraStopCost) || 0 : 0;
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
        const overhead = storeOverhead(g.store, g.subtotal, mode, i > 0, settings);
        return { ...g, overhead, total: g.subtotal + overhead };
      });
    const total = groups.reduce((t, g) => t + g.total, 0);
    return { groups, total, missing };
  };

  let best = null;
  const n = activeStores.length;
  for (let mask = 1; mask < 1 << n; mask++) {
    const subset = activeStores.filter((_, i) => mask & (1 << i));
    const r = evaluate(subset, false);
    if (r && (!best || r.total < best.total - 0.005 || (Math.abs(r.total - best.total) < 0.005 && r.groups.length < best.groups.length))) {
      best = r;
    }
  }
  if (!best && priced.length) best = evaluate(activeStores, true);

  const singles = activeStores.map((s) => {
    const r = evaluate([s], true);
    return { store: s, total: r.total, missingCount: r.missing.length, missing: r.missing };
  }).sort((a, b) => a.missingCount - b.missingCount || a.total - b.total);

  const bestSingleComplete = singles.find((s) => s.missingCount === 0);
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
