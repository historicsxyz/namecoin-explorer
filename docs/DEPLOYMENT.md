# Deployment Guide

How to run Namecoin Explorer in production behind HTTPS. This mirrors the setup
used for the live instance at [nmc.historics.xyz](https://nmc.historics.xyz).

## Reference stack

- **namecoind** (Namecoin Core 28) — full node, RPC on `127.0.0.1:8336`
- **this app** (Node.js 20, `systemd` unit) — Express on `127.0.0.1:3100`
- **Caddy** — reverse proxy + automatic HTTPS (Let's Encrypt)

## 1. Run a full node

Follow [Namecoin's getting-started guide](https://www.namecoin.org/get-started/).
Based on this project's setup, key `namecoin.conf` options:

```
server=1
rpcbind=127.0.0.1
rpcallowip=127.0.0.1
txindex=1
namehistory=1
```

- `txindex=1` lets `getrawtransaction` work (needed to decode history op types).
- `namehistory=1` enables full `name_history`.
- If you enabled these *after* the initial sync, run one `-reindex` so the name
  history index is built from the whole chain.

> ⚠️ Never expose port 8336 publicly. The RPC endpoint is loopback-only.

## 2. Run the app

```bash
git clone https://github.com/historicsxyz/namecoin-explorer.git
cd namecoin-explorer
npm install --omit=dev
cp .env.example .env      # set NMC_RPC_* / NMC_COOKIE_PATH
npm start                  # -> http://127.0.0.1:3100
```

### systemd unit

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

## 3. Reverse proxy with Caddy

`/etc/caddy/Caddyfile`:

```
nmc.example.org {
    encode gzip
    reverse_proxy 127.0.0.1:3100
    header {
        -X-Frame-Options SAMEORIGIN
        -Referrer-Policy no-referrer
        -X-Content-Type-Options nosniff
    }
}
```

`caddy reload` issues/stores the HTTPS certificate automatically.

## 4. Health checks

- `GET /api/health` — liveness and chain sync status.
- Watch `explorer.log` (morgan access log) and `journalctl -u namecoin-explorer`.

## Notes

- First start snapshots the registry into `data/cache.db` in the background;
  browsing is fast only after that completes.
- Back up `data/cache.db` if you wish; it will simply re-sync if lost.
- Point `NMC_CACHE_DB` to a fast disk for big registries.