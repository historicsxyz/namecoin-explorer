# Deployment

How to run Namecoin Explorer in production behind HTTPS. This is the stack used for [nmc.historics.xyz](https://nmc.historics.xyz).

## Reference stack

| Piece | Role |
|-------|------|
| **namecoind** (Namecoin Core 28) | Full node. RPC **only** on `127.0.0.1:8336` |
| **this app** (Node ≥ 20, `engines.node`) | Express on `127.0.0.1:3100` |
| **Caddy** | Reverse proxy + Let's Encrypt |

One ingest+HTTP process on the same machine as the node. SQLite WAL already serves concurrent HTTP readers inside that process.

## 1. Full node

Follow [Namecoin getting started](https://www.namecoin.org/get-started/). Useful `namecoin.conf`:

```
server=1
rpcbind=127.0.0.1
rpcallowip=127.0.0.1
txindex=1
namehistory=1
# optional — must match NMC_ZMQ_HASHBLOCK
zmqpubhashblock=tcp://127.0.0.1:28332
```

- `txindex=1` — `getrawtransaction` for lazy history op types.
- `namehistory=1` — full `name_history`. If you turn these on after first sync, one `-reindex` builds the indexes.

Never expose port 8336. Loopback only.

## 2. App

```bash
git clone https://github.com/historicsxyz/namecoin-explorer.git
cd namecoin-explorer
npm install --omit=dev
cp .env.example .env
# NMC_BIND=127.0.0.1  NMC_COOKIE_PATH=…  NMC_CACHE_DB=…
# NMC_PUBLIC_URL=https://nmc.example.org   # canonical / Open Graph / sitemap
npm start
# http://127.0.0.1:3100
```

Keep `NMC_BIND=127.0.0.1`. Do not bind `0.0.0.0` unless you know why.

### systemd

`/etc/systemd/system/namecoin-explorer.service`:

```ini
[Unit]
Description=Namecoin Explorer
After=network.target namecoind.service

[Service]
Type=simple
WorkingDirectory=/srv/namecoin-explorer
EnvironmentFile=/srv/namecoin-explorer/.env
ExecStart=/usr/bin/node app.js
Restart=on-failure
RestartSec=5
TimeoutStopSec=20
User=namecoin

[Install]
WantedBy=multi-user.target
```

`better-sqlite3` is a native addon. Install and rebuild it with **the same Node binary** as `ExecStart`. Mixing versions (for example `npm ci` under Node 26, then `ExecStart=/opt/node20/bin/node`) fails with a `NODE_MODULE_VERSION` mismatch (147 vs 115). `package.json` `engines.node` is `>=20 <27` (the range `better-sqlite3` 12.x compiles on). `node:sqlite` is not a fallback on Node 20 (it needs ≥ 22.5).

Memory limits (`NODE_OPTIONS=--max-old-space-size`, `MemoryMax`) are in §3. They are recommended infra config for the unit file, owned outside this repo.

```bash
PATH=/opt/node20/bin:$PATH npm ci --omit=dev
PATH=/opt/node20/bin:$PATH npm rebuild better-sqlite3
```

## 3. Reverse proxy and deployment best practices

`/etc/caddy/Caddyfile` (recommended infra config — owned outside this repo):

```
nmc.example.org {
    encode gzip
    reverse_proxy 127.0.0.1:3100 {
        lb_try_duration 5s
        transport http {
            keepalive 32s
        }
    }
    header {
        X-Frame-Options SAMEORIGIN
        Referrer-Policy no-referrer
        X-Content-Type-Options nosniff
    }
}
```

`caddy reload` issues the certificate. A leading `-` on a header name in Caddy **deletes** that header — do not copy the old minus-prefixed block.

The app already sends Cache-Control, ETag, Helmet, and per-IP rate limits. Proxy headers are belt-and-suspenders.

### Recommended infra config

The following applies to `/etc/caddy/Caddyfile` and `/etc/systemd/system/namecoin-explorer.service`, **owned outside this repo**. Do not put these files in the application tree.

**Proxy cache headers.** Let the origin decide. The app sends:

| Class | Cache-Control |
|-------|----------------|
| Versioned CSS/JS (`/css/explorer.css?v=…`) | `public, max-age=31536000, immutable` |
| Other static (png/svg/webmanifest) | `public, max-age=604800` |
| HTML (name pages, stats, listings) | `public, max-age=10, stale-while-revalidate=30` |
| JSON API (except health / mempool) | `public, max-age=15, stale-while-revalidate=45` |
| `/health`, `/api/health`, `*/pending` | `no-store` |

If you add a CDN in front of Caddy, honour `ETag` / `If-None-Match` (304) and `Vary: Accept-Language` on HTML. Do not force a long `max-age` on `/`, `/names`, `/name/*`, or `/api/*` at the proxy — a new block must still revalidate so ingest updates show up within a block.

The process also caches those HTML landings in memory (tens of seconds, dropped when a block lands). Expect roughly **384MB extra RSS** for the SQLite pager (`cache_size`) plus mmap on a multi-GB `cache.db`. That is intentional: default 16MB cache and 4MB WAL checkpoints were stalling the event loop.

Optional Caddy snippet (still infra-owned): `header /css/* Cache-Control "public, max-age=31536000, immutable"` is redundant with origin static headers.

**Proxy rate limiting.** The process already token-buckets `/api/search` (120/min), `/api/*` (90/min), and `/stats` (60/min) per client IP (`trust proxy` is on). A reverse-proxy cap is extra insurance against one IP saturating the event loop before Node:

```
# Caddy v2 — example only, adjust to your Caddy build
rate_limit {
    zone explorer {
        key {remote_host}
        events 200
        window 1m
    }
}
```

Keep HTML `/name/*` browsing off that zone (or at a much higher ceiling). Autocomplete hits `/api/search` on every keystroke.

**`encode gzip` vs WebSockets (wallet.namecoin.co).** `encode gzip` is correct for this explorer (plain HTTP). Do **not** copy that site block onto a vhost that reverse-proxies a WebSocket backend (Namecoin wallet / Electrum-style). Gzip on an Upgrade request breaks the tunnel. Use a separate Caddy site without `encode gzip` for `wallet.namecoin.co` (or equivalent).

**Swap.** On a ~8 GB VPS the Node process can peak near 2 GB RSS next to `namecoind` and a 3 GB SQLite cache. Add a 2–4 GB swap file so a traffic spike does not invoke the OOM killer:

```
fallocate -l 2G /swapfile
chmod 600 /swapfile
mkswap /swapfile
swapon /swapfile
```

Persist in `/etc/fstab`. This is host config, not the app repo.

**systemd memory.** Extend the unit in §2 (infra-owned) with a heap cap that fits the box. For 4-core / ~8 GB RAM:

```
Environment=NODE_OPTIONS=--max-old-space-size=3072
MemoryMax=4G
MemoryHigh=3G
```

`--max-old-space-size=3072` matches a process that already sits near 2 GB RSS with headroom for HTML/name caches (bounded, a few tens of MB). Do not set `MemoryMax` below the SQLite mmap + heap peak or systemd will SIGKILL the unit.

Disable the in-process rate limiter only if the proxy already enforces equivalent limits: `NMC_RATE_LIMIT=0`. Request timeout (default 60s): `NMC_REQUEST_TIMEOUT_MS=60000`.


## 4. Health

- `GET /health` and `GET /api/health` — `ok`, `blocks`, `registry`, `catchingUp`, `height`, `tip`, `lastSync`.
- `journalctl -u namecoin-explorer` and the morgan access log (`explorer.log` if you redirect it).

Browser tabs render API JSON as HTML. `curl` still gets JSON.

## Topology

Run **one** ingest process per `cache.db`.

Optional extra HTTP processes may open the same file read-only (`file:…/cache.db?mode=ro`) **only** on a shared filesystem, and must **never** start ingest. Do not run two ingest processes on one database. Do not add Postgres/Redis as the primary store unless you outgrow shared disk.

## Optional ZMQ

`NMC_ZMQ_HASHBLOCK=tcp://127.0.0.1:28332` plus `zmqpubhashblock` in `namecoin.conf`. The 10s poll stays as a watchdog. Install `zeromq` (`optionalDependencies`). Startup exits if the URL is set but the package or connect fails.

## Optional genesis rewind

Default first run: `tip − 36,000`. `NMC_INGEST_FROM=0` or `genesis` starts at height 0. Needs `txindex=1`, a long first pass, and a single writer. Health exposes `catchingUp`, `height`, and `tip`. Lazy `name_history` still fills names whose ops sit outside the indexed window if you keep the default rewind.

## Notes

- First start follows ~36,000 blocks (unless genesis rewind) and bootstraps with `name_scan` pages of 500. `/operations` fills as blocks are ingested.
- `txindex=1` and `namehistory=1` are required for lazy per-name history, not for the block-follow indexer itself.
- If `namecoind` is down, HTML lists and search keep serving from SQLite. `/name` and `/tx/:txid` show indexed name data and say so. JSON matches: `/api/name`, `/api/tx/:txid`, and `/api/block/:hash` set `"source":"index"` when they fall back. Mempool endpoints (`/operations/pending`, `/api/name/:name/pending`) still need RPC. `/health` is the process, not the node.
- Back up `data/cache.db` if you want; it will re-ingest if lost. Point `NMC_CACHE_DB` at a fast disk for a large index.
- Local development against this VPS: SSH tunnel only (`npm run dev:vps`). That is not a production path.
