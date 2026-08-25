'use strict';

// Extra routes: namespace, blocks, txs, operations feed, stats, JSON API
const { nameOpsFromTx } = require('./txops');
const { sendApiJson } = require('./api-json');
const { gatherStats, parsePriceRange, statsHref } = require('./statsdata');

module.exports = function registerRoutes(app, { rpc, cache, ingest }) {
  app.get('/namespace/:ns', async (req, res) => {
    res.locals.page = 'names';
    const ns = (req.params.ns || '').replace(/\/+$/, '').toLowerCase();
    const { limit = 100, start = '', status = null } = req.query;
    const rows = cache.page({ start, limit: Math.min(Number(limit) || 100, 500), ns, status });
    const info = cache.countByNamespace().find((r) => r.namespace === ns + '/') || { total: 0, live: 0, expired: 0 };
    res.render('namespace', { ns, rows, info, start, limit: Number(limit), status });
  });

  app.get('/blocks', async (req, res) => {
    res.locals.page = 'blocks';
    const limit = parseLimit(req.query.limit || req.query.count, PAGE_SIZE, 50);
    let page = parsePage(req.query.page);
    const parsed = parseBlocksQuery(req.query.q);
    const rawOps = req.query.ops;
    const ops = canonicalizeBlocksOps(rawOps);
    const opsInvalid = !!(rawOps && String(rawOps).trim() && ops == null);
    let height = (cache.getTip() || {}).height || 0;

    if (parsed.hashPrefix && parsed.hashPrefix.length === 64 && !ops) {
      let hit = null;
      try { hit = cache.headerByHash(parsed.hashPrefix); } catch { /* empty index */ }
      if (hit) {
        parsed.maxHeight = hit.height;
        parsed.hashPrefix = null;
      } else {
        return res.redirect(302, '/block/' + parsed.hashPrefix);
      }
    }

    const filter = {
      maxHeight: parsed.maxHeight,
      hashPrefix: parsed.hashPrefix,
      ops,
    };
    const filtered = !!(filter.maxHeight != null || filter.hashPrefix || filter.ops || parsed.invalid || opsInvalid);

    let total = 0;
    let headers = [];
    if (!parsed.invalid && !opsInvalid) {
      try { total = cache.countHeaders(filter); } catch { /* empty index */ }
      if (total > 0) {
        const pages = Math.max(1, Math.ceil(total / limit));
        if (page > pages) page = pages;
      }
      const offset = (page - 1) * limit;
      try { headers = cache.pageHeaders({ ...filter, limit, offset }); } catch { /* empty index */ }
    }

    let blocks = [];
    if (headers.length) {
      blocks = decorateBlockRows(cache, headers);
    } else if (!filtered) {
      try { height = (await rpc.call('getblockchaininfo')).blocks || 0; } catch { /* node down */ }
      total = height > 0 ? height + 1 : 0;
      const pages = Math.max(1, Math.ceil((total || 1) / limit));
      if (page > pages) page = pages;
      const high = height - ((page - 1) * limit);
      const heights = [];
      for (let h = high; h > Math.max(-1, high - limit); h--) heights.push(h);
      const fetched = await Promise.all(heights.map(async (h) => {
        try {
          const hash = await rpc.call('getblockhash', [h]);
          return await rpc.call('getblockheader', [hash, true]);
        } catch { return null; }
      }));
      blocks = decorateBlockRows(cache, fetched.filter(Boolean), { opsUnknown: true });
    }
    if (height == null || height === 0) {
      height = (cache.getTip() || {}).height || (blocks[0] && blocks[0].height) || 0;
    }
    const extra = {};
    if (parsed.q) extra.q = parsed.q;
    if (ops) extra.ops = ops;
    if (limit !== PAGE_SIZE) extra.limit = limit;
    res.render('blocks', {
      blocks,
      height,
      limit,
      q: parsed.q,
      ops: ops || '',
      opsInvalid,
      maxHeight: parsed.maxHeight,
      pager: buildPager({ path: '/blocks', page, limit, total, extra }),
    });
  });

  app.get('/block/:hash', async (req, res) => {
    res.locals.page = 'blocks';
    let block = null;
    try {
      const key = req.params.hash;
      const arg = /^[0-9]+$/.test(key) ? await rpc.call('getblockhash', [Number(key)]) : key;
      block = await rpc.call('getblock', [arg, 2]);
      for (const tx of block.tx || []) {
        tx._nameOps = nameOpsFromTx(tx);
      }
      block._nameOpCount = (block.tx || []).reduce((a, t) => a + (t._nameOps || []).length, 0);
    } catch (e) { res.locals.error = e.message; }
    res.render('block', { block });
  });

  app.get('/tx/:txid', async (req, res) => {
    res.locals.page = 'txs';
    let tx = null, nameOps = [];
    try {
      tx = await rpc.call('getrawtransaction', [req.params.txid, true]);
      nameOps = nameOpsFromTx(tx);
    } catch (e) { res.locals.error = e.message; }
    res.render('tx', { tx, nameOps });
  });

  app.get('/operations', async (req, res) => {
    res.locals.page = 'operations';
    const { op = null } = req.query;
    const n = parseLimit(req.query.limit, PAGE_SIZE, 100);
    let page = parsePage(req.query.page);
    const tip = cache.getTip();
    const chainTip = tip ? tip.height : 0;
    const canonical = canonicalizeFilter(op);
    const showCommitments = flagOn(req.query.commitments) || canonical === 'NAME_NEW';
    const filter = { op: canonical, hideCommitments: !showCommitments };
    let total = 0;
    try { total = cache.countRecentOps(filter); } catch { /* empty index */ }
    if (total > 0) {
      const pages = Math.max(1, Math.ceil(total / n));
      if (page > pages) page = pages;
    }
    const feed = cache.recentOps({
      ...filter,
      limit: n,
      offset: (page - 1) * n,
    }).map((o) => ({
      ...o,
      block: o.height,
      time: o.time,
      displayOp: (o.op === 'NAME_UPDATE' && o.prev_address && o.address && o.prev_address !== o.address)
        ? 'TRANSFER'
        : o.op,
    }));
    let lastOpHeight = chainTip;
    try {
      const latest = cache.recentOps({ ...filter, limit: 1, offset: 0 });
      if (latest.length) lastOpHeight = latest[0].height;
    } catch { /* empty index */ }
    const extra = {};
    if (canonical) extra.op = canonical;
    if (showCommitments) extra.commitments = '1';
    if (n !== PAGE_SIZE) extra.limit = n;
    res.render('operations', {
      feed,
      scanInfo: { range: lastOpHeight, tip: chainTip },
      op: canonical || null,
      commitments: showCommitments,
      limit: n,
      now: Date.now(),
      pager: buildPager({ path: '/operations', page, limit: n, total, extra }),
    });
  });

  app.get('/operations/pending', async (req, res) => {
    res.locals.page = 'operations';
    const showCommitments = flagOn(req.query.commitments);
    let pending = [];
    let mempoolInfo = null;
    try {
      pending = await rpc.namePending();
      mempoolInfo = await rpc.call('getmempoolinfo');
      if (!showCommitments && Array.isArray(pending)) {
        pending = pending.filter((p) => p.op !== 'NAME_NEW');
      }
    } catch (e) { res.locals.error = e.message; }
    res.render('operations-pending', {
      pending, mempoolInfo, now: Date.now(), commitments: showCommitments,
    });
  });

  app.get('/stats', async (req, res) => {
    res.locals.page = 'stats';
    const priceRange = parsePriceRange(req.query.range);
    const hrRange = parsePriceRange(req.query.hr);
    const opsRange = parsePriceRange(req.query.ops);
    let stats = {};
    try {
      stats = await gatherStats(rpc, cache, { priceRange, hrRange, opsRange });
    } catch (e) { res.locals.error = e.message; }
    res.render('stats', {
      stats,
      priceRange,
      hrRange,
      opsRange,
      statsHref: (kind, value) => statsHref({ range: priceRange, hr: hrRange, ops: opsRange }, kind, value),
    });
  });

  app.get('/api/names', async (req, res) => {
    const { start = '', limit = 20, ns = null } = req.query;
    const rows = cache.page({ start, limit: Math.min(Number(limit) || 20, 100), ns });
    sendApiJson(req, res, { items: rows.map((r) => ({ name: r.name, value: r.value, height: r.height, expired: !!r.expired })) });
  });

  app.get('/api/name/*', async (req, res) => {
    let n = req.params[0] || '';
    try { n = decodeURIComponent(n); } catch (e) { /* keep raw */ }
    n = n.replace(/\/+$/, '');
    try {
      let result;
      if (n.endsWith('/history')) {
        const real = n.slice(0, -'/history'.length);
        result = await rpc.nameHistory(real);
      } else if (n.endsWith('/pending')) {
        result = await rpc.namePending(n.slice(0, -'/pending'.length));
      } else {
        result = await rpc.nameShow(n);
      }
      sendApiJson(req, res, result);
    } catch (e) {
      sendApiJson(req, res, { error: e.message }, 404);
    }
  });

  app.get('/api/stats', async (req, res) => {
    try {
      const s = await gatherStats(rpc, cache);
      sendApiJson(req, res, {
        totalNames: s.totalNames,
        liveNames: s.liveNames,
        expiredNames: s.expiredNames,
        byNamespace: s.namespaces,
        topAddresses: s.topAddresses,
        chain: s.chain,
        mining: {
          difficulty: s.difficulty,
          hashrate: s.hashrate,
          sizeOnDisk: s.chain.size_on_disk,
        },
        market: s.market && s.market.price != null ? {
          price: s.market.price,
          change24h: s.market.change24h,
          volume24h: s.market.volume24h,
          marketCap: s.market.marketCap,
          circulating: s.market.circulating,
          ath: s.market.ath,
          rank: s.market.rank,
          source: s.market.source,
          stale: !!s.market.stale,
        } : null,
      });
    } catch (e) {
      sendApiJson(req, res, { error: e.message }, 500);
    }
  });
};

const PAGE_SIZE = 20;

function parseLimit(raw, fallback = PAGE_SIZE, cap = 50) {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.min(Math.floor(n), cap);
}

function parsePage(raw) {
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 1) return 1;
  return Math.floor(n);
}

function hrefWithQuery(path, params) {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params || {})) {
    if (v == null || v === '' || v === false) continue;
    q.set(k, String(v));
  }
  const s = q.toString();
  return s ? path + '?' + s : path;
}

function buildPager({ path, page, limit, total, extra = {} }) {
  const pages = Math.max(1, Math.ceil((Number(total) || 0) / (limit || PAGE_SIZE)));
  const current = Math.min(Math.max(page || 1, 1), pages);
  const href = (p) => hrefWithQuery(path, { ...extra, page: p > 1 ? p : undefined });
  return {
    page: current,
    pages,
    limit,
    total: Number(total) || 0,
    prevHref: current > 1 ? href(current - 1) : null,
    nextHref: current < pages ? href(current + 1) : null,
  };
}

function decorateBlockRows(cache, rows, { opsUnknown = false } = {}) {
  const list = rows || [];
  let counts = new Map();
  if (!opsUnknown) {
    try { counts = cache.opCountsByHeight(list.map((b) => b.height)); } catch { /* empty index */ }
  }
  return list.map((b) => ({
    height: b.height,
    hash: b.hash,
    time: b.time,
    previousblockhash: b.prev || b.previousblockhash,
    nTx: b.ntx != null ? b.ntx : b.nTx,
    _nameOpCount: opsUnknown ? null : (counts.get(Number(b.height)) || 0),
  }));
}

function flagOn(v) {
  if (Array.isArray(v)) return v.includes('1') || v.includes(1);
  return v === '1' || v === 1 || v === true;
}

function canonicalizeFilter(op) {
  if (!op) return null;
  const s = String(op).toUpperCase().replace(/^OP_/, '');
  if (s === 'NAME_NEW' || s === 'NEW') return 'NAME_NEW';
  if (s.indexOf('FIRST') >= 0) return 'NAME_FIRSTUPDATE';
  if (s === 'NAME_UPDATE' || s === 'UPDATE') return 'NAME_UPDATE';
  return null;
}

function parseBlocksQuery(q) {
  const raw = String(q == null ? '' : q).trim();
  if (!raw) return { q: '', maxHeight: null, hashPrefix: null, invalid: false };
  const compact = raw.replace(/^#/, '').replace(/[,_\s]/g, '');
  if (/^\d+$/.test(compact)) {
    const n = Number(compact);
    if (!Number.isFinite(n) || n < 0) return { q: raw, maxHeight: null, hashPrefix: null, invalid: true };
    return { q: raw, maxHeight: Math.floor(n), hashPrefix: null, invalid: false };
  }
  const hex = compact.replace(/^0x/i, '');
  if (/^[0-9a-fA-F]+$/.test(hex) && hex.length >= 1 && hex.length <= 64) {
    return { q: raw, maxHeight: null, hashPrefix: hex.toLowerCase(), invalid: false };
  }
  return { q: raw, maxHeight: null, hashPrefix: null, invalid: true };
}

function canonicalizeBlocksOps(ops) {
  if (!ops) return null;
  const s = String(ops).toLowerCase();
  if (s === 'with' || s === 'ops') return 'with';
  if (s === 'none' || s === 'empty') return 'none';
  if (s === 'busy' || s === 'hot') return 'busy';
  return canonicalizeFilter(ops);
}
