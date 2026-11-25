// Unit handling: every quantity is converted to a base unit within its
// dimension so prices from different package sizes can be compared.
//   weight -> oz, volume -> fl oz, count -> ea

const UNITS = {
  oz: { dim: 'weight', toBase: 1 },
  lb: { dim: 'weight', toBase: 16 },
  g: { dim: 'weight', toBase: 1 / 28.3495 },
  kg: { dim: 'weight', toBase: 35.274 },
  'fl oz': { dim: 'volume', toBase: 1 },
  cup: { dim: 'volume', toBase: 8 },
  pt: { dim: 'volume', toBase: 16 },
  qt: { dim: 'volume', toBase: 32 },
  gal: { dim: 'volume', toBase: 128 },
  ml: { dim: 'volume', toBase: 1 / 29.5735 },
  l: { dim: 'volume', toBase: 33.814 },
  ea: { dim: 'count', toBase: 1 },
  ct: { dim: 'count', toBase: 1 },
  dozen: { dim: 'count', toBase: 12 },
};

export const UNIT_OPTIONS = ['ea', 'lb', 'oz', 'fl oz', 'gal', 'qt', 'ct', 'dozen', 'g', 'kg', 'l', 'ml'];

const ALIASES = {
  each: 'ea', unit: 'ea', units: 'ea', pc: 'ea', pcs: 'ea', piece: 'ea', pieces: 'ea', item: 'ea', bunch: 'ea', pk: 'ea', pack: 'ea',
  count: 'ct', cnt: 'ct',
  lbs: 'lb', pound: 'lb', pounds: 'lb', '#': 'lb',
  ounce: 'oz', ounces: 'oz', 'oz.': 'oz',
  floz: 'fl oz', 'fl. oz': 'fl oz', 'fl.oz': 'fl oz', 'fluid ounce': 'fl oz', 'fluid ounces': 'fl oz',
  gallon: 'gal', gallons: 'gal', quart: 'qt', quarts: 'qt', pint: 'pt', pints: 'pt', cups: 'cup',
  liter: 'l', liters: 'l', litre: 'l', lt: 'l', milliliter: 'ml', milliliters: 'ml',
  gram: 'g', grams: 'g', kilogram: 'kg', kilograms: 'kg', dz: 'dozen', doz: 'dozen',
};

export function normUnit(u) {
  if (!u) return 'ea';
  const k = String(u).trim().toLowerCase();
  if (UNITS[k]) return k;
  if (ALIASES[k]) return ALIASES[k];
  return 'ea';
}

export function dimOf(u) {
  return UNITS[normUnit(u)].dim;
}

/** Convert qty in `from` units to `to` units. Returns null if dimensions differ. */
export function convert(qty, from, to) {
  const a = UNITS[normUnit(from)];
  const b = UNITS[normUnit(to)];
  if (a.dim !== b.dim) return null;
  return (qty * a.toBase) / b.toBase;
}

/** Price per one `displayUnit`, given a package price for qty+unit. */
export function unitPrice(price, qty, unit, displayUnit) {
  const q = convert(qty || 1, unit, displayUnit || unit);
  if (q == null || q <= 0) return null;
  return price / q;
}

export function fmtQty(qty, unit) {
  const n = Math.round(qty * 100) / 100;
  return `${n} ${normUnit(unit)}`;
}
