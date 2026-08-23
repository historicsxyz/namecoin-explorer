# Contributing

Thanks for helping. Code, docs, translations, and design feedback are all useful.

This project follows the [Contributor Covenant](CODE_OF_CONDUCT.md).

## Setup

Express + EJS + SQLite. No bundler.

```bash
git clone https://github.com/historicsxyz/namecoin-explorer.git
cd namecoin-explorer
npm install
cp .env.example .env
npm run dev          # node --watch
# http://127.0.0.1:3100
```

`namecoind` is the source of truth. `data/cache.db` is the browse index. Do not “fix” a name page from the cache alone — check the node.

Against a remote loopback-only node (dev): `npm run dev:vps` opens an SSH tunnel to `localhost:18336` and starts the app. Do not publish RPC.

Scratch node: point `NMC_RPC_*` at testnet/regtest and `NMC_CACHE_DB` at a throwaway file.

## Layout

```
app.js                 boot, locals, explorer home, /names, /name, /health
lib/
  rpc.js               JSON-RPC (cookie, hex encodings, concurrency)
  ingest.js            block follow + paged name_scan
  cache.js             SQLite WAL + FTS5
  api-json.js          JSON vs HTML wrapper
  i18n.js              t() / pickLang
  names.js             values + timeline inferences
  txops.js             NAME_NEW / FIRSTUPDATE / UPDATE
  expiry.js            36000 / 4032
  routes.js            ops, blocks, txs, stats, /api/*
  registry.js          retired stub (throws)
locales/               en.json, de.json  (restart after edits)
views/                 EJS (layout, pages, includes/_icon.ejs)
public/css/            explorer.css
test/                  node:test (no live node)
docs/                  operator docs
scripts/dev-vps.ps1    local UI + SSH RPC tunnel
```

## Style

- Node ≥ 20, CommonJS, `'use strict'`.
- Fail loud. Do not invent RPC results.
- Small, existing patterns: `cache.*`, `rpc.call`, `sendApiJson`, `t()`.
- After changing `explorer.css`, bump `?v=` in `views/layout.ejs`.
- After changing locales, restart Node (catalogs load at require time).
- Keep PRs small. Run `node --check` on touched JS.

### UI

The live design is `public/css/explorer.css`, not Bulma and not `brutalist.css`.

- Zinc neutrals. Namecoin blue (`#3a6ea5`) as accent only.
- Flat panels. No glass, no mesh, no leftover inset “active” bars.
- Sidebar labels match the product: Explorer, Name Browser, Name Operations, Blocks, Statistics, JSON API.
- Page heading icons must match the sidebar icon for that section.
- Cards in a `.grid` row share height (`align-items: stretch`). Do not `align-self: start` a sibling to “fix” empty space.
- Long names: `table-layout: fixed` + ellipsis + `title=`.
- In page scripts, stringify with `<%- JSON.stringify(...) %>`.

## Tests

```bash
npm test
npm run check
```

CI: `node --check` on `app.js` and `lib/*.js`, compile top-level EJS, `npm test`. Add tests next to `cache`, `txops`, `expiry`, `ingest`, `api-json` when behaviour changes.

Against a running node:

```bash
curl -s http://127.0.0.1:3100/api/health
curl -s http://127.0.0.1:3100/api/name/d%2Fbitcoin
```

UI changes: exercise the route in a browser (or the editor preview), including the other pages that share the same state.

## Issues and PRs

Use the GitHub templates. Include the exact URL, expected vs actual, and whether you are on mainnet.

Security bugs: [SECURITY.md](SECURITY.md) only — no public issue.

1. Branch from `main`: `feat/…` or `fix/…`.
2. Update docs when behaviour or env vars change.
3. Open the PR against `main`. `Closes #n` when it does.

## Principles

- Namecoin-native, not Bitcoin-native.
- Show expired names. The chain does not forget.
- Batch RPC. Do not hammer the node from a page render.
- One ingest writer. Do not add a second store “for scale” without a real multi-host need.
