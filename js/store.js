// App state + persistence (localStorage on this device).
const KEY = 'grocery-planner-v1';

export const uid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
export const today = () => new Date().toISOString().slice(0, 10);

export const CATEGORIES = ['Produce', 'Meats', 'Refrigerated', 'Pantry', 'Household Cleaning'];

// Name-based rules, checked in order. First match wins.
const CATEGORY_RULES = [
  ['Household Cleaning', /\b(soap|detergent|dishwasher|laundry|paper towels?|toilet paper|foil|plastic wrap|trash bags?|sponges?|wipes|cleaner|bleach|napkins?|tissues?|scrub)\b/],
  ['Pantry', /\b(canned|can|pouch|snacks?|powder|broth|stock|peanut butter|chocolate|wafers?|candy|cereal|oats|flour|sugar|starch|spice|paprika|cinnamon|salt|pepper|mayonnaise|mayo|sauce|pasta|spaghetti|rice|beans|bread|loaf|sourdough|bagels?|crackers|chips|honey|oil|vinegar|coffee|tea)\b/],
  ['Meats', /\b(chicken|pork|beef|turkey|ham|bacon|sausages?|salmon|shrimp|fish|cod|tuna steak|tenderloin|steak|lamb|bison|ground meat|meatballs?|deli meat)\b/],
  ['Refrigerated', /\b(milk|oatmilk|yogurt|cheese|butter|eggs?|cream|creamer|tofu|tempeh|hummus|juice|frozen|ice cream|kefir|cottage|sour cream|tortillas?)\b/],
  ['Produce', /\b(apples?|bananas?|pears?|plums?|avocados?|potato(es)?|onions?|garlic|spinach|lettuce|kale|squash|beets?|carrots?|berries|blueberries|raspberries|strawberries|grapes|lemons?|limes?|oranges?|clementines?|mandarins?|peppers?|tomato(es)?|cucumbers?|broccoli|cauliflower|celery|herbs?|cilantro|parsley|mushrooms?|zucchini|corn|peach(es)?|melon|mango(es)?)\b/],
];
const LEGACY_CATEGORY = {
  'Refrigerated': 'Refrigerated', 'Meats': 'Meats', Frozen: 'Refrigerated', Bakery: 'Pantry',
  'Pantry': 'Pantry', Snacks: 'Pantry', Beverages: 'Pantry', Baby: 'Pantry',
  Household: 'Household Cleaning', 'Personal Care': 'Household Cleaning', Produce: 'Produce', Pantry: 'Pantry', Other: 'Household Cleaning',
};

/** Pick one of CATEGORIES from an item name (and an optional hint such as an older category). */
export function categorize(name, hint) {
  const n = String(name || '').toLowerCase();
  for (const [cat, re] of CATEGORY_RULES) if (re.test(n)) return cat;
  if (CATEGORIES.includes(hint)) return hint;
  return LEGACY_CATEGORY[hint] || 'Pantry';
}

const CATEGORY_VERSION = 3; // bump to re-sort every item once when the category set or rules change

/** Put every item into one of CATEGORIES. Data saved under an older category set is re-sorted once. Mutates. */
function normalizeCategories(s) {
  s.settings = s.settings || {};
  const resortAll = s.settings.catVersion !== CATEGORY_VERSION;
  let changed = resortAll;
  for (const it of s.items || []) {
    if (resortAll || !CATEGORIES.includes(it.category)) {
      it.category = categorize(it.name, it.category);
      changed = true;
    }
  }
  s.settings.catVersion = CATEGORY_VERSION;
  return changed;
}

const DEFAULT_STATE = () => ({
  version: 1,
  stores: [
    { id: 'wf', name: 'Whole Foods', color: '#00674b', enabled: true, deliveryFee: 9.95, serviceFeePct: 0, deliveryMarkupPct: 0, freeDeliveryOver: 0, pickupFee: 0, tipFlat: 0, minOrder: 0, membership: false, membershipMin: 25, membershipMonthly: 9.99 },
    { id: 'aldi', name: 'Aldi', color: '#00448f', enabled: true, deliveryFee: 3.99, serviceFeePct: 5, deliveryMarkupPct: 15, freeDeliveryOver: 0, pickupFee: 1.99, tipFlat: 0, minOrder: 35, membership: false, membershipMin: 35 },
    { id: 'giant', name: 'Giant', color: '#e4002b', enabled: true, deliveryFee: 7.95, serviceFeePct: 0, deliveryMarkupPct: 0, freeDeliveryOver: 0, pickupFee: 0, tipFlat: 7, minOrder: 60, membership: false, membershipMin: 0 },
  ],
  items: [],
  prices: [],
  pantry: [],
  recipes: [],
  list: [],
  deals: [],
  settings: { apiKey: '', zip: '', mode: 'store', extraStopCost: 3, tip: 0, catVersion: CATEGORY_VERSION },
});

let state = load();
const listeners = new Set();

function load() {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) {
      const loaded = { ...DEFAULT_STATE(), ...JSON.parse(raw) };
      if (normalizeCategories(loaded)) localStorage.setItem(KEY, JSON.stringify(loaded));
      return loaded;
    }
  } catch (e) {
    console.warn('Could not load saved data', e);
  }
  return DEFAULT_STATE();
}

export function getState() {
  return state;
}

export function update(fn) {
  fn(state);
  try {
    localStorage.setItem(KEY, JSON.stringify(state));
  } catch (e) {
    alert('Could not save — storage may be full or blocked.');
  }
  listeners.forEach((l) => l(state));
}

export function subscribe(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function replaceState(next) {
  update((s) => {
    Object.keys(s).forEach((k) => delete s[k]);
    Object.assign(s, DEFAULT_STATE(), next);
    normalizeCategories(s);
  });
}

// ---- lookups ----
export const itemById = (id) => state.items.find((i) => i.id === id);
export const storeById = (id) => state.stores.find((s) => s.id === id);

const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();

/** Find an existing item by exact-ish name, or null. */
export function findItem(name) {
  const n = norm(name);
  if (!n) return null;
  return state.items.find((i) => norm(i.name) === n) || null;
}

/** Lightweight fuzzy search for item pickers. */
export function searchItems(q) {
  const n = norm(q);
  if (!n) return state.items.slice().sort((a, b) => a.name.localeCompare(b.name));
  const words = n.split(' ');
  return state.items
    .map((i) => {
      const t = norm(i.name);
      const score = words.reduce((s, w) => s + (t.includes(w) ? 1 : 0), 0) + (t.startsWith(n) ? 2 : 0);
      return { i, score };
    })
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .map((x) => x.i);
}

/** Get or create an item. Mutates state; call inside update(). */
export function ensureItem(s, { name, category, unit = 'ea' }) {
  category = CATEGORIES.includes(category) ? category : categorize(name, category);
  const n = norm(name);
  let it = s.items.find((i) => norm(i.name) === n);
  if (!it) {
    it = { id: uid(), name: String(name).trim(), category, unit };
    s.items.push(it);
  }
  return it;
}

export function storeByName(s, name) {
  const n = norm(name);
  if (!n) return null;
  return s.stores.find((st) => norm(st.name) === n || n.includes(norm(st.name)) || norm(st.name).includes(n)) || null;
}

// ---- sample data, so the app makes sense before the first receipt ----
export function sampleData() {
  const s = DEFAULT_STATE();
  s.settings = { ...state.settings };
  const d = (daysAgo) => new Date(Date.now() - daysAgo * 86400000).toISOString().slice(0, 10);
  const add = (name, category, unit, wf, giant) => {
    const it = { id: uid(), name, category, unit };
    s.items.push(it);
    for (const [storeId, rec] of [['wf', wf], ['giant', giant]]) {
      if (!rec) continue;
      s.prices.push({ id: uid(), itemId: it.id, storeId, price: rec[0], qty: rec[1], unit: rec[2], date: d(rec[3] ?? 5), sale: !!rec[4], saleEnds: rec[4] ? d(-4) : '', source: 'sample' });
    }
    return it;
  };
  const cheerios = add('Cheerios Original 18 oz', 'Pantry', 'oz', [5.99, 18, 'oz'], [5.49, 18, 'oz']);
  const bananas = add('Bananas', 'Produce', 'lb', [0.49, 1, 'lb', 6], [0.59, 1, 'lb']);
  const milk = add('Organic whole milk', 'Refrigerated', 'gal', [6.49, 1, 'gal'], [6.99, 1, 'gal']);
  const eggs = add('Large eggs, dozen', 'Refrigerated', 'dozen', [4.29, 1, 'dozen'], [3.79, 1, 'dozen', 3, true]);
  const chicken = add('Boneless chicken breast', 'Meats', 'lb', [6.99, 1, 'lb'], [3.99, 1, 'lb', 2, true]);
  const pasta = add('Spaghetti 16 oz', 'Pantry', 'oz', [1.69, 16, 'oz'], [1.29, 16, 'oz']);
  const sauce = add('Marinara sauce 24 oz', 'Pantry', 'oz', [3.99, 24, 'oz'], [4.49, 24, 'oz']);
  const garlic = add('Garlic', 'Produce', 'ea', [0.79, 1, 'ea'], [0.69, 1, 'ea']);
  const spinach = add('Baby spinach 5 oz', 'Produce', 'oz', [2.99, 5, 'oz'], [3.49, 5, 'oz']);
  const parm = add('Parmesan, grated 8 oz', 'Refrigerated', 'oz', [5.99, 8, 'oz'], [4.99, 8, 'oz']);
  const rice = add('Jasmine rice 2 lb', 'Pantry', 'lb', [4.99, 2, 'lb'], [3.99, 2, 'lb']);
  const broccoli = add('Broccoli crowns', 'Produce', 'lb', [2.49, 1, 'lb'], [1.99, 1, 'lb']);
  const pb = add('Peanut butter 16 oz', 'Pantry', 'oz', [2.99, 16, 'oz'], [3.29, 16, 'oz']);
  const bread = add('Whole wheat bread', 'Pantry', 'ea', [3.49, 1, 'ea'], [2.99, 1, 'ea']);

  s.pantry = [pasta, garlic, parm, rice, pb, eggs].map((it) => ({ id: uid(), itemId: it.id, qty: 1, addedDate: d(3) }));
  s.list = [cheerios, bananas, milk, chicken, spinach, broccoli, bread].map((it) => {
    const p = s.prices.find((x) => x.itemId === it.id);
    return { id: uid(), itemId: it.id, qty: it.unit === 'lb' ? 2 : p ? p.qty : 1, unit: it.unit, checked: false };
  });
  s.recipes = [
    { id: uid(), name: 'Spaghetti marinara with spinach', servings: 4, ingredients: [
      { itemId: pasta.id, name: 'spaghetti' }, { itemId: sauce.id, name: 'marinara sauce' }, { itemId: garlic.id, name: 'garlic' },
      { itemId: spinach.id, name: 'baby spinach' }, { itemId: parm.id, name: 'parmesan' }, { name: 'olive oil', staple: true } ],
      instructions: 'Boil pasta. Sauté garlic in olive oil, add sauce and spinach until wilted. Toss with pasta, top with parmesan.' },
    { id: uid(), name: 'Chicken & broccoli rice bowls', servings: 4, ingredients: [
      { itemId: chicken.id, name: 'chicken breast' }, { itemId: broccoli.id, name: 'broccoli' }, { itemId: rice.id, name: 'jasmine rice' },
      { itemId: garlic.id, name: 'garlic' }, { name: 'soy sauce', staple: true } ],
      instructions: 'Cook rice. Sear sliced chicken, add garlic and broccoli, splash of soy sauce. Serve over rice.' },
    { id: uid(), name: 'Egg fried rice', servings: 2, ingredients: [
      { itemId: rice.id, name: 'jasmine rice' }, { itemId: eggs.id, name: 'eggs' }, { itemId: garlic.id, name: 'garlic' }, { name: 'soy sauce', staple: true } ],
      instructions: 'Use day-old rice. Scramble eggs, add garlic and rice, season with soy sauce.' },
  ];
  return s;
}
