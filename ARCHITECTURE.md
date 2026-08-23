# Architecture

This document explains how Namecoin Explorer is built and why. It is a **manual
deep-dive** for contributors and operators who want to understand the system
beyond what the README covers.

## Overview

Namecoin Explorer is a web application that turns a Namecoin Core full node into
a browsable, searchable name registry and operations explorer. It is:

- **Registry-first**: the raison d'être of Namecoin is its name namespace, so the
  UI is centred on names, not blocks.
- **Two sources of truth**: the node (authoritative, on-chain) and a local SQLite
  mirror (fast browsing at scale).
- **Dependency-light**: Express + EJS + `better-sqlite3`. No build step, no heavy
  framework, cheap to run on the same box as a full node.

## Component map

```
app.js
└─ boot             read env, build rpc/cache/registry, start Express
└─ middleware       chain-info, registry count, sync status (res.locals)
└─ routes
   ├─ /             home (latest block, recent/expiring names, namespace rows)
   ├─ /names        registry browse + search
   ├─ /name/:name   name detail (record, value, full provenance timeline)
   └─ lib/routes.js operations feed, /namespace, /blocks, /block, /tx, /stats, JSON API
```

### `lib/rpc.js` — hardened JSON-RPC client

Wraps namecoind over HTTP JSON-RPC.

- **Cookie auth by default** — reads `NMC_COOKIE_PATH` (e.g. `/var/lib/namecoin/.cookie`)
  so no password lives in the app's env; falls back to explicit user/pass.
- **Sequential queue** — calls are serialised via a promise chain to respect node
  request limits and avoid hammering the daemon.
- **Explicit hex ⇄ name** — `nameToHex` / `hexToName`. Critical for non-ASCII
  names (Namecoin names are arbitrary bytes). A past bug came from trusting a name
  string without hex-encoding it.
- **Fail loud** — any RPC error becomes a thrown `RpcError` with a code; callers
  decide. The client never fabricates a "not found / available" result.

### `lib/cache.js` — SQLite registry cache

`name_scan` can return ~780k names, which is too slow to page on demand. On start
(and every `NMC_REFRESH_MS`), the app snapshots the registry into a SQLite table
(`data/cache.db`) and indexes it. Browsing, search, namespace counts, and
"recent/expiring" queries all hit this local mirror. The node remains
authoritative for live name state (`name_show`).

### `lib/registry.js` — background sync

Pages `name_scan` and upserts into the cache. Runs on boot (`syncNow`) and on a
timer (`start()`). Because paging 780k names takes real time, sync runs in the
background so the HTTP server stays responsive.

### `lib/names.js` — value classification + timeline

- `classifyValue` — understands that a name value is arbitrary bytes that are
  usually JSON; handles quote-wrapped JSON, DNS `map` shapes, and plain text.
- `renderValue` — turns a raw value into a UI-ready record (DNS table / key-value
  table / text).
- `operationTimeline` — builds the ascending, dated, **type-labelled** operation
  history. Because `name_history` does not return the op type or a date, the app
  passes in maps (txid → op type, height → date) produced by the route.

### `lib/txops.js` — OP_NAME extraction

Decodes a transaction's `scriptPubKey.asm` to detect `OP_NAME_NEW`,
`OP_NAME_FIRSTUPDATE`, `OP_NAME_UPDATE`, `OP_NAME_RENEW`, etc., returning
`{ op, name, nameHex, value, vout }`. This powers both the operations feed and
the per-op type labelling in the name timeline.

### `lib/routes.js` — additional routes

Operations feed (recent mined name ops), `/namespace`, `/blocks`, `/block`,
`/tx`, `/stats`, `/operations/pending` (mempool name ops), and the JSON API.

## The provenance timeline (why it's special)

Namecoin's `name_history` gives you, per name, a list of `{height, txid, value, …}`
**without** the operation type or a block timestamp. To show a complete, dated,
typed append-only history the route does three things per op:

1. `getrawtransaction` → decode `OP_NAME_*` → the true op type (`REGISTER`, etc.).
2. `getblockhash(height)` + `getblockheader(hash)` → the block time → a real date.
3. Both are memoised per request, and the block-time lookup uses **header-only**
   fetches (not full blocks) so a 27-op history renders in ~1–2s, not 13s.

This is why the explorer shows the genesis of `d/bitcoin` at block 142
(21 April 2011) — the first name ever — through to today, including expired names.
The blockchain is append-only; the UI reflects that without pretending anything
was erased.

## Design & frontend

- **EJS** server-rendered templates with a shared `layout.ejs`.
- **Bulma** (vendored, `public/vendor/bulma.min.css`) as a reset/base, layered with
  a hand-tuned design system (`public/css/brutalist.css`): light/dark theme,
  Namecoin-blue palette, mobile-responsive app-bar + partial-width drawer.
- Inline SVG icon set (`views/includes/_icon.ejs`) — feather-style, `currentColor`,
  consistent across sidebar, page titles, stat cards, and panel headers.
- Values and long hashes wrap (`overflow-wrap:anywhere`) so nothing crops on mobile.

## Data flow example

```
GET /name/d%2Fbitcoin
  → name_show("d/bitcoin")            current record (live state)
  → name_history("d/bitcoin")         full op list from the name index
  → per op: getrawtransaction / getblockheader   → op type + date
  → operationTimeline(...)            → typed, dated ascending timeline
  → res.render("name", ...)           → HTML page
```

## Testing & operations

- No test runner configured yet (see `CONTRIBUTING.md`); CI runs syntax checks,
  EJS compile checks, and `npm audit`.
- The node must run with `txindex=1` and `namehistory=1` for `getrawtransaction`
  and full `name_history` to work. If `namehistory` was not built at initial sync,
  a one-time `-reindex` populates it.
- Bind the app to `127.0.0.1`; put Caddy/nginx in front for HTTPS. Never expose
  the RPC port (8336) publicly.

## Notes on operations at scale

- The in-memory `heightCache` bounds RPC lookups to unique heights per request.
- The registry snapshot makes list/search queries O(1) against a local table.
- Playwright is a dev dependency (used for headless UI verification), not a
  runtime dependency.