# Docs

Operator and contributor notes for [Namecoin Explorer](https://github.com/historicsxyz/namecoin-explorer).

The public instance is [nmc.historics.xyz](https://nmc.historics.xyz).

| Document | What it covers |
|----------|----------------|
| [README](../README.md) | Product, pages, RPC fallbacks, quick start, config, API |
| [ARCHITECTURE.md](../ARCHITECTURE.md) | Modules, ingest, index, RPC vs SQLite, UI, topology |
| [DEPLOYMENT.md](DEPLOYMENT.md) | namecoind, systemd, Caddy, ZMQ, rewind |
| [CONTRIBUTING.md](../CONTRIBUTING.md) | Setup, layout, tests, design rules |
| [SECURITY.md](../SECURITY.md) | Private disclosure |
| [CODE_OF_CONDUCT.md](../CODE_OF_CONDUCT.md) | Community norms |
| [`.env.example`](../.env.example) | Environment variables |

UI chrome lives in `public/css/explorer.css` (zinc neutrals, Namecoin blue `#3a6ea5` as accent only) and `views/`. Strings are in `locales/en.json` and `locales/de.json` — restart Node after editing catalogs. Header search and `/api/search` live in `lib/search.js`.
