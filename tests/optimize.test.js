import { test } from 'node:test';
import assert from 'node:assert/strict';
import { optimizeList, bestPriceAt, compareItem, recipeCoverage } from '../js/optimize.js';
import { convert, unitPrice, normUnit } from '../js/units.js';

const stores = [
  { id: 'wf', name: 'Whole Foods', deliveryFee: 10, deliveryMarkupPct: 0 },
  { id: 'g', name: 'Giant', deliveryFee: 5, deliveryMarkupPct: 10 },
];
const items = [
  { id: 'cheerios', name: 'Cheerios', unit: 'oz' },
  { id: 'banana', name: 'Bananas', unit: 'lb' },
  { id: 'milk', name: 'Milk', unit: 'gal' },
];
const P = (itemId, storeId, price, qty, unit, extra = {}) => ({ id: Math.random() + '', itemId, storeId, price, qty, unit, date: '2026-11-20', ...extra });

test('units convert', () => {
  assert.equal(convert(1, 'lb', 'oz'), 16);
  assert.equal(convert(1, 'lb', 'gal'), null);
  assert.equal(normUnit('LBS'), 'lb');
  assert.ok(Math.abs(unitPrice(5.49, 18, 'oz', 'oz') - 0.305) < 0.001);
});

test('unit price compares different package sizes', () => {
  const prices = [P('cheerios', 'wf', 5.99, 18, 'oz'), P('cheerios', 'g', 4.0, 12, 'oz')];
  const rows = compareItem(items[0], stores, prices);
  assert.equal(rows[0].store.id, 'wf'); // 0.333 vs 0.333.. wf 0.3328 < g 0.3333
});

test('active sale beats regular, expired sale ignored', () => {
  const now = new Date('2026-11-25T12:00:00').getTime();
  const prices = [
    P('banana', 'g', 0.69, 1, 'lb'),
    P('banana', 'g', 0.39, 1, 'lb', { sale: true, saleEnds: '2026-11-28' }),
    P('banana', 'wf', 0.49, 1, 'lb'),
    P('banana', 'wf', 0.19, 1, 'lb', { sale: true, saleEnds: '2026-11-01' }),
  ];
  assert.equal(bestPriceAt(items[1], 'g', prices, now).perUnit, 0.39);
  assert.equal(bestPriceAt(items[1], 'wf', prices, now).perUnit, 0.49);
});

test('split trip only when savings beat extra stop cost', () => {
  const prices = [
    P('cheerios', 'wf', 6, 18, 'oz'), P('cheerios', 'g', 5, 18, 'oz'),
    P('banana', 'wf', 0.49, 1, 'lb'), P('banana', 'g', 0.59, 1, 'lb'),
  ];
  const list = [
    { id: 'a', itemId: 'cheerios', qty: 18, unit: 'oz' },
    { id: 'b', itemId: 'banana', qty: 2, unit: 'lb' },
  ];
  // split saves 1.00 + 0.20 = 1.20; extra stop costs 3 -> one store (Giant: 5 + 1.18 = 6.18)
  let r = optimizeList({ list, items, stores, prices, settings: { extraStopCost: 3 } });
  assert.equal(r.plan.groups.length, 1);
  assert.equal(r.plan.groups[0].store.id, 'g');
  assert.ok(Math.abs(r.plan.total - 6.18) < 1e-9);
  // free extra stops -> split
  r = optimizeList({ list, items, stores, prices, settings: { extraStopCost: 0 } });
  assert.equal(r.plan.groups.length, 2);
  assert.ok(Math.abs(r.plan.total - 5.98) < 1e-9);
  assert.ok(Math.abs(r.savingsVsSingle - 0.2) < 1e-9);
});

test('delivery adds markup and fees', () => {
  const prices = [P('milk', 'wf', 6, 1, 'gal'), P('milk', 'g', 5, 1, 'gal')];
  const list = [{ id: 'a', itemId: 'milk', qty: 1, unit: 'gal' }];
  const r = optimizeList({ list, items, stores, prices, mode: 'delivery', settings: {} });
  // giant: 5*1.1 + 5 = 10.5 ; wf: 6 + 10 = 16
  assert.equal(r.plan.groups[0].store.id, 'g');
  assert.ok(Math.abs(r.plan.total - 10.5) < 1e-9);
});

test('items priced at only one store force that store; unpriced reported', () => {
  const prices = [P('milk', 'wf', 6, 1, 'gal'), P('cheerios', 'g', 5, 18, 'oz')];
  const list = [
    { id: 'a', itemId: 'milk', qty: 1, unit: 'gal' },
    { id: 'b', itemId: 'cheerios', qty: 18, unit: 'oz' },
    { id: 'c', itemId: 'banana', qty: 1, unit: 'lb' },
  ];
  const r = optimizeList({ list, items, stores, prices, settings: { extraStopCost: 3 } });
  assert.equal(r.plan.groups.length, 2);
  assert.equal(r.unpriced.length, 1);
  assert.equal(r.bestSingle, null);
});

test('recipe coverage', () => {
  const recipe = { ingredients: [{ itemId: 'milk', name: 'milk' }, { name: 'bananas' }, { name: 'salt', staple: true }] };
  const c = recipeCoverage(recipe, [{ itemId: 'milk', qty: 1 }], items);
  assert.equal(c.total, 2);
  assert.equal(c.haveCount, 1);
});
