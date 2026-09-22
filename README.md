# SoBooster

A Shopify embedded admin app. The merchant configures their storefront's
search-and-filter experience here: which filters exist, what they are called,
how they render, and which values shoppers see.

**The app stores no products.** Filter values are read live from the
merchant's own Shopify catalogue through the Admin API. What is stored is only
the decisions made about them.

```
Shopify    owns what EXISTS          vendors, collections, colours, tags
this app   owns what was DECIDED     shown, renamed, reordered, swatched
```

---

## Contents

- [Screens](#screens)
- [Setup](#setup)
- [What the merchant can configure](#what-the-merchant-can-configure)
- [How it works](#how-it-works)
- [Where filter values come from](#where-filter-values-come-from)
- [Database](#database)
- [The published configuration](#the-published-configuration)
- [Tests](#tests)
- [Assumptions, limitations and trade-offs](#assumptions-limitations-and-trade-offs)
- [Scaling to 150,000 products](#scaling-to-150000-products)
- [Third-party libraries and AI tools](#third-party-libraries-and-ai-tools)

---

## Screens

| Route | What it does |
| --- | --- |
| `/filters` | **Filter settings.** Groups on the left in storefront order, the selected group's settings on the right. |
| `/filters/config` | The whole configuration as JSON. Every change returns it. |
| `/filters/published` | What a storefront would consume: enabled groups, visible values, nothing left to decide. |
| `/filters/refresh` | Re-read the merchant's catalogue from Shopify. |
| `/dashboard` (`/`) | Landing screen. Heading only. |
| `/plans` | Free / Starter / Pro, with Shopify subscription billing. |
| `/support` | Help and support. Heading only. |
| `/api/auth/install`, `/api/auth/callback` | Shopify OAuth. |
| `/webhooks/...` | App uninstall plus the three mandatory privacy topics. |

---

## Setup

Requires **Node.js 18+** and **MySQL or MariaDB**. Developed against MariaDB
10.4 (XAMPP) and Shopify Admin API `2026-07`.

```bash
git clone <this repo>
cd SoBooster
npm install
cp .env.example .env
```

Create the database (tables are created for you, the database itself is not):

```sql
CREATE DATABASE SoBooster DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
```

Fill in `.env`:

| Variable | Notes |
| --- | --- |
| `SHOPIFY_API_KEY`, `SHOPIFY_API_SECRET` | Partner Dashboard → your app → Configuration → Client credentials. |
| `HOST` | Public HTTPS URL, no trailing slash. Must match the App URL in the Partner Dashboard, and the allowed redirect URL there must be `HOST` + `/api/auth/callback`. |
| `SHOPIFY_SCOPES` | `read_products` is enough — it covers products, variants, options, collections, vendors and tags. |
| `TOKEN_ENCRYPTION_KEY` | 32 bytes, base64. Generate once and back it up: rotating it makes every stored Shopify token unreadable. |
| `DB_*` | MySQL connection. |
| `DUMMY_SHOPS` | Optional, comma-separated. Development stores that get a Shopify **test** charge rather than a real one. |
| `FILTER_SCAN_PAGES` | Optional. How many 250-product pages to walk when collecting option values. Default 20 (5,000 products). |

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
npm run dev     # or: npm start
```

Shopify has to reach `HOST`, so for local work expose the port with a tunnel
(VS Code dev tunnels, cloudflared, ngrok), set `HOST` and the Partner Dashboard
URLs to the tunnel address, then install on a development store and open the
app from **Apps** in the Shopify admin.

There is nothing to seed. On first open the app creates five default filter
groups and reads the shop's catalogue.

---

## What the merchant can configure

**Per group** — Collection, Product type, Vendor, Price, Availability come as
defaults; Colour, Size and custom groups are added from what the shop actually
has.

| Setting | Notes |
| --- | --- |
| On / off | Hides a filter without losing its settings. |
| Name | What shoppers see. Renaming never moves the storefront URL key. |
| Display type | Checkbox list, swatches, dropdown, buttons, price range — restricted to what the source can render. |
| Order | Drag the groups. The order here is the order shoppers see. |
| Value order | A to Z, most products first, or manual (pinned first). |
| Values before "show more" | 1–100. |
| Multi-select | Off means choosing a value replaces the previous one. |
| Hide values with no products | Keeps the panel to what a shopper can pick. |
| Start collapsed | For long lists. |

**Per value** — inside a group:

| Control | Notes |
| --- | --- |
| Show / hide | Hidden values stay in the settings list, dimmed, so they can be brought back. |
| Rename | "Powder" → "Powder Blue". The raw Shopify value is shown beneath, and is what the storefront URL still uses. |
| Swatch colour | For groups displayed as swatches. |
| Pin | Pinned values sort first whatever the value order says. |
| Reset all | Drops every customisation in the group. |

**Custom groups** — a group whose values come from a product option ("Color",
"Size"), or from a **tag prefix**. Merchants routinely encode structured data
in tags because Shopify gives them nowhere else to put it, so
`material:cotton` and `material:silk` become a "Material" filter with the
values Cotton and Silk. The app scans the shop's tags and suggests prefixes it
finds used more than once.

---

## How it works

**Server-rendered shell, client-rendered panes, server-owned state.**

Express, EJS and `mysql2`. No frontend framework and no build step: the screen
is two panes and one JSON endpoint per action.

```
merchant action ─▶ PATCH/POST ─▶ model validates ─▶ whole config returned ─▶ redraw
```

Every write returns the **entire configuration**, and the screen redraws from
it. That is deliberate. An optimistic local update would eventually disagree
with what was actually saved — a rejected label, a clamped number, a rule
about which display types a source allows — and the merchant would be
configuring a setting that does not exist. Redrawing from the server's answer
means the screen can only ever show saved state.

### Files that matter

```
services/shopifyCatalog.js       Reads filter values from the Shopify Admin API.
models/filterModel.js            Groups, per-value overrides, validation, merging.
controllers/filterController.js  The screen, the JSON endpoints, the published config.
views/filters.ejs                The shell (both panes are drawn by JS).
public/javascript/filters.js     The screen: panes, drag-reorder, dialog, saving.
```

### Rules the model enforces

- **A display type must suit its source.** Price is a range and nothing else;
  a vendor cannot be swatches. Offering every type for every source would let
  a merchant build a filter that cannot render.
- **A built-in group is disabled, never deleted.** Every shop has vendors and
  prices; a merchant who deleted "Price" would have no way to get it back, and
  "off" is what they meant.
- **A group's source is immutable.** Changing where values come from would
  strand every per-value override. Delete and recreate instead.
- **Two groups never share a storefront key.** Keys are derived from the label
  then made unique, so two groups called "Colour" cannot fight over `?colour=`.
- **An override row exists only while it says something.** Clear every field
  and the row is deleted, so "has this been customised?" is answered by the
  row's existence.
- Swatches must be `#rgb` or `#rrggbb` — the value ends up in a style
  attribute.

Everything is scoped by `store_id`, taken from the verified session token.
`req.storeId` is the only store a request can read or write.

---

## Where filter values come from

Two shapes of query, chosen per source because they cost very different
amounts:

| Source | How | Cost |
| --- | --- | --- |
| Vendor, Product type, Tag | `shop { productVendors / productTypes / productTags }` | One query each. Shopify already keeps these lists. |
| Collection | `collections` with `productsCount` | Paged; carries real product counts. |
| Product option (Color, Size) | Walk `products { options { name optionValues } }` | One walk serves **every** option group. |
| Tag prefix | Derived from the tag list | Free — no extra query. |
| Price, Availability | Computed at filter time | No value list. |

Two details that matter in practice:

- **Shopify's placeholder option is excluded.** Every product without real
  options gets one called `Title` whose only value is `Default Title`. It is an
  artefact of the data model, not something a shopper would filter on. A
  product that *genuinely* names an option `Title` with real values is kept —
  the test store has one.
- **The product walk is capped** at `FILTER_SCAN_PAGES` × 250 (default 5,000).
  Past that the result is marked `truncated` and the screen says so, rather
  than quietly showing a partial list as if it were complete.

Results are cached in `filter_source_cache` per store and source. Without it,
opening the settings screen would call the Admin API five or six times before
anything rendered and every reload would spend more of the shop's rate limit.
The merchant refreshes explicitly; the header shows how old the values are.

---

## Database

| Table | Holds |
| --- | --- |
| `filter_groups` | One configurable group. `source` says where values come from, `filter_key` is the storefront query-string key. |
| `filter_options` | Per-value overrides — **only** for values the merchant has said something about. |
| `filter_source_cache` | Values last read from Shopify, per store and source, with `fetched_at`. |
| `stores` | One row per installed store. Shopify tokens are AES-256-GCM encrypted. |
| `dummy_shops` | Development stores that get a Shopify test charge. |
| `plans`, `user_memberships`, `membership_payments` | Subscription billing. |

`config/migrate.js` creates them on boot; `sql/schema.sql` is the same shape as
one script. Storing overrides sparsely is what lets a shop add a new colour and
have it appear in the panel automatically, with no sync step.

---

## The published configuration

`GET /filters/published` is the contract a storefront would build against.
Disabled groups and hidden values are already gone, so the consumer renders
what it is given without re-deciding anything:

```json
{
  "shop": "example.myshopify.com",
  "filters": [
    {
      "key": "colour",
      "label": "Colour",
      "source": "option",
      "source_key": "Color",
      "display": "swatch",
      "collapsed": false,
      "max_visible": 10,
      "hide_empty": true,
      "multi_select": true,
      "values": [
        { "value": "Powder", "label": "Powder Blue", "swatch": "#9ec8e8" }
      ]
    }
  ]
}
```

`value` is what Shopify calls it and what the storefront URL uses; `label` is
what the shopper reads. Keeping both is what lets a merchant rename a value
without breaking links that are already shared.

---

## Tests

```bash
npm test
```

142 assertions across four suites, **no database, no Shopify and no browser** —
the suites that need data stub the connection pool.

| Suite | Covers |
| --- | --- |
| `filters.test.js` | Display-type rules, built-in protection, key uniqueness, sparse overrides, value merging and sorting, Shopify's placeholder option, tag-prefix parsing, reordering. |
| `views.test.js` | Every screen renders with exactly the locals its controller passes; the bootstrap payload is valid JSON; a hostile vendor name cannot break out of it. |
| `security.test.js` | Webhook HMAC, session tokens, OAuth state and HMAC, open-redirect refusal. |
| `tokens.test.js` | Token refresh, rotation, concurrency, reauth. |

Beyond the suite, the screen was driven end to end against the running server
**and a real Shopify development store** with a minted session token — 68
checks covering defaults, live catalogue reads, editing, per-value overrides,
custom groups, reordering, deletion rules, the published config, refresh and
tenancy — and rendered in headless Chrome to confirm the two panes, the values
list and the swatch editor.

---

## Assumptions, limitations and trade-offs

**Assumptions**

- `read_products` covers everything needed: products, options, collections,
  vendors and tags. No extra scopes are requested.
- A merchant configures filters far more often than their option names change,
  so catalogue values are cached and refreshed on demand rather than on every
  page load.
- Product counts are shown where they are cheap (collections, product options)
  and omitted where they would cost one query per value (vendors, types, tags).

**Limitations**

- **Option values are collected by walking products**, capped at 5,000. There
  is no shop-level "every value of the Color option" query in the Admin API.
  Past the cap the screen says the list is partial. This is the first thing to
  change at catalogue scale — see below.
- **Nothing consumes the published configuration yet.** The storefront filter
  UI is a separate piece of work; this app produces the configuration and the
  contract for it.
- **The refresh is synchronous.** A shop near the scan cap will wait several
  seconds for the Refresh button. It belongs in a background job.
- **Catalogue values can go stale** between refreshes. A value deleted in
  Shopify shows as "no longer in Shopify" once refreshed, but not before.
- **No audit trail.** There is no record of who changed a filter or when, and
  no undo beyond "Reset all" per group.
- Reordering is drag-and-drop only, so it needs a pointer — a keyboard-driven
  reorder is missing.

**Trade-offs taken deliberately**

| Decision | Instead of | Why |
| --- | --- | --- |
| Read values live from Shopify | Store a product catalogue in this app | Shopify is the source of truth. A copied catalogue is a sync problem, a staleness problem and a storage problem, for a screen that needs a list of names. |
| Sparse overrides | A row per value per group | The catalogue owns what exists. Materialising every value means a new colour in Shopify is invisible until a sync runs. |
| Whole config returned on every write | Optimistic local updates | The server clamps, validates and rejects. Redrawing from its answer means the screen cannot show a setting that was not saved. |
| Vanilla JS, no build step | React / Vue | Two panes and a dialog. A framework adds a toolchain without removing any of the logic. |
| Built-ins disabled, not deleted | Uniform delete | A merchant cannot recreate "Price" from the Add dialog, so deleting it would be a one-way door. |
| Source immutable after creation | Editable source | Every per-value override is keyed to the source's values; changing it silently orphans them. |

---

## Scaling to 150,000 products

What changes when the merchant has 150k products. The short version: **the
option walk becomes a bulk operation feeding a stored index, and everything
slow moves into a queue.**

### 1. Reading option values

The one query here that does not scale is the products walk. At 150k products
that is 600 paged requests for a settings screen.

**Initial read: `bulkOperationRunQuery`.** It runs the query server-side and
hands back a JSONL file to stream — one request, no pagination, and it does not
burn the query-cost budget.

```graphql
mutation {
  bulkOperationRunQuery(query: """
    { products { edges { node { id updatedAt vendor productType tags
        options { name optionValues { name } } } } } }
  """) { bulkOperation { id status } userErrors { message } }
}
```

Poll `currentBulkOperation`, stream the JSONL, and write the distinct option
names and values into `filter_source_cache` (or a proper `catalogue_values`
table with counts). Persist the operation id so a crash resumes rather than
restarting.

**GraphQL, not REST.** Shopify is GraphQL-first for new public apps, and one
query fetching exactly the fields needed beats REST's product-then-variants
round trips.

### 2. Keeping values current: webhooks + reconciliation

Subscribe to `PRODUCTS_CREATE`, `PRODUCTS_UPDATE`, `PRODUCTS_DELETE` and
`COLLECTIONS_UPDATE`. The endpoint verifies the HMAC, enqueues, and returns 200
— Shopify expects a fast response, retries anything slow or non-200, and drops
the subscription after sustained failures. This app already handles webhooks
that way.

Three things that bite in practice:

- **Delivery is at-least-once and out of order.** Guard with the payload's
  `updated_at` and drop anything not newer than what is stored.
- **Webhooks get missed** — outages, deploys, a subscription silently lost. A
  nightly reconciliation (bulk query, compare, repair the diff) is not optional.
- **Value sets shrink as well as grow.** Removing the last product with
  `Color: Ice` should retire that value. That is a recount, not a delete of the
  merchant's override — the override is kept and flagged, exactly as it is
  today.

### 3. Rate limits

The GraphQL Admin API is a calculated-cost leaky bucket, and every response
carries `extensions.cost` with `currentlyAvailable` and `restoreRate`. Read
those and pace from them rather than hard-coding a number that differs per
plan: a token-bucket limiter per shop, seeded from the last response, with
exponential backoff and jitter on `THROTTLED`. `services/shopify.js` already
retries throttling with full jitter; what it lacks is a shared per-shop budget.
Queue work per shop so one large merchant's backfill cannot starve another
shop's webhooks.

### 4. Background jobs

The refresh, the bulk import and the nightly reconciliation all move off the
request path onto a Redis-backed queue (BullMQ) or SQS, with per-shop
concurrency limits, jobs made idempotent on `(shop, product_id, updated_at)`,
a dead-letter queue, and workers as separate processes from the web tier. The
screen then shows "refreshing…" with a job status instead of blocking.

### 5. Caching

- `filter_source_cache` is already the right idea; at scale it wants a TTL and
  a per-shop invalidation hook on index writes rather than only a manual
  refresh.
- `GET /filters/published` is read by every storefront page view. It should be
  served with an `ETag` and cached at the edge, keyed by shop and configuration
  version, and purged when the merchant saves.
- Bump a `config_version` on the store row on every write — a cheap cache key
  that changes exactly when the configuration does.

### 6. The storefront side

Filtering 150k products is a different problem from configuring the filters.
The configuration this app publishes says what the panel contains; actually
applying it needs a search index — OpenSearch, Typesense or Meilisearch — with
one document per product, the facet fields as keywords, `shop_id` on every
document, and facet counts as a single aggregation rather than one query per
facet. Facets should exclude their own selection from their own counts, or
multi-select becomes unusable: with Black ticked, the colour list still has to
answer "and how many if I also tick Red?"

Delivery is a theme app extension (an app block the merchant places) rather
than injected script tags, with requests going through an App Proxy so they are
same-origin and edge-cacheable. The first render should be server-side or
cached HTML — a collection page that paints empty and fills in via JS loses
both the CLS score and the crawler.

### What would *not* change

- Shopify owning what exists, this app owning what was decided.
- Sparse overrides keyed on the raw value.
- The published-configuration contract, with `value` and `label` separate.
- Validation in the model rather than the screen.
- Webhooks that verify, enqueue and return 200.

---

## Third-party libraries and AI tools

**Runtime dependencies** — deliberately few, and nothing on the frontend:

| Package | Why |
| --- | --- |
| `express` | HTTP server and routing. |
| `ejs` | Server-side templates. |
| `mysql2` | MySQL/MariaDB driver with promises and prepared statements. |
| `dotenv` | Environment configuration. |
| `axios` | Outbound HTTP to the Shopify Admin API. |

**Dev dependencies**: `nodemon`, `cloudflared` (local tunnel).

**No frontend libraries at all** — no React, no jQuery, no CSS framework. The
two panes, switches, drag-reorder, value editor and dialog are vanilla JS and
hand-written CSS. App Bridge is loaded from Shopify's CDN because an embedded
app requires it for session tokens and admin navigation.

**AI tools**: built in a pair-programming session with **Claude (Anthropic)** in
Claude Code — architecture, implementation, tests and this README. All of it was
reviewed and verified against the live app, a real Shopify development store
and the database; the 68 end-to-end checks and the headless-Chrome renders are
the evidence. Bugs found that way — a missing `/filters/refresh` route that
would have made the Refresh button 404, and a `[hidden]` attribute overridden by
an author `display` rule — were fixed rather than papered over.
