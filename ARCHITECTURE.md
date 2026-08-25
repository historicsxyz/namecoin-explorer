# Architecture

How Namecoin Explorer is put together, and why. For operators and contributors; the README stays shorter.

## Overview

The app turns a Namecoin Core full node into a browsable registry and operations explorer.

- **Registry-first.** Names are the product. Blocks and txs are support views.
- **Two sources.** The node is authoritative on-chain. SQLite is the browse index and the HTML fallback when RPC is down.
- **Dependency-light.** Express + EJS + SQLite. No bundler. Cheap to run next to `namecoind`.

UI: server-rendered EJS, `public/css/explorer.css` (zinc neutrals, Namecoin blue accent only, light/dark). No CSS framework. English and German catalogs in `locales/`.

## Boot and request path

```
app.js
├─ env, open SQLite, start ingest, listen on NMC_BIND:NMC_EXPLORER_PORT
├─ middleware     ?lang= / Accept-Language, SEO (title/canonical/OG), tip + name count
└─ routes
   ├─ /                  explorer home (headers, namespaces, recent / expiring)
   ├─ /names             registry + FTS5 search
   ├─ /name/:name        name_show (or SQLite names row); timeline from name_ops
   ├─ /namespaces /namespace/:ns
   ├─ /robots.txt /sitemap.xml   crawl hints (landings only; not every name)
   └─ lib/routes.js      operations, addresses, blocks, txs, stats, JSON API
```

`lib/routes.js` owns `/operations`, `/operations/pending`, `/blocks`, `/block/:hash`, `/tx`, `/tx/:txid`, `/addresses`, `/address/:addr`, `/stats`, and `/api/*`.

Catalogs in `lib/i18n.js` load at `require` time. Restart the process after editing `locales/*.json`.

## RPC vs index

| Surface | Source when the node answers | When RPC fails |
|---------|------------------------------|----------------|
| `/names`, `/namespaces`, `/addresses`, `/operations` | SQLite | SQLite (same) |
| `/` dashboard body | SQLite | SQLite |
| `/name/:name` | `name_show` + `name_ops` timeline | Indexed name row + `name_ops`; labeled as cache |
| `/tx/:txid` | `getrawtransaction` + extracted name ops | Indexed `name_ops` for that txid; labeled as cache |
| `/tx` | `getblock` per recent header | Fill failed heights from indexed name-op txids; if every call fails, a flat recent-txid list |
| `/block/:hash` | `getblock` (height or hash) | Error (no HTML fallback) |
| `/operations/pending` | `name_pending` + `getmempoolinfo` | Error banner; do not claim an empty mempool |
| `/api/name/*` | Live RPC | JSON error (no index substitute) |

Do not invent “available / not found”. Cache HTML is a degraded view of data already ingested, not a second consensus.

`NAME_NEW` is a real consensus op. `/` and `/blocks` count it. `/operations` hides it unless `?op=NAME_NEW`. Block filters `with` / `busy` / `none` still ignore commitment-only blocks so “has name ops” means revealed names.

## Modules

### `lib/rpc.js`

HTTP JSON-RPC to namecoind.

- Cookie auth (`NMC_COOKIE_PATH`); user/pass fallback. Re-reads the cookie on HTTP 401.
- Small in-flight limiter so ingest and HTTP can overlap.
- Name RPCs always send `{ nameEncoding: "hex", valueEncoding: "hex" }` (Core #246). `name_show` sets `allowExpired: true`. Decode at the RPC boundary. `ismine` is stripped and never stored.
- Errors are `RpcError`. The client never fabricates “not found / available”.

### `lib/cache.js`

SQLite WAL. One writer (ingest), HTTP only reads.

Tables: `names` (current registry, no `ismine`), `name_ops`, `headers`, `meta`. Never load the full registry into a JS array.

If `better-sqlite3` has no native build (e.g. some Windows/Node combos), fall back to `node:sqlite`.

Search: FTS5 virtual table `names_fts` (`unicode61`) via triggers on `names`. Autocomplete prefers prefix `MATCH` (`term*`), then `LIKE`. Cap 30. No Redis/Elasticsearch.

`opsAtHeight(height)` and `opCountsByHeight` hide `NAME_NEW` by default. Pass `{ hideCommitments: false }` for explorer block totals.

`opsForTxids` is the lookup behind `/tx` name-op counts and `/tx/:txid` cache fallback.

### `lib/ingest.js`

Replaces the old 50k-row `name_scan` dump.

1. **Follow** — from `meta.tip_height+1` to tip: `getblock(hash, 2)`, extract name ops, commit per block. Reorg: walk to a common ancestor, delete headers/ops above it, rebuild affected names.
2. **First run** — rewind ~36,000 blocks (one expiry window). `NMC_INGEST_FROM=0` or `genesis` starts at height 0 (`txindex=1`; slow; one writer).
3. **Bootstrap** — paged `name_scan` at 500 names/page with a short pause so `cs_main` is not held. Then drop names whose `last_sync` predates that pass.
4. **Lazy history** — `/name/:name` with no `name_ops` rows calls `name_history` once and stores the txs. Needs `txindex=1` and `namehistory=1`. Skipped when RPC already failed.

Polls `getblockchaininfo` every ~10s. Optional `NMC_ZMQ_HASHBLOCK` ticks on `hashblock`. Catch-up of thousands of blocks still uses the height loop. Missing `zeromq` or a bad URL fails startup. HTTP pages do not scan blocks.

### `lib/names.js` / `lib/txops.js` / `lib/expiry.js`

- Values: JSON, DNS `map`, quote-wrapped, plain text (`classifyValue` / `renderValue`).
- Timeline: consensus ops are only `NAME_NEW`, `NAME_FIRSTUPDATE`, `NAME_UPDATE`. The UI may label **TRANSFER** / **RENEW** when the address changes or the value stays the same.
- Extraction prefers `scriptPubKey.nameOp`, then ASM. Ignores non-consensus opcodes such as `NAME_RENEW`. `NAME_NEW` stores the commitment rand hex as `value`.
- `showFromCache` maps a `names` row (+ last op txid) to a `name_show`-shaped object for the HTML fallback.
- Expiry: 36,000 blocks after the last update. Semi-expire (stops resolving): `expires_in <= 4032`. Prefixes (`d/`, `id/`) are application namespaces, not consensus.

### `lib/search.js`

Header search and `GET /api/search`. Classifies the query as height, 64-hex (tx and/or block), address, or name, then returns jump links plus FTS name hits.

### `lib/seo.js`

Per-page `<title>`, description, canonical, Open Graph / Twitter, hreflang, and JSON-LD (`Organization` + `WebSite` + `WebPage`). Canonical origin is `NMC_PUBLIC_URL` or `X-Forwarded-Proto` + Host. Search, pagination, `/og`, `/api/`, `/health`, and 404 are `noindex`. `/robots.txt` allows `/` and disallows `/api/` and `/health`. `/sitemap.xml` lists landing pages only (with hreflang) — not the ~780k name URLs. Favicon is the official Namecoin coin mark (CC BY 4.0).

### `lib/statsdata.js` / `lib/markets.js` / `lib/chainmetrics.js` / `lib/svgchart.js`

Stats page and header tickers. Price from CoinPaprika with CoinGecko fallback (`NMC_MARKET=0` disables). Hashrate from header difficulty. Inline SVG charts, no front-end chart library.

### `lib/api-json.js`

`sendApiJson` returns `application/json` for `curl` / `fetch`. Browser `Accept: text/html` renders `views/api-json.ejs` so Chromium is not white-on-white. `?format=json` or `?raw=1` forces raw JSON.

### `lib/i18n.js`

`t(key, vars)` on `res.locals`. `?lang=` then `Accept-Language`, default `en`. Catalogs: `locales/en.json`, `locales/de.json`. Name values and txids are not translated.

### `lib/routes.js`

See the boot tree and the RPC vs index table. `/operations/pending` is `name_pending` only.

## Provenance

`name_history` has no `op` and no timestamp. After ingest (or one lazy backfill), the name page reads `name_ops`. It does not loop `getrawtransaction` on every load.

## Frontend

- Shared `views/layout.ejs`: sidebar groups **Names** (Name Browser, Namespaces, Name Operations) and **Explorer** (Blocks, Transactions, Addresses), plus Home / Statistics / JSON API. Header search, theme, footer. Head tags come from `lib/seo.js`.
- Icons: `views/includes/_icon.ejs` (stroke SVG, `currentColor`).
- CSS: `public/css/explorer.css`. Bump `?v=` on the stylesheet link when the file changes.
- Tables use `table-layout: fixed` and ellipsis so long names do not shove columns off-screen. Layout JS wraps tables in `.table-wrap`.
- Search script must use `<%- JSON.stringify(...) %>` — `<%= %>` HTML-escapes quotes and breaks the page.
- Empty `NAME_NEW` names render as “hidden” / “verborgen”, not as a link to `/name/`.

## Data flow

```
GET /name/d%2Fbitcoin
  → name_show("d/bitcoin")     current record (hex, allowExpired)
     or SQLite names row       when RPC fails
  → SQLite name_ops            typed timeline (lazy name_history if empty and RPC is up)
  → name_pending(name)         mempool ops for this name
  → res.render("name", ...)
```

```
GET /
  → cache headers + opsAtHeight (incl. NAME_NEW) + namespaces + recent + expiringSoon
  → no per-request RPC for the dashboard body
```

```
GET /tx/:txid
  → getrawtransaction(txid, true)     inputs / outputs / name ops
     or cache.opsForTxids([txid])     name ops only, labeled as cache
```

## Operations

- Tests: `npm test` (`node --test test/`). No live node.
- Bind `127.0.0.1`. Reverse-proxy for HTTPS. Never expose 8336.
- **Topology:** one ingest+HTTP process beside `namecoind`. Optional extra HTTP processes may open the same `cache.db` with `mode=ro` on a **shared filesystem** and must never run ingest. Do not split ingest across machines. Do not introduce Postgres unless you run several explorer hosts without shared disk.
- Playwright is a dev dependency, not required at runtime.

Parked: Go rewrite, SPA, wallet `ismine`, Redis/Postgres as the primary store.
