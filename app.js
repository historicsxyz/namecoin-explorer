'use strict';

// Namecoin Explorer v2 — name browser & operations explorer
const path = require('path');
const fs = require('fs');
const express = require('express');
const layouts = require('express-ejs-layouts');
const compression = require('compression');
const helmet = require('helmet');
const morgan = require('morgan');

const { NamecoinRPC } = require('./lib/rpc');
const { NameCache } = require('./lib/cache');
const { IngestService, ingestOptionsFromEnv } = require('./lib/ingest');
const { t, pickLang } = require('./lib/i18n');
const { sendApiJson } = require('./lib/api-json');
const { attachSeo, registerSeoRoutes } = require('./lib/seo');
const {
  renderValue,
  timelineFromOps,
  loadNameRecord,
} = require('./lib/names');
const { SEMI_EXPIRE_WINDOW, NAME_EXPIRY_DEPTH, shiftByBlocks } = require('./lib/expiry');
const { headerTickers } = require('./lib/statsdata');
const { lookupItems } = require('./lib/search');
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

const APP_VERSION = require('./package.json').version;
app.locals.appVersion = APP_VERSION;
app.locals.renderValue = renderValue;
app.locals.nfmt = (x) => (typeof x === 'number' ? x.toLocaleString() : x);
app.locals.fmtDuration = (sec) => {
  if (sec == null || !Number.isFinite(Number(sec))) return '—';
  const s = Math.abs(Math.floor(Number(sec)));
  if (s < 60) return s + 's';
  if (s < 3600) return Math.floor(s / 60) + 'm';
  if (s < 86400) return Math.floor(s / 3600) + 'h';
  return Math.floor(s / 86400) + 'd';
};
app.locals.shortId = (s, head = 10, tail = 8) => {
  const str = s == null ? '' : String(s);
  if (str.length <= head + tail + 1) return str;
  return str.slice(0, head) + '…' + str.slice(-tail);
};
app.locals.fmtUtc = (ts, lang) => {
  if (ts == null || !Number.isFinite(Number(ts))) return '';
  const d = new Date(Number(ts) * 1000);
  if (Number.isNaN(d.getTime())) return '';
  const locale = lang === 'de' ? 'de-DE' : 'en-GB';
  return d.toLocaleString(locale, {
    year: 'numeric', month: 'short', day: 'numeric',
    hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'UTC',
  }) + ' UTC';
};
app.locals.relDur = (ts) => {
  if (ts == null || !Number.isFinite(Number(ts))) return null;
  const delta = Date.now() / 1000 - Number(ts);
  const future = delta < 0;
  const abs = Math.abs(delta);
  let label;
  if (abs < 60) label = Math.floor(abs) + 's';
  else if (abs < 3600) label = Math.floor(abs / 60) + 'm';
  else if (abs < 86400) label = Math.floor(abs / 3600) + 'h';
  else if (abs < 86400 * 365) label = Math.floor(abs / 86400) + 'd';
  else label = (abs / (86400 * 365)).toFixed(1).replace(/\.0$/, '') + 'y';
  return { future, t: label };
};
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
app.use(attachSeo);
registerSeoRoutes(app);

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
  try { res.locals.tickers = headerTickers(cache); }
  catch (e) { res.locals.tickers = {}; }
  next();
});

function homeBlockSummary(cache, hdr) {
  if (!hdr) return null;
  const prevHdr = hdr.height > 0 ? cache.headerAt(hdr.height - 1) : null;
  let nameOpCount = 0;
  try { nameOpCount = cache.opsAtHeight(hdr.height, { hideCommitments: false }).length; } catch { /* empty index */ }
  return {
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

app.get('/', async (req, res) => {
  res.locals.page = 'home';
  const tip = cache.getTip();
  const blocks = tip
    ? cache.latestHeaders(4).map((hdr) => homeBlockSummary(cache, hdr)).filter(Boolean)
    : [];
  const block = blocks[0] || null;
  let recent = [], expiring = [];
  let latest = tip ? tip.height : 0;
  let namespaces = [];
  try {
    recent = cache.recent(10);
    expiring = cache.expiringSoon(8);
    namespaces = cache.countByNamespace();
  } catch (e) { /* empty index */ }
  res.render('home', { block, blocks, recent, expiring, latest, namespaces });
});

app.get('/og', (req, res) => {
  res.locals.page = 'og';
  res.render('og');
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
  const q = (req.query.q || '').slice(0, 80);
  if (!q) return sendApiJson(req, res, { items: [] });
  try {
    const items = await lookupItems(q, { cache, rpc, limit: 12 });
    sendApiJson(req, res, { items });
  } catch (e) { sendApiJson(req, res, { items: [] }); }
});

app.get('/name/:name', async (req, res) => {
  res.locals.page = 'name';
  const rawName = req.params.name;
  const cached = (() => { try { return cache.get(rawName); } catch { return null; } })();

  const loaded = await loadNameRecord(rpc, cache, rawName);
  const show = loaded.show;
  const fromCache = loaded.fromCache;
  if (!show && loaded.error) res.locals.nameError = loaded.error;

  let ops = [];
  try { ops = cache.opsForName(rawName); } catch { ops = []; }
  if (!fromCache && !cache.isHistorySynced(rawName)) {
    try {
      const filled = await ingest.backfillName(rawName);
      if (filled) ops = filled;
    } catch (e) { /* history optional */ }
  }
  const timeline = timelineFromOps(ops || []);

  let pending = [];
  try { pending = await rpc.namePending(rawName); }
  catch (e) { /* mempool optional */ }

  const decoded = show ? renderValue(show) : null;

  let record = null;
  if (show) {
    let updateTs = null;
    let updateApprox = false;
    const histHit = (timeline || []).find((h) => h.txid && h.txid === show.txid && h.timeMs)
      || (timeline || []).filter((h) => h.height === show.height && h.timeMs).pop();
    if (histHit) updateTs = histHit.timeMs / 1000;
    if (updateTs == null && show.height != null) {
      try {
        const hdr = cache.headerAt(show.height);
        if (hdr && hdr.time) updateTs = hdr.time;
      } catch { /* empty index */ }
    }
    if (updateTs == null && show.height != null) {
      try {
        const hash = await rpc.call('getblockhash', [Number(show.height)]);
        const header = await rpc.call('getblockheader', [hash, true]);
        if (header && header.time) updateTs = header.time;
      } catch { /* node down */ }
    }

    let expiresTs = null;
    let expiresApprox = true;
    const expiryHeight = show.height != null ? Number(show.height) + NAME_EXPIRY_DEPTH : null;
    if (expiryHeight != null) {
      try {
        const expHdr = cache.headerAt(expiryHeight);
        if (expHdr && expHdr.time) {
          expiresTs = expHdr.time;
          expiresApprox = false;
        }
      } catch { /* not indexed */ }
    }
    if (expiresTs == null) {
      try {
        const tip = cache.getTip();
        const tipHdr = tip ? cache.headerAt(tip.height) : null;
        if (tipHdr && tipHdr.time != null && show.expires_in != null) {
          expiresTs = shiftByBlocks(tipHdr.time, show.expires_in);
        }
      } catch { /* empty index */ }
    }
    if (expiresTs == null && updateTs != null) {
      expiresTs = shiftByBlocks(updateTs, NAME_EXPIRY_DEPTH);
    }
    if (expiresTs == null && show.expires_in != null) {
      expiresTs = shiftByBlocks(Date.now() / 1000, show.expires_in);
    }

    let firstTs = null;
    let firstApprox = false;
    const firstOp = (timeline || []).find((h) => h.opType === 'NAME_FIRSTUPDATE' || h.opLabel === 'REGISTER')
      || (timeline || []).find((h) => h.opType && h.opType !== 'NAME_NEW')
      || (timeline || [])[0]
      || null;
    const firstHeight = (firstOp && firstOp.height != null)
      ? firstOp.height
      : (cached && cached.first_seen != null ? cached.first_seen : null);
    if (firstOp && firstOp.timeMs) firstTs = firstOp.timeMs / 1000;
    if (firstTs == null && firstHeight != null) {
      try {
        const firstHdr = cache.headerAt(firstHeight);
        if (firstHdr && firstHdr.time) firstTs = firstHdr.time;
      } catch { /* empty index */ }
    }
    if (firstTs == null && firstHeight != null) {
      try {
        const hash = await rpc.call('getblockhash', [Number(firstHeight)]);
        const header = await rpc.call('getblockheader', [hash, true]);
        if (header && header.time) firstTs = header.time;
      } catch { /* node down */ }
    }

    record = { updateTs, updateApprox, expiresTs, expiresApprox, expiryHeight, firstTs, firstApprox, firstHeight };
  }

  res.render('name', {
    name: rawName, displayName: rawName,
    show, decoded, history: timeline, pending, cached, record, fromCache,
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

app.use((req, res) => {
  res.locals.page = 'error';
  res.status(404).render('not-found');
});

module.exports = app;

if (require.main === module) {
  const bind = process.env.NMC_BIND || '127.0.0.1';
  const server = app.listen(PORT, bind, () => {
    console.log(`Namecoin Explorer v2 listening on http://${bind}:${PORT}`);
  });
  server.keepAliveTimeout = 65000;
  server.headersTimeout = 66000;
  server.on('error', (e) => { console.error('Server error', e); process.exit(1); });

  try {
    ingest.start();
  } catch (e) {
    console.error('[ingest] failed to start:', e.message);
    process.exit(1);
  }

  let shuttingDown = false;
  const shutdown = () => {
    if (shuttingDown) return;
    shuttingDown = true;
    const t = setTimeout(() => { cache.close(); process.exit(1); }, 8000);
    t.unref();
    Promise.all([
      Promise.resolve(ingest.stop()),
      new Promise((resolve) => server.close(resolve)),
    ]).then(() => {
      clearTimeout(t);
      cache.close();
      process.exit(0);
    }).catch((e) => {
      console.error('[shutdown]', e && e.message ? e.message : e);
      clearTimeout(t);
      try { cache.close(); } catch { /* already closed */ }
      process.exit(1);
    });
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}
