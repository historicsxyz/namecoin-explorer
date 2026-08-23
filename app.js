'use strict';

// Namecoin Explorer v2 - industrial-grade name browser & operations explorer
const path = require('path');
const fs = require('fs');
const express = require('express');
const layouts = require('express-ejs-layouts');
const compression = require('compression');
const helmet = require('helmet');
const morgan = require('morgan');

const { NamecoinRPC, nameToHex, hexToName } = require('./lib/rpc');
const { NameCache } = require('./lib/cache');
const { RegistryService } = require('./lib/registry');
const { parseNamespace, classifyValue, renderValue, operationTimeline, OP_LABELS } = require('./lib/names');
const { nameOpsFromTx } = require('./lib/txops');
const registerRoutes = require('./lib/routes');

// ---- config ----
const PORT = Number(process.env.NMC_EXPLORER_PORT || 3100);
const RPC_HOST = process.env.NMC_RPC_HOST || '127.0.0.1';
const RPC_PORT = Number(process.env.NMC_RPC_PORT || 8336);
const RPC_USER = process.env.NMC_RPC_USER || 'hermes';
const RPC_PASS = process.env.NMC_RPC_PASS || '';
const COOKIE_PATH = process.env.NMC_COOKIE_PATH || '/var/lib/namecoin/.cookie';
const DB_PATH = process.env.NMC_CACHE_DB || path.join(__dirname, 'data', 'cache.db');
const REFRESH_MS = Number(process.env.NMC_REFRESH_MS || 6 * 3600 * 1000);

const rpc = new NamecoinRPC({
  host: RPC_HOST, port: RPC_PORT, user: RPC_USER,
  pass: RPC_PASS, cookiePath: RPC_PASS ? null : COOKIE_PATH,
});
if (!fs.existsSync(path.dirname(DB_PATH))) fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
const cache = new NameCache(DB_PATH);
const registry = new RegistryService(rpc, cache, { refreshMs: REFRESH_MS });

// ---- Express app ----
const app = express();
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.set('layout', 'layout');
app.use(layouts);
app.use(compression());
app.use(helmet({ contentSecurityPolicy: false }));
app.set('trust proxy', 1);
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
const logStream = fs.createWriteStream(path.join(__dirname, 'explorer.log'), { flags: 'a' });
app.use(morgan('combined', { stream: logStream }));

// ---- view helpers ----
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
app.locals.OP_LABELS = OP_LABELS;
app.locals.hexToName = hexToName;

// ---- sync-status middleware ----
app.use(async (req, res, next) => {
  let info = null;
  try { info = await rpc.call('getblockchaininfo'); }
  catch (e) { info = { chain: 'main', blocks: 0, headers: 0, initialblockdownload: true, error: e.message }; }
  res.locals.chainInfo = info;
  try { res.locals.registryCount = cache.count(); }
  catch (e) { res.locals.registryCount = 0; }
  res.locals.lastSync = registry.lastResult || null;
  next();
});

// ---- helper: registry search (from cache) ----
function rpcCachedSearch(q, limit = 30) {
  return cache.search(q, limit);
}
function rpcCachedPage(opts) { return cache.page(opts); }

// =====================================================================
// HOME
// =====================================================================
app.get('/', async (req, res) => {
  res.locals.page = 'home';
  let block = null;
  try {
    const h = await rpc.call('getblockhash', [ (res.locals.chainInfo || {}).blocks || 0 ]);
    block = await rpc.call('getblockheader', [h, true]);
  } catch (e) {}
  let recent = [], expiring = [];
  let latest = 0, namespaces = [];
  try {
    recent = cache.recent(10);
    expiring = cache.expiringSoon(8);
    latest = res.locals.chainInfo ? res.locals.chainInfo.blocks : 0;
    namespaces = cache.countByNamespace();
  } catch (e) {}
  res.render('home', { block, recent, expiring, latest, namespaces });
});

// =====================================================================
// NAME BROWSER (registry)
// =====================================================================
app.get('/names', async (req, res) => {
  res.locals.page = 'names';
  const { limit = 50, start = '', ns = null, status = null, q = null } = req.query;
  let rows = [], total = 0;
  try {
    if (q) {
      rows = rpcCachedSearch(q, Math.min(Number(limit) || 50, 50));
      total = rows.length;
    } else {
      rows = cache.page({ start, limit: Math.min(Number(limit) || 50, 50), ns, status });
      total = rows.length;
    }
  } catch (e) { rows = []; }
  const namespaces = cache.countByNamespace();
  res.render('names', { rows, total, ns, status, q, limit: Number(limit) || 50, namespaces });
});

// JSON autocomplete / search
app.get('/api/search', async (req, res) => {
  const q = (req.query.q || '').slice(0, 50);
  if (!q) return res.json({ items: [] });
  try {
    const rows = cache.search(q, 30);
    res.json({ items: rows.map((r) => ({ name: r.name })) });
  } catch (e) { res.json({ items: [] }); }
});

// =====================================================================
// NAME DETAIL
// =====================================================================
app.get('/name/:name', async (req, res) => {
  res.locals.page = 'name';
  const rawName = req.params.name;
  const cached = (() => { try { return cache.get(rawName); } catch { return null; } })();
  const isNonAscii = /[^\x00-\x7f]/.test(rawName);
  const nameHex = isNonAscii ? nameToHex(rawName) : rawName;

  let show = null, historyArr = [], pending = [];
  const showOpts = isNonAscii ? { nameEncoding: 'hex' } : {};
  const showArg = isNonAscii ? nameHex : rawName;
  try { show = await rpc.call('name_show', [showArg, showOpts]); }
  catch (e) { res.locals.nameError = e.message; }
  try { historyArr = await rpc.call('name_history', [showArg, showOpts]); }
  catch (e) {}
  try { pending = await rpc.call('name_pending', [rawName]); }
  catch (e) {}

  const decoded = show ? renderValue(show) : null;

  // Resolve the actual name-op type for each historical entry by decoding its tx
  // (name_history itself doesn't return the `op` type). Build txid -> opType map,
  // plus a height -> real UTC date map so the timeline can show human dates.
  const opTypeMap = {};
  const heightDates = {};   // height -> ISO/epoch date
  const heightCache = {};   // memoize block-time lookups within this request
  const blockTimeFor = async (height) => {
    if (!height) return null;
    if (height in heightCache) return heightCache[height];
    try {
      const h = await rpc.call('getblockhash', [height]);
      const hdr = await rpc.call('getblockheader', [h, true]);   // header-only, has .time
      const t = hdr && hdr.time ? hdr.time : null;
      heightCache[height] = t ? t * 1000 : null;
      return heightCache[height];
    } catch (e) { heightCache[height] = null; return null; }
  };

  for (const hOp of (historyArr || [])) {
    if (!hOp) continue;
    if (hOp.height) { const t = await blockTimeFor(hOp.height); if (t) heightDates[hOp.height] = t; }
    if (!hOp.txid) continue;
    try {
      const tx = await rpc.call('getrawtransaction', [hOp.txid, true]);
      const ops = nameOpsFromTx(tx);
      if (ops && ops.length) opTypeMap[hOp.txid] = ops[0].op;
    } catch (e) { /* name may predate txindex coverage or be pruned; fall back */ }
  }
  const timeline = operationTimeline(historyArr || [], opTypeMap, heightDates);

  let currentTx = null;
  try { if (show && show.txid) currentTx = await rpc.call('getrawtransaction', [show.txid, true]); }
  catch (e) {}

  // Render display name: if it's an invalid-utf8 name, show hex fallback
  let displayName = rawName;
  if (show && show.name_encoding === 'hex') displayName = 'hex:' + (show.name || '');

  res.render('name', {
    name: rawName, displayName,
    show, decoded, history: timeline, opTypeMap, pending, currentTx, cached,
  });
});

// Register the additional route set (namespace, blocks, txs, operations, stats, JSON API)
registerRoutes(app, { rpc, cache, registry });

module.exports = app;

// ---- start server (only when run directly) ----
if (require.main === module) {
  const server = app.listen(PORT, '127.0.0.1', () => {
    console.log(`Namecoin Explorer v2 listening on http://127.0.0.1:${PORT}`);
  });
  server.on('error', (e) => { console.error('Server error', e); process.exit(1); });

  // kick off registry sync in the background (non-blocking)
  registry.syncNow().catch((e) => { console.error('initial registry sync failed:', e.message); });
  registry.start(); // also schedules periodic refresh

  process.on('SIGINT', () => { server.close(); cache.close(); process.exit(0); });
  process.on('SIGTERM', () => { server.close(); cache.close(); process.exit(0); });
}