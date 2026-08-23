# Deployment

How to run Namecoin Explorer in production behind HTTPS. This is the stack used for [nmc.historics.xyz](https://nmc.historics.xyz).

## Reference stack

| Piece | Role |
|-------|------|
| **namecoind** (Namecoin Core 28) | Full node. RPC **only** on `127.0.0.1:8336` |
| **this app** (Node ≥ 20) | Express on `127.0.0.1:3100` |
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
User=namecoin

[Install]
WantedBy=multi-user.target
```

## 3. Caddy

`/etc/caddy/Caddyfile`:

```
nmc.example.org {
    encode gzip
    reverse_proxy 127.0.0.1:3100
    header {
        X-Frame-Options SAMEORIGIN
        Referrer-Policy no-referrer
        X-Content-Type-Options nosniff
    }
}
```

`caddy reload` issues the certificate. A leading `-` on a header name in Caddy **deletes** that header — do not copy the old minus-prefixed block.

The app already sends some of these via Helmet; the proxy headers are belt-and-suspenders.

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
- Back up `data/cache.db` if you want; it will re-ingest if lost. Point `NMC_CACHE_DB` at a fast disk for a large index.
- Local development against this VPS: SSH tunnel only (`npm run dev:vps`). That is not a production path.
