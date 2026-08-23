'use strict';

// Namecoin Explorer v2 — name browser & operations explorer
const path = require('path');
const fs = require('fs');
const express = require('express');
const layouts = require('express-ejs-layouts');
const compression = require('compression');
const helmet = require('helmet');
const morgan = require('morgan');

const { NamecoinRPC, hexToName } = require('./lib/rpc');
const { NameCache } = require('./lib/cache');
const { IngestService, ingestOptionsFromEnv } = require('./lib/ingest');
const { t, pickLang } = require('./lib/i18n');
const { sendApiJson } = require('./lib/api-json');
const {
  parseNamespace,
  classifyValue,
  renderValue,
  timelineFromOps,
  OP_LABELS,
} = require('./lib/names');
const { expiryStatus, SEMI_EXPIRE_WINDOW } = require('./lib/expiry');
const registerRoutes = require('./lib/routes');

function loadEnvFile(file) {
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const i = t.indexOf('=');
    if (i < 1) continue;
    const k = t.slice(0, i).trim();
    let v = t.slice(i + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1);
    }
    if (process.env[k] === undefined) process.env[k] = v;
  }
}
loadEnvFile(path.join(__dirname, '.env'));

const PORT = Number(process.env.NMC_EXPLORER_PORT) || 3100;
const RPC_HOST = process.env.NMC_RPC_HOST || '127.0.0.1';
const RPC_PORT = Number(process.env.NMC_RPC_PORT) || 8336;
const RPC_USER = process.env.NMC_RPC_USER || 'hermes';
const RPC_PASS = process.env.NMC_RPC_PASS || '';
const COOKIE_PATH = process.env.NMC_COOKIE_PATH || '/var/lib/namecoin/.cookie';
const DB_PATH = process.env.NMC_CACHE_DB || path.join(__dirname, 'data', 'cache.db');

const rpc = new NamecoinRPC({
  host: RPC_HOST, port: RPC_PORT, user: RPC_USER,
  pass: RPC_PASS, cookiePath: RPC_PASS ? null : COOKIE_PATH,
});
if (!fs.existsSync(path.dirname(DB_PATH))) fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
const cache = new NameCache(DB_PATH);
const ingest = new IngestService(rpc, cache, ingestOptionsFromEnv());

const app = express();
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.set('layout', 'layout');
if (process.env.NODE_ENV !== 'production') app.set('view cache', false);
app.use(layouts);
app.use(compression());
app.use(helmet({ contentSecurityPolicy: false }));
app.set('trust proxy', 1);
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
const logStream = fs.createWriteStream(path.join(__dirname, 'explorer.log'), { flags: 'a' });
app.use(morgan('combined', { stream: logStream }));

const nsInfo = (n) => parseNamespace(typeof n === 'string' ? n : '');
app.locals.nsInfo = nsInfo;
app.locals.renderValue = renderValue;
app.locals.classifyValue = classifyValue;
app.locals.nfmt = (x) => (typeof x === 'number' ? x.toLocaleString() : x);
app.locals.timeAgo = (ts) => {
  if (!ts) return '';
  const s = Date.now() / 1000 - ts;
  if (s < 60) return Math.floor(s) + 's ago';
  if (s < 3600) return Math.floor(s / 60) + 'm ago';
  if (s < 86400) return Math.floor(s / 3600) + 'h ago';
  return Math.floor(s / 86400) + 'd ago';
};
app.locals.fmtDuration = (sec) => {
  if (sec == null || !Number.isFinite(Number(sec))) return '—';
  const s = Math.abs(Math.floor(Number(sec)));
  if (s < 60) return s + 's';
  if (s < 3600) return Math.floor(s / 60) + 'm';
  if (s < 86400) return Math.floor(s / 3600) + 'h';
  return Math.floor(s / 86400) + 'd';
};
app.locals.OP_LABELS = OP_LABELS;
app.locals.hexToName = hexToName;
app.locals.SEMI_EXPIRE_WINDOW = SEMI_EXPIRE_WINDOW;
app.locals.expiryStatus = expiryStatus;
app.locals.expiryKind = (r) => {
  if (!r) return 'unknown';
  if (r.expired || (r.expires_in != null && r.expires_in <= 0)) return 'expired';
  if (r.expires_in != null && r.expires_in <= SEMI_EXPIRE_WINDOW) return 'expiring';
  return 'live';
};

app.use((req, res, next) => {
  const lang = pickLang(req.query.lang, req.get('accept-language'));
  res.locals.lang = lang;
  res.locals.t = (key, vars) => t(lang, key, vars);
  next();
});

app.use((req, res, next) => {
  const tip = cache.getTip();
  const height = tip ? tip.height : 0;
  res.locals.chainInfo = {
    chain: cache.metaGet('chain') || 'main',
    blocks: height,
    headers: Number(cache.metaGet('headers') || height),
    initialblockdownload: cache.metaGet('ibd') === '1' || ingest.isCatchingUp(),
  };
  try { res.locals.registryCount = cache.count(); }
  catch (e) { res.locals.registryCount = 0; }
  res.locals.lastSync = ingest.lastResult || null;
  next();
});

app.get('/', async (req, res) => {
  res.locals.page = 'home';
  const tip = cache.getTip();
  let block = null;
  if (tip) {
    const hdr = cache.headerAt(tip.height);
    const prevHdr = tip.height > 0 ? cache.headerAt(tip.height - 1) : null;
    if (hdr) {
      let nameOpCount = 0;
      try { nameOpCount = cache.opsAtHeight(hdr.height).length; } catch { /* empty index */ }
      block = {
        hash: hdr.hash,
        height: hdr.height,
        time: hdr.time,
        nTx: hdr.ntx != null ? hdr.ntx : null,
        prev: hdr.prev || (prevHdr && prevHdr.hash) || '',
        prevHeight: prevHdr ? prevHdr.height : (hdr.height > 0 ? hdr.height - 1 : null),
        intervalSec: prevHdr && prevHdr.time != null && hdr.time != null
          ? hdr.time - prevHdr.time
          : null,
        nameOpCount,
      };
    }
  }
  let recent = [], expiring = [];
  let latest = tip ? tip.height : 0;
  let namespaces = [];
  try {
    recent = cache.recent(10);
    expiring = cache.expiringSoon(8);
    namespaces = cache.countByNamespace();
  } catch (e) { /* empty index */ }
  res.render('home', { block, recent, expiring, latest, namespaces });
});

app.get('/names', async (req, res) => {
  res.locals.page = 'names';
  const { limit = 50, start = '', ns = null, status = null, q = null } = req.query;
  let rows = [], total = 0;
  try {
    if (q) {
      rows = cache.search(q, Math.min(Number(limit) || 50, 50));
      total = rows.length;
    } else {
      rows = cache.page({ start, limit: Math.min(Number(limit) || 50, 50), ns, status });
      total = rows.length;
    }
  } catch (e) { rows = []; }
  const namespaces = cache.countByNamespace();
  res.render('names', { rows, total, ns, status, q, limit: Number(limit) || 50, namespaces });
});

app.get('/api/search', async (req, res) => {
  const q = (req.query.q || '').slice(0, 50);
  if (!q) return sendApiJson(req, res, { items: [] });
  try {
    const rows = cache.search(q, 30);
    sendApiJson(req, res, { items: rows.map((r) => ({ name: r.name })) });
  } catch (e) { sendApiJson(req, res, { items: [] }); }
});

app.get('/name/:name', async (req, res) => {
  res.locals.page = 'name';
  const rawName = req.params.name;
  const cached = (() => { try { return cache.get(rawName); } catch { return null; } })();

  let show = null, pending = [];
  try { show = await rpc.nameShow(rawName); }
  catch (e) { res.locals.nameError = e.message; }

  let ops = cache.opsForName(rawName);
  if (!ops.length) {
    try { ops = await ingest.backfillName(rawName); }
    catch (e) { /* history optional */ }
  }
  const timeline = timelineFromOps(ops || []);

  try { pending = await rpc.namePending(rawName); }
  catch (e) { /* mempool optional */ }

  const decoded = show ? renderValue(show) : null;

  res.render('name', {
    name: rawName, displayName: rawName,
    show, decoded, history: timeline, pending, cached,
  });
});

registerRoutes(app, { rpc, cache, ingest });

function sendHealth(req, res) {
  const tip = cache.getTip();
  const ibd = cache.metaGet('ibd') === '1';
  const last = ingest.lastResult || {};
  sendApiJson(req, res, {
    ok: true,
    blocks: tip ? tip.height : 0,
    registry: cache.count(),
    lastSync: last,
    catchingUp: ingest.isCatchingUp() || ibd,
    height: last.height != null ? last.height : (tip ? tip.height : 0),
    tip: last.tip != null ? last.tip : (tip ? tip.height : 0),
  });
}
app.get('/health', sendHealth);
app.get('/api/health', sendHealth);

module.exports = app;

if (require.main === module) {
  const bind = process.env.NMC_BIND || '127.0.0.1';
  const server = app.listen(PORT, bind, () => {
    console.log(`Namecoin Explorer v2 listening on http://${bind}:${PORT}`);
  });
  server.on('error', (e) => { console.error('Server error', e); process.exit(1); });

  try {
    ingest.start();
  } catch (e) {
    console.error('[ingest] failed to start:', e.message);
    process.exit(1);
  }

  const shutdown = () => { ingest.stop(); server.close(); cache.close(); process.exit(0); };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}
