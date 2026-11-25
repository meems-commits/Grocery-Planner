# Grocery Planner

A phone-friendly grocery budgeting app (installable to your home screen) that replaces the spreadsheet:

- **Which store is cheaper?** Every item keeps a price book per store, compared by unit price (per oz, per lb, each…), so an 18 oz box at one store and a 12 oz box at another compare fairly. Active sales win automatically until they expire.
- **Store showdown.** Prices tab → a head-to-head summary for each pair of stores (who wins on how many items, and what the same basket costs at each), then a side-by-side table of per-unit prices with the winner highlighted, substitute matches flagged (≈), and yearly savings for items you buy weekly or monthly. *Fill in missing prices* has Claude look up the items a store has no price for yet.
- **Cheapest shopping list.** The List tab works out the cheapest plan: one store, or split across stores, only when the savings beat your *extra stop cost* (in store), pickup fees, or the delivery fees, service fees, tips, app markups, order minimums and memberships set per store (delivery). It also shows what the whole list would cost at each store alone.
- **Receipts → prices + pantry.** Snap a paper receipt (or upload a screenshot / PDF / pasted text of a delivery receipt). Claude reads it, expands abbreviations, matches lines to items you already track, and you review before saving. Prices go into the price book, groceries go into your pantry, and matching list items get checked off.
- **This week's deals.** Claude searches the current weekly ads for your stores (near your ZIP), highlights deals on things you actually buy, and shows how each compares to your best known price. One tap adds the sale prices to your price book (they expire on their end date).
- **What to cook.** Saved recipes are ranked by how many ingredients you already have; add the missing ones to your list in one tap, or ask Claude for ideas from what's on hand (and on sale).
- **Bring your spreadsheet.** Settings → *Import spreadsheet (CSV)*. Either `item, store, price, qty, unit, date, category, sale` columns, or one column per store (e.g. `Item, Whole Foods, Giant`).

## Use it on your phone

1. Publish with GitHub Pages (public repo, or a paid plan for private): repo **Settings → Pages → Source: GitHub Actions**. The included workflow deploys on every push to the default branch.
2. Open the Pages URL on your phone → Share → **Add to Home Screen**.
3. Gear icon → paste an Anthropic API key (from console.anthropic.com) and your ZIP code. The key stays on that phone and is sent only to Anthropic. Price comparison, lists, pantry and recipes work without a key; only receipt reading, deal search and recipe ideas use it.

Try it first with **Load sample data**.

### Sharing with your household

Data is stored on each device (no server, no account). Use Settings → **Export backup** / **Import backup** to move it between phones. The API key is never included in backups.

### Importing the comparison workbook

`scripts/import_spreadsheet.py` converts the household `grocery_delivery_comparison*.xlsx` workbook (Cart Comparison, Giant Matches, Giant Receipts, Whole Foods Receipts sheets) into a backup file you can load with Settings → **Import backup**:

```sh
pip install openpyxl
python3 scripts/import_spreadsheet.py grocery_delivery_comparisonv4.xlsx -o grocery-planner-import.json --member wf
```

Add `--link https://<user>.github.io/Grocery-Planner/` to also print a setup link: opening it on a phone loads the data straight into the app. The data travels in the link's `#fragment`, which browsers never send to the web server, so it isn't stored by the host. Treat the link itself as private.

`--member wf` marks stores where you have a delivery membership (repeat it for more stores).

## Development

No build step — plain HTML, CSS and ES modules.

```sh
python3 -m http.server 8000   # then open http://localhost:8000
npm test                      # optimizer + unit tests (Node 20+)
```

| File | What it does |
|---|---|
| `js/optimize.js` | Best price per store, list optimization (tries every store combination), recipe coverage |
| `js/units.js` | Unit conversion for fair unit-price comparison |
| `js/ai.js` | Claude calls: receipt extraction, weekly-ad web search, recipe ideas |
| `js/app.js` | UI |
| `js/store.js` | Data model + localStorage persistence + sample data |
| `js/csv.js` | Spreadsheet import |
| `vendor/anthropic-sdk.js` | Bundled `@anthropic-ai/sdk` 1.7.0 (`npx esbuild` of the package's default export) |

Claude features use model `claude-opus-5-5` with server-side refusal fallback enabled.
