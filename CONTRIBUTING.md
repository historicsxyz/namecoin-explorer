# Contributing to Namecoin Explorer

Thanks for taking the time to contribute! Namecoin is a community project and your
help — code, docs, bug reports, translations, or design feedback — is genuinely
valued.

This project follows the [Contributor Covenant Code of Conduct](CODE_OF_CONDUCT.md).
By participating, you agree to uphold it.

## Table of contents

- [Getting started](#getting-started)
- [Development setup](#development-setup)
- [Project layout](#project-layout)
- [Code style](#code-style)
- [Testing](#testing)
- [Opening an issue](#opening-an-issue)
- [Submitting a pull request](#submitting-a-pull-request)
- [Design principles](#design-principles)

## Getting started

The project is intentionally **dependency-light**: Express + EJS + `better-sqlite3`.
No build step, no bundler, no heavy framework. This keeps it easy to reason about
and cheap to run alongside a full node.

Before you start, make sure you understand the two sources of truth:

1. **The Namecoin node** (`namecoind`) is authoritative for everything on-chain.
2. **The SQLite cache** (`data/cache.db`) mirrors the registry for fast browsing.

Never "fix" a UI display by trusting the cache alone — verify against the node.

## Development setup

```bash
# 1. Clone and install
git clone https://github.com/historicsxyz/namecoin-explorer.git
cd namecoin-explorer
npm install

# 2. Point at a (dev) full node. If you don't run one, see
#    the Namecoin docs: https://www.namecoin.org/get-started/
cp .env.example .env

# 3. Run in watch mode (nodemon if you use it) or plain:
npm start
# -> http://127.0.0.1:3100
```

To use a running node without touching your main one, you can point `NMC_RPC_*`
at a testnet/regtest instance and set `NMC_CACHE_DB` to a scratch path.

## Project layout

```
app.js               Express app: boot, helpers, home, name browser, name detail
lib/
  rpc.js             JSON-RPC client for namecoind (cookie auth, hex<->name, queue)
  names.js           Value classification + operation timeline building
  txops.js           OP_NAME_* extraction from transactions
  cache.js           SQLite registry cache
  registry.js        Background registry sync + periodic refresh
  routes.js          Operations feed, namespace, blocks, txs, stats, JSON API
views/               EJS templates (layout + pages + includes)
public/              Static assets (CSS, vendor)
docs/                Documentation
```

## Code style

- **Node LTS (>= 20)**, CommonJS, `'use strict'`.
- **Fail loud.** Prefer raising errors over silently returning a guess. This is a
  core project value — see the RPC client.
- Clear, small functions with JSDoc-style comments for non-obvious logic.
- Use the existing patterns (Express routes, `cache.*` / `rpc.call` helpers).
- Run Prettier defaults if you like; keep changes focused.

## Testing

There is no test runner set up yet — which we know is a gap. When you add
behaviour, consider adding a small Node script under `test/` (plain `node:test` or
a later Vitest if we standardise). At minimum, verify by running the app against a
node and exercising the endpoint you changed:

```bash
curl http://127.0.0.1:3100/api/health
curl "http://127.0.0.1:3100/name/d%2Fbitcoin"
```

## Opening an issue

Use the templates in [`.github/ISSUE_TEMPLATE`](.github/ISSUE_TEMPLATE) when
available. Helpful issues include:

- Exact URL / query that produced the problem
- What you expected vs. what happened
- Node + explorer versions, and whether it's against mainnet/testnet

> ⚠️ **Security bugs:** do not open a public issue. Report privately via
> [SECURITY.md](SECURITY.md).

## Submitting a pull request

1. Fork the repo and create a branch: `git checkout -b feat/my-change`.
2. Make focused changes; add/update docs where relevant.
3. Run the linters/checks that exist (`node --check` on changed JS, verify pages render).
4. Open the PR against `main`. Reference the issue it fixes (e.g. `Closes #12`).
5. Keep PRs small and reviewable.

We aim to review PRs promptly and kindly.

## Design principles

- **Namecoin-native, not Bitcoin-native.** Registry-first. Blocks/txs are support.
- **Provenance by re-execution.** Show the complete append-only history — never
  pretend an expired name didn't exist.
- **Respect the network.** Batch RPC, cache aggressively, don't hammer the node.
- **Accessible & mobile-friendly.** The Namecoin community is everywhere.

---

Built for the Namecoin community. Thank you for contributing. ❤️