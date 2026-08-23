<div align="center">

# Namecoin Explorer

[![CI](https://github.com/historicsxyz/namecoin-explorer/actions/workflows/ci.yml/badge.svg)](https://github.com/historicsxyz/namecoin-explorer/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-3a6ea5?labelColor=18181b)](LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D20-3a6ea5?labelColor=18181b)](https://nodejs.org)
[![Namecoin](https://img.shields.io/badge/namecoind-Core%2028-3a6ea5?labelColor=18181b)](https://www.namecoin.org)

Self-hosted **name browser** and **operations explorer** for [Namecoin](https://namecoin.org).  
Backed by your own full node. Index in SQLite. No build step.

**Live:** [nmc.historics.xyz](https://nmc.historics.xyz)

</div>

---

## What it is

A registry-first explorer: names are the product, blocks and txs sit underneath.

- Browse the on-chain registry with namespace and expiry filters
- Open any name for the current record plus a typed, dated operation timeline
- Follow confirmed `OP_NAME_*` ops and the mempool
- Query the same data over JSON (or a browser HTML wrapper)

The node stays authoritative. SQLite is the browse index.

## Pages

| Path | UI |
|------|----|
| `/` | Explorer — tip, namespaces, recent / expiring names |
| `/names` | Name Browser — search, namespace, live / expiring / expired |
| `/name/:name` | Current record + provenance timeline |
| `/namespace/:ns` | One prefix (`d`, `id`, …) |
| `/operations` | Confirmed name ops (`?op=`, `?commitments=1`) |
| `/operations/pending` | Mempool name ops |
| `/blocks`, `/block/:hash` | Headers and a single block |
| `/tx/:txid` | Transaction + name ops |
| `/stats` | Registry totals |
| `/api/*` | JSON API (HTML when opened in a browser) |

Language: `?lang=en` / `?lang=de`, or `Accept-Language`. Theme toggle is stored locally.

## Quick start

You need **Node.js ≥ 20** and a synced **Namecoin Core** node (`txindex=1`, `namehistory=1`, RPC on loopback).

```bash
git clone https://github.com/historicsxyz/namecoin-explorer.git
cd namecoin-explorer
npm install
cp .env.example .env
npm start
```

Open **http://127.0.0.1:3100** (use `127.0.0.1`, not `localhost` — the app binds IPv4).

Auth is the RPC cookie (`NMC_COOKIE_PATH`) by default. Set `NMC_RPC_USER` / `NMC_RPC_PASS` if you prefer user/pass.

First run follows about one expiry window (`tip − 36,000`) and bootstraps names with paged `name_scan` (500/page). List and search then hit SQLite. There is no full-registry dump.

Local UI against a remote loopback-only node: `npm run dev:vps` (SSH tunnel). Never open port 8336 to the internet.

## Configuration

See [`.env.example`](.env.example).

| Variable | Default | Description |
|----------|---------|-------------|
| `NMC_EXPLORER_PORT` | `3100` | HTTP port |
| `NMC_BIND` | `127.0.0.1` | Listen address. Keep loopback; put Caddy/nginx in front |
| `NMC_RPC_HOST` | `127.0.0.1` | namecoind JSON-RPC host |
| `NMC_RPC_PORT` | `8336` | namecoind JSON-RPC port |
| `NMC_RPC_USER` | `hermes` | Used only if there is no cookie |
| `NMC_RPC_PASS` | *(cookie)* | Empty → cookie file |
| `NMC_COOKIE_PATH` | `/var/lib/namecoin/.cookie` | Core RPC cookie |
| `NMC_CACHE_DB` | `./data/cache.db` | SQLite index (one writer) |
| `NMC_ZMQ_HASHBLOCK` | *(unset)* | Optional `tcp://` / `ipc://` `hashblock`. 10s poll stays as watchdog. `npm install zeromq` |
| `NMC_INGEST_FROM` | *(unset)* | `0` or `genesis` = first run from height 0. Default is tip−36,000 |

## JSON API

Names contain `/` — encode them (`d%2Fbitcoin`).

Scripts and `curl` get `application/json`. A browser tab gets an HTML wrapper so the payload is readable. Force raw JSON with `?format=json` or `Accept: application/json`.

| Endpoint | Description |
|----------|-------------|
| `GET /api/stats` | Totals, namespaces, chain tip |
| `GET /api/search?q=` | Name autocomplete (max 30) |
| `GET /api/names?limit=&start=&ns=` | Paginated registry |
| `GET /api/name/:name` | Current `name_show` record |
| `GET /api/name/:name/history` | `name_history` |
| `GET /api/name/:name/pending` | Mempool ops for that name |
| `GET /api/health` | Liveness, tip, catch-up (`/health` is the same) |

```bash
curl -s http://127.0.0.1:3100/api/health
curl -s http://127.0.0.1:3100/api/name/d%2Fbitcoin
curl -s "http://127.0.0.1:3100/api/search?q=bit"
```

## How it is built

```
Browser ──HTTP──► Explorer (Express, 127.0.0.1:3100)
                    ├─ lib/rpc.js       JSON-RPC (cookie, hex encodings)
                    ├─ lib/ingest.js    block follow + paged name_scan
                    ├─ lib/cache.js     SQLite WAL (names, name_ops, headers, FTS5)
                    ├─ lib/txops.js     NAME_NEW / FIRSTUPDATE / UPDATE
                    ├─ lib/names.js     values + TRANSFER / RENEW inference
                    ├─ lib/expiry.js    36,000 expire / 4,032 semi-expire
                    ├─ lib/i18n.js      en / de catalogs
                    └─ lib/api-json.js  JSON vs HTML wrapper
                         │
                         ▼
                   namecoind  127.0.0.1:8336
                   txindex=1  namehistory=1
```

- **Fail loud.** RPC errors are thrown. The client never invents “available / not found”.
- **One writer.** Ingest is the only process that writes `cache.db`. HTTP only reads.
- **Node for the object, index for the list.** `name_show` is live; `/names` and search are SQLite.

Deep dive: [ARCHITECTURE.md](ARCHITECTURE.md).

## Deployment

Run next to `namecoind`, bind loopback, reverse-proxy with Caddy (or nginx). Do not expose RPC.

Guide: [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md) · docs index: [docs/README.md](docs/README.md)

## Out of scope

No Go rewrite, no SPA, no wallet `ismine`, no Redis/Postgres as the primary store. Stay on Node + SQLite unless you actually run several hosts without shared disk.

## Contributing

Read [CONTRIBUTING.md](CONTRIBUTING.md) and the [Code of Conduct](CODE_OF_CONDUCT.md). Tests: `npm test` (no live node). Security reports: [SECURITY.md](SECURITY.md) — not a public issue.

## License

[MIT](LICENSE) © 2026 [historicsxyz](https://github.com/historicsxyz) · [historics.xyz](https://historics.xyz) · [0xschatz](https://github.com/0xschatz)
