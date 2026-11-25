// Claude-powered features: receipt reading, weekly-deal search, recipe ideas.
// Calls go straight from the phone to the Anthropic API using the key saved
// in Settings (stored only on this device).
import Anthropic from '../vendor/anthropic-sdk.js';
import { getState } from './store.js';
import { UNIT_OPTIONS } from './units.js';

const MODEL = 'claude-opus-5-5';

function client() {
  const key = getState().settings.apiKey;
  if (!key) throw new Error('Add your Anthropic API key in Settings (gear icon) to use this.');
  return new Anthropic({ apiKey: key, dangerouslyAllowBrowser: true });
}

function friendlyError(e) {
  if (e instanceof Anthropic.AuthenticationError) return new Error('Your API key was rejected. Check it in Settings.');
  if (e instanceof Anthropic.RateLimitError) return new Error('Rate limited by the API — wait a minute and try again.');
  if (e instanceof Anthropic.APIConnectionError) return new Error('Could not reach the Anthropic API. Check your connection.');
  if (e instanceof Anthropic.APIError) return new Error(`API error (${e.status}): ${e.message}`);
  return e;
}

/** One request with structured JSON output. Returns parsed object. */
async function structured({ system, content, schema, effort = 'low' }) {
  const c = client();
  try {
    const msg = await c.beta.messages
      .stream({
        model: MODEL,
        max_tokens: 32000,
        betas: ['server-side-fallback-2026-07-01'],
        fallbacks: 'default',
        output_config: { effort, format: { type: 'json_schema', schema } },
        system,
        messages: [{ role: 'user', content }],
      })
      .finalMessage();
    if (msg.stop_reason === 'refusal') throw new Error('Claude declined this request.');
    if (msg.stop_reason === 'max_tokens') throw new Error('The response was too long — try a smaller request.');
    const text = msg.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
    return JSON.parse(text);
  } catch (e) {
    throw friendlyError(e);
  }
}

const nullable = (type) => ({ type: [type, 'null'] });
const obj = (properties) => ({ type: 'object', additionalProperties: false, required: Object.keys(properties), properties });

// ---------------- Receipts ----------------

const RECEIPT_SCHEMA = obj({
  store: nullable('string'),
  date: { ...nullable('string'), description: 'YYYY-MM-DD' },
  is_delivery: { type: 'boolean', description: 'true if this is a delivery/online order receipt (Instacart, Amazon, store app)' },
  subtotal: nullable('number'),
  total: nullable('number'),
  lines: {
    type: 'array',
    items: obj({
      raw: { type: 'string', description: 'line text exactly as printed' },
      name: { type: 'string', description: 'clean product name a person would use, with brand and size, e.g. "Cheerios Original 18 oz" or "Bananas"' },
      match: { ...nullable('string'), description: 'exact name from KNOWN ITEMS if it is the same product, else null' },
      category: { type: 'string', enum: ['Produce', 'Meats', 'Refrigerated', 'Pantry', 'Household Cleaning'] },
      count: { type: 'number', description: 'number of packages/units bought (1 for weighed produce)' },
      size_qty: { type: 'number', description: 'size of ONE package (or weight bought, for by-the-pound items)' },
      size_unit: { type: 'string', enum: UNIT_OPTIONS },
      line_total: { type: 'number', description: 'amount paid for this line after line-level discounts' },
      regular_price: { ...nullable('number'), description: 'pre-discount line total if a sale/member discount is shown' },
      on_sale: { type: 'boolean' },
      is_food: { type: 'boolean', description: 'false for bags, deposits, tax, household goods etc.' },
    }),
  },
});

async function fileToBlock(file) {
  if (file.type === 'application/pdf') {
    const data = await toBase64(file);
    return { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data } };
  }
  const data = await shrinkImage(file, 2000);
  return { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data } };
}

function toBase64(blob) {
  return new Promise((res, rej) => {
    const r = new FileReader();
    r.onload = () => res(String(r.result).split(',')[1]);
    r.onerror = rej;
    r.readAsDataURL(blob);
  });
}

async function shrinkImage(file, maxSide) {
  const bmp = await createImageBitmap(file);
  const scale = Math.min(1, maxSide / Math.max(bmp.width, bmp.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(bmp.width * scale);
  canvas.height = Math.round(bmp.height * scale);
  canvas.getContext('2d').drawImage(bmp, 0, 0, canvas.width, canvas.height);
  const blob = await new Promise((r) => canvas.toBlob(r, 'image/jpeg', 0.85));
  return toBase64(blob);
}

export async function readReceipt({ files = [], text = '' }) {
  const s = getState();
  const known = s.items.map((i) => i.name).slice(0, 600);
  const content = [];
  for (const f of files) content.push(await fileToBlock(f));
  content.push({
    type: 'text',
    text:
      (text ? `RECEIPT TEXT:\n${text}\n\n` : '') +
      `STORES WE SHOP AT: ${s.stores.map((x) => x.name).join(', ')}\n` +
      `KNOWN ITEMS (reuse these exact names when it is the same product):\n${known.join('\n') || '(none yet)'}\n\n` +
      `Read every purchased line on this grocery receipt. Expand abbreviations (e.g. "GM CHRIOS 18OZ" -> "Cheerios Original 18 oz"). ` +
      `For by-weight produce/meat, use size_unit "lb" with the weight bought and count 1. ` +
      `Fold coupon/member-discount lines into the item they apply to. Skip tax, totals, payment and bag-fee lines. ` +
      `Category is one of: Produce (fresh fruit & vegetables), Meats (meat, poultry, fish, deli meat), Refrigerated (dairy, eggs, cheese, plant milks, tofu, frozen foods), Pantry (shelf-stable food: canned, dry goods, cereal, bread, snacks, baby food), Household Cleaning (soaps, detergent, paper goods and other non-food household items).`,
  });
  return structured({
    system: 'You extract structured data from grocery receipts accurately. Never invent lines that are not on the receipt.',
    content,
    schema: RECEIPT_SCHEMA,
    effort: 'medium',
  });
}

// ---------------- Weekly deals (web search) ----------------

const DEALS_SCHEMA = obj({
  deals: {
    type: 'array',
    items: obj({
      store: { type: 'string' },
      item: { type: 'string', description: 'product as advertised, with brand and size' },
      match: { ...nullable('string'), description: 'exact name from WATCH LIST if it is the same/equivalent product, else null' },
      category: { type: 'string', enum: ['Produce', 'Meats', 'Refrigerated', 'Pantry', 'Household Cleaning'] },
      sale_price: { type: 'number', description: 'price for size_qty size_unit' },
      size_qty: { type: 'number' },
      size_unit: { type: 'string', enum: UNIT_OPTIONS },
      regular_price: nullable('number'),
      deal_text: { type: 'string', description: 'short description e.g. "BOGO", "2 for $5", "Prime members"' },
      member_only: { type: 'boolean', description: 'requires loyalty card / Prime / app coupon' },
      valid_from: { ...nullable('string'), description: 'YYYY-MM-DD' },
      valid_to: { ...nullable('string'), description: 'YYYY-MM-DD' },
      source_url: nullable('string'),
    }),
  },
  notes: { type: 'string', description: 'caveats, e.g. could not find a current ad for a store' },
});

export async function findDeals({ storeNames, watchList, zip, onStatus = () => {} }) {
  const c = client();
  const dateStr = new Date().toDateString();
  const loc = zip ? `near ZIP code ${zip}` : 'in the US';
  const prompt =
    `Today is ${dateStr}. Find the CURRENT weekly ad / featured sale prices at these grocery stores ${loc}: ${storeNames.join(', ')}.\n\n` +
    `Prioritise deals on these items we buy (and close equivalents):\n${watchList.join('\n') || '(no list yet — report the best grocery deals)'}\n\n` +
    `Use the stores' own weekly ad pages, circular sites, and deal roundups dated this week. ` +
    `For each deal give store, product, price and size, any conditions (member/Prime/digital coupon, multi-buy), valid dates and the source URL. ` +
    `Only report deals you actually found in a current source; say clearly if a store's current ad could not be found.`;

  let messages = [{ role: 'user', content: prompt }];
  let research = '';
  try {
    onStatus('Searching current weekly ads…');
    for (let turn = 0; turn < 4; turn++) {
      const msg = await c.beta.messages
        .stream({
          model: MODEL,
          max_tokens: 64000,
          betas: ['server-side-fallback-2026-07-01'],
          fallbacks: 'default',
          output_config: { effort: 'medium' },
          tools: [{ type: 'web_search_20260209', name: 'web_search', max_uses: 12 }],
          messages,
        })
        .finalMessage();
      if (msg.stop_reason === 'refusal') throw new Error('Claude declined this request.');
      research += msg.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
      if (msg.stop_reason !== 'pause_turn') break;
      onStatus('Still searching…');
      messages = [...messages, { role: 'assistant', content: msg.content }];
    }
  } catch (e) {
    throw friendlyError(e);
  }

  onStatus('Organizing deals…');
  const out = await structured({
    system: 'You convert grocery deal research notes into structured records. Do not add deals that are not in the notes.',
    content: [{
      type: 'text',
      text: `WATCH LIST:\n${watchList.join('\n')}\n\nSTORES: ${storeNames.join(', ')}\nTODAY: ${new Date().toISOString().slice(0, 10)}\n\nRESEARCH NOTES:\n${research}`,
    }],
    schema: DEALS_SCHEMA,
  });
  return { ...out, research };
}

// ---------------- Recipe ideas ----------------

const RECIPES_SCHEMA = obj({
  recipes: {
    type: 'array',
    items: obj({
      name: { type: 'string' },
      servings: { type: 'number' },
      minutes: { type: 'number' },
      ingredients: {
        type: 'array',
        items: obj({
          name: { type: 'string' },
          match: { ...nullable('string'), description: 'exact name from ON HAND if used, else null' },
          amount: { type: 'string' },
          staple: { type: 'boolean', description: 'basic staple like salt, oil, pepper' },
        }),
      },
      instructions: { type: 'string' },
    }),
  },
});

export async function recipeIdeas({ onHand, onSale, request }) {
  return structured({
    system: 'You are a practical home cook helping a family use up groceries and stay on budget.',
    content: [{
      type: 'text',
      text:
        `ON HAND:\n${onHand.join('\n') || '(nothing recorded)'}\n\n` +
        (onSale.length ? `ON SALE THIS WEEK:\n${onSale.join('\n')}\n\n` : '') +
        `Suggest 5 weeknight recipes that use mostly what is on hand (use items that spoil soonest, like produce, first). ` +
        `Keep extra purchases few and prefer on-sale items for them. ${request ? 'Request: ' + request : ''}`,
    }],
    schema: RECIPES_SCHEMA,
    effort: 'low',
  });
}

// ---------------- Price lookup for items missing a store price ----------------

const LOOKUP_SCHEMA = obj({
  results: {
    type: 'array',
    items: obj({
      item: { type: 'string', description: 'the item name exactly as given' },
      found: { type: 'boolean' },
      product: { type: 'string', description: "the store's product name, with brand and size" },
      match: { type: 'string', enum: ['exact', 'close', 'substitute'], description: 'exact = same brand and product; close = equivalent (e.g. store brand); substitute = different but usable' },
      price: { type: 'number', description: 'current shelf/app price for one package (0 if not found)' },
      size_qty: { type: 'number' },
      size_unit: { type: 'string', enum: UNIT_OPTIONS },
      on_sale: { type: 'boolean' },
      regular_price: nullable('number'),
      source_url: nullable('string'),
      note: { type: 'string', description: 'caveats: price seen on Instacart, may vary by store, etc.' },
    }),
  },
});

export async function lookupPrices({ storeName, zip, items, onStatus = () => {} }) {
  const c = client();
  const lines = items.map((i, n) =>
    `${n + 1}. ${i.name}` +
    (i.wanted ? ` — known match at ${storeName}: ${i.wanted}` : '') +
    (i.reference ? ` — we usually buy: ${i.reference}` : '') +
    (i.brandLocked ? ' — BRAND MATTERS, same brand only' : ' — store brand is fine') +
    (i.link ? `\n   product page: ${i.link}` : '')
  ).join('\n');
  const prompt =
    `Today is ${new Date().toDateString()}. Find the current price at ${storeName}${zip ? ` (store near ZIP ${zip})` : ''} for each grocery item below. ` +
    `Use ${storeName}'s own website or app listings first, then its Instacart storefront. Fetch the product pages given where possible. ` +
    `Report the package price and size, whether it is a sale price, the product you matched and the source URL. ` +
    `If you cannot find a current price for an item, say so rather than guessing.\n\n${lines}`;
  let messages = [{ role: 'user', content: prompt }];
  let research = '';
  try {
    onStatus(`Searching ${storeName}…`);
    for (let turn = 0; turn < 4; turn++) {
      const msg = await c.beta.messages
        .stream({
          model: MODEL,
          max_tokens: 64000,
          betas: ['server-side-fallback-2026-07-01'],
          fallbacks: 'default',
          output_config: { effort: 'medium' },
          tools: [
            { type: 'web_search_20260209', name: 'web_search', max_uses: 15 },
            { type: 'web_fetch_20260209', name: 'web_fetch', max_uses: 15 },
          ],
          messages,
        })
        .finalMessage();
      if (msg.stop_reason === 'refusal') throw new Error('Claude declined this request.');
      research += msg.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
      if (msg.stop_reason !== 'pause_turn') break;
      onStatus('Still searching…');
      messages = [...messages, { role: 'assistant', content: msg.content }];
    }
  } catch (e) {
    throw friendlyError(e);
  }
  onStatus('Organizing results…');
  return structured({
    system: 'You convert grocery price research notes into structured records. Never invent prices that are not in the notes; mark those items found=false.',
    content: [{ type: 'text', text: `STORE: ${storeName}\nITEMS (use these exact names in "item"):\n${items.map((i) => i.name).join('\n')}\n\nRESEARCH NOTES:\n${research}` }],
    schema: LOOKUP_SCHEMA,
  });
}
