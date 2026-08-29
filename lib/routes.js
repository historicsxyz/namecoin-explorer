'use strict';

// Extra routes: namespace, blocks, txs, operations feed, stats, JSON API
const { nameOpsFromTx } = require('./txops');
const {
  decorateRpcBlock,
  viewBlockFromCache,
  publicInputs,
  publicOutputs,
  parentBitcoinHash,
  sumVoutNmc,
  isCoinbaseVin,
} = require('./chainview');
const { sendApiJson } = require('./api-json');
const { gatherStats, parsePriceRange, statsHref } = require('./statsdata');
const { loadNameRecord } = require('./names');
const {
  parseTxOps,
  parseTxRange,
  filterTxGroups,
  nameOpTxQuery,
  rangeExceedsWindow,
  countListedTxs,
} = require('./txfilters');
const { parseLimit } = require('./httpcache');

module.exports = function registerRoutes(app, { rpc, cache, ingest, caches } = {}) {
  function statsCacheKey(priceRange, hrRange, opsRange) {
    return 'st|' + priceRange + '|' + hrRange + '|' + opsRange;
  }
  function loadStats(opts) {
    const run = () => gatherStats(rpc, cache, opts);
    if (caches && caches.stats) return caches.stats.getOrLoad(statsCacheKey(opts.priceRange, opts.hrRange, opts.opsRange), run);
    return run();
  }
  function loadName(name) {
    const run = () => loadNameRecord(rpc, cache, name);
    if (caches && caches.names) return caches.names.getOrLoad('p|' + name, run);
    return run();
  }

  app.get('/namespaces', async (req, res) => {
    res.locals.page = 'namespace';
    let namespaces = [];
    try { namespaces = cache.countByNamespace(); } catch { namespaces = []; }
    res.render('namespaces', { namespaces });
  });

  app.get('/namespace/:ns', async (req, res) => {
    res.locals.page = 'namespace';
    const ns = (req.params.ns || '').replace(/\/+$/, '').toLowerCase();
    const { limit = 50, start = '', status = null } = req.query;
    const cap = parseLimit(limit, 50, 100);
    const startKey = String(start || '').slice(0, 255);
    const rows = cache.page({ start: startKey, limit: cap, ns, status });
    const info = cache.countByNamespace().find((r) => r.namespace === ns + '/') || { total: 0, live: 0, expired: 0 };
    res.render('namespace', { ns, rows, info, start: startKey, limit: cap, status });
  });

  app.get('/blocks', async (req, res) => {
    res.locals.page = 'blocks';
    const limit = parseLimit(req.query.limit || req.query.count, PAGE_SIZE, 50);
    let page = parsePage(req.query.page);
    const parsed = parseBlocksQuery(req.query.q);
    const { ops, invalid: opsInvalid } = parseTxOps(req.query.ops);
    const { range, since, invalid: rangeInvalid } = parseTxRange(req.query.range);
    let height = (cache.getTip() || {}).height || 0;

    if (parsed.hashPrefix && parsed.hashPrefix.length === 64 && !ops && !range) {
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
      since,
    };
    const filtered = !!(filter.maxHeight != null || filter.hashPrefix || filter.ops
      || filter.since != null || parsed.invalid || opsInvalid || rangeInvalid);

    let total = 0;
    let headers = [];
    if (!parsed.invalid && !opsInvalid && !rangeInvalid) {
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
    if (range) extra.range = range;
    if (limit !== PAGE_SIZE) extra.limit = limit;
    res.render('blocks', {
      blocks,
      height,
      limit,
      q: parsed.q,
      ops: ops || '',
      opsInvalid,
      range: range || '',
      rangeInvalid,
      maxHeight: parsed.maxHeight,
      pager: buildPager({ path: '/blocks', page, limit, total, extra }),
    });
  });

  app.get('/block/:hash', async (req, res) => {
    res.locals.page = 'blocks';
    const key = req.params.hash;
    let block = null;
    let fromCache = false;
    try {
      const arg = /^[0-9]+$/.test(key) ? await rpc.call('getblockhash', [Number(key)]) : key;
      block = decorateRpcBlock(await rpc.call('getblock', [arg, 2]));
    } catch (e) {
      const cached = cacheBlockPayload(cache, key);
      if (cached) {
        block = viewBlockFromCache(cached);
        fromCache = true;
      } else {
        res.locals.error = e.message;
      }
    }
    res.render('block', { block, fromCache });
  });

  app.get('/tx', async (req, res) => {
    res.locals.page = 'txs';
    const q = String(req.query.q || '').trim();
    const hex = q.replace(/^0x/i, '');
    if (/^[0-9a-fA-F]{64}$/.test(hex)) {
      return res.redirect(302, '/tx/' + hex.toLowerCase());
    }
    const invalid = !!q && !/^[0-9a-fA-F]{64}$/.test(hex);
    const { ops, invalid: opsInvalid } = parseTxOps(req.query.ops);
    const { range, since, invalid: rangeInvalid } = parseTxRange(req.query.range);
    const list = await loadRecentTxs(rpc, cache, { ops, since });
    res.render('txs', {
      q,
      invalid,
      ops,
      opsInvalid,
      range,
      rangeInvalid,
      ...list,
    });
  });

  app.get('/tx/:txid', async (req, res) => {
    res.locals.page = 'txs';
    const id = String(req.params.txid || '').trim();
    const { tx, nameOps, fromCache, error } = await loadTxDetail(rpc, cache, id);
    if (error) res.locals.error = error;
    res.render('tx', {
      tx,
      nameOps,
      fromCache,
      txid: (tx && tx.txid) || id,
    });
  });

  app.get('/operations', async (req, res) => {
    res.locals.page = 'operations';
    const { op = null } = req.query;
    const n = parseLimit(req.query.limit, PAGE_SIZE, 100);
    let page = parsePage(req.query.page);
    const tip = cache.getTip();
    const chainTip = tip ? tip.height : 0;
    const canonical = canonicalizeFilter(op);
    const filter = { op: canonical };
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
      ...withDisplayOp(o),
      block: o.height,
      time: o.time,
    }));
    let lastOpHeight = chainTip;
    try {
      const latest = cache.recentOps({ ...filter, limit: 1, offset: 0 });
      if (latest.length) lastOpHeight = latest[0].height;
    } catch { /* empty index */ }
    const extra = {};
    if (canonical) extra.op = canonical;
    if (n !== PAGE_SIZE) extra.limit = n;
    res.render('operations', {
      feed,
      scanInfo: { range: lastOpHeight, tip: chainTip },
      op: canonical || null,
      limit: n,
      now: Date.now(),
      pager: buildPager({ path: '/operations', page, limit: n, total, extra }),
    });
  });

  app.get('/operations/pending', async (req, res) => {
    res.locals.page = 'operations';
    let pending = [];
    let mempoolInfo = null;
    try {
      pending = await rpc.namePending();
      mempoolInfo = await rpc.call('getmempoolinfo');
    } catch (e) { res.locals.error = e.message; }
    res.render('operations-pending', {
      pending, mempoolInfo, now: Date.now(),
    });
  });

  app.get('/addresses', async (req, res) => {
    res.locals.page = 'address';
    const limit = parseLimit(req.query.limit, PAGE_SIZE, 50);
    let page = parsePage(req.query.page);
    let total = 0;
    try { total = cache.countAddresses(); } catch { total = 0; }
    if (total > 0) {
      const pages = Math.max(1, Math.ceil(total / limit));
      if (page > pages) page = pages;
    }
    let rows = [];
    try { rows = cache.pageAddresses({ limit, offset: (page - 1) * limit }); } catch { rows = []; }
    const extra = {};
    if (limit !== PAGE_SIZE) extra.limit = limit;
    res.render('addresses', {
      rows,
      pager: buildPager({ path: '/addresses', page, limit, total, extra }),
    });
  });

  app.get('/address/:addr', async (req, res) => {
    res.locals.page = 'address';
    let addr = req.params.addr || '';
    try { addr = decodeURIComponent(addr); } catch { /* keep raw */ }
    addr = String(addr).trim();
    let names = [];
    let ops = [];
    let seen = false;
    if (addr) {
      try { seen = cache.addressSeen(addr); } catch { seen = false; }
      try { names = cache.namesByAddress(addr, { limit: 200 }); } catch { names = []; }
      try {
        ops = cache.opsByAddress(addr, { limit: 80 }).map((o) => ({
          ...o,
          displayOp: (o.op === 'NAME_UPDATE' && o.prev_address && o.address && o.prev_address !== o.address)
            ? 'TRANSFER'
            : o.op,
        }));
      } catch { ops = []; }
    }
    res.render('address', { addr, names, ops, seen });
  });

  app.get('/stats', async (req, res) => {
    res.locals.page = 'stats';
    const priceRange = parsePriceRange(req.query.range);
    const hrRange = parsePriceRange(req.query.hr);
    const opsRange = parsePriceRange(req.query.ops);
    let stats = {};
    try {
      stats = await loadStats({ priceRange, hrRange, opsRange });
    } catch (e) { res.locals.error = e.message; }
    res.render('stats', {
      stats,
      priceRange,
      hrRange,
      opsRange,
      statsHref: (kind, value) => statsHref({ range: priceRange, hr: hrRange, ops: opsRange }, kind, value),
    });
  });

  app.get('/api/namespaces', async (req, res) => {
    let namespaces = [];
    try { namespaces = cache.countByNamespace(); } catch { namespaces = []; }
    sendApiJson(req, res, { items: namespaces, source: 'index' });
  });

  app.get('/api/namespace/:ns', async (req, res) => {
    const ns = (req.params.ns || '').replace(/\/+$/, '').toLowerCase();
    const { limit = 50, start = '', status = null } = req.query;
    const cap = parseLimit(limit, 50, 100);
    const startKey = String(start || '').slice(0, 255);
    let rows = [];
    let info = { total: 0, live: 0, expired: 0 };
    try {
      rows = cache.page({ start: startKey, limit: cap, ns, status });
      info = cache.countByNamespace().find((r) => r.namespace === ns + '/') || info;
    } catch { rows = []; }
    sendApiJson(req, res, {
      ns,
      info,
      items: rows.map(publicName),
      source: 'index',
    });
  });

  app.get('/api/operations/pending', async (req, res) => {
    try {
      const pending = await rpc.namePending();
      const mempool = await rpc.call('getmempoolinfo');
      sendApiJson(req, res, {
        items: (pending || []).map((p) => ({
          name: p.name, op: p.op, value: p.value, address: p.address,
        })),
        mempool: mempool && mempool.size != null ? { size: mempool.size } : null,
        source: 'rpc',
      });
    } catch (e) {
      sendApiJson(req, res, { error: e.message, items: [] }, 503);
    }
  });

  app.get('/api/operations', async (req, res) => {
    const canonical = canonicalizeFilter(req.query.op);
    const limit = parseLimit(req.query.limit, PAGE_SIZE, 100);
    const page = parsePage(req.query.page);
    const filter = { op: canonical };
    let total = 0;
    let items = [];
    try { total = cache.countRecentOps(filter); } catch { total = 0; }
    try {
      items = cache.recentOps({ ...filter, limit, offset: (page - 1) * limit }).map(publicOp);
    } catch { items = []; }
    sendApiJson(req, res, {
      items,
      op: canonical,
      page,
      limit,
      total,
      source: 'index',
    });
  });

  app.get('/api/blocks', async (req, res) => {
    const limit = parseLimit(req.query.limit, PAGE_SIZE, 50);
    const page = parsePage(req.query.page);
    let total = 0;
    let headers = [];
    try { total = cache.countHeaders(); } catch { total = 0; }
    try { headers = cache.pageHeaders({ limit, offset: (page - 1) * limit }); } catch { headers = []; }
    sendApiJson(req, res, {
      items: decorateBlockRows(cache, headers),
      page,
      limit,
      total,
      source: 'index',
    });
  });

  app.get('/api/block/:hash', async (req, res) => {
    const key = String(req.params.hash || '').trim();
    try {
      const arg = /^[0-9]+$/.test(key) ? await rpc.call('getblockhash', [Number(key)]) : key;
      const block = await rpc.call('getblock', [arg, 2]);
      sendApiJson(req, res, rpcBlockPayload(block));
    } catch (e) {
      const cached = cacheBlockPayload(cache, key);
      if (cached) sendApiJson(req, res, cached);
      else sendApiJson(req, res, { error: e.message }, 404);
    }
  });

  app.get('/api/tx', async (req, res) => {
    const { ops } = parseTxOps(req.query.ops);
    const { range, since } = parseTxRange(req.query.range);
    const {
      groups, fallback, usedFallback, partialFallback, opsByTxid, indexRange,
    } = await loadRecentTxs(rpc, cache, { ops, since });
    const countOps = (id) => ((opsByTxid && opsByTxid[String(id).toLowerCase()]) || []).length;
    const items = (fallback || []).map((o) => ({
      txid: o.txid,
      height: o.height,
      time: o.time != null ? o.time : null,
      nameOps: countOps(o.txid) || o.nameOps || 1,
    }));
    if (usedFallback || indexRange) {
      sendApiJson(req, res, {
        source: 'index',
        ops: ops || null,
        range: range || null,
        items,
      });
      return;
    }
    sendApiJson(req, res, {
      source: partialFallback ? 'mixed' : 'rpc',
      ops: ops || null,
      range: range || null,
      groups: (groups || []).map((g) => ({
        height: g.height,
        hash: g.hash,
        time: g.time,
        fromCache: !!g.fromCache,
        tx: (g.tx || []).map((txid) => {
          const id = typeof txid === 'string' ? txid : (txid && txid.txid);
          return id ? { txid: id, nameOps: countOps(id) } : null;
        }).filter(Boolean),
      })),
    });
  });

  app.get('/api/tx/:txid', async (req, res) => {
    const id = String(req.params.txid || '').trim();
    const { tx, nameOps, fromCache, error } = await loadTxDetail(rpc, cache, id);
    if (!tx && !nameOps.length) {
      sendApiJson(req, res, { error: error || 'Transaction not found', txid: id }, 404);
      return;
    }
    sendApiJson(req, res, {
      txid: (tx && tx.txid) || id,
      source: fromCache ? 'index' : 'rpc',
      tx: tx ? {
        txid: tx.txid,
        blockhash: tx.blockhash || null,
        confirmations: tx.confirmations,
        time: tx.blocktime || tx.time || null,
        vin: (tx.vin || []).length,
        vout: (tx.vout || []).length,
        fee: tx.fee != null ? tx.fee : null,
        inputs: publicInputs(tx),
        outputs: publicOutputs(tx),
      } : null,
      nameOps: nameOps.map(publicOp),
    });
  });

  app.get('/api/addresses', async (req, res) => {
    const limit = parseLimit(req.query.limit, PAGE_SIZE, 50);
    const page = parsePage(req.query.page);
    let total = 0;
    let items = [];
    try { total = cache.countAddresses(); } catch { total = 0; }
    try { items = cache.pageAddresses({ limit, offset: (page - 1) * limit }); } catch { items = []; }
    sendApiJson(req, res, { items, page, limit, total, source: 'index' });
  });

  app.get('/api/address/:addr', async (req, res) => {
    let addr = req.params.addr || '';
    try { addr = decodeURIComponent(addr); } catch { /* keep raw */ }
    addr = String(addr).trim();
    let names = [];
    let ops = [];
    let seen = false;
    if (addr) {
      try { seen = cache.addressSeen(addr); } catch { seen = false; }
      try { names = cache.namesByAddress(addr, { limit: 200 }).map(publicName); } catch { names = []; }
      try { ops = cache.opsByAddress(addr, { limit: 80 }).map(publicOp); } catch { ops = []; }
    }
    sendApiJson(req, res, { address: addr, seen, names, ops, source: 'index' });
  });

  app.get('/api/names', async (req, res) => {
    const { start = '', limit = 20, ns = null } = req.query;
    const rows = cache.page({ start, limit: Math.min(Number(limit) || 20, 100), ns });
    sendApiJson(req, res, { items: rows.map(publicName), source: 'index' });
  });

  app.get('/api/name/*', async (req, res) => {
    let n = req.params[0] || '';
    try { n = decodeURIComponent(n); } catch (e) { /* keep raw */ }
    n = n.replace(/\/+$/, '');
    if (n.endsWith('/history')) {
      const real = n.slice(0, -'/history'.length);
      try {
        const items = await rpc.nameHistory(real);
        sendApiJson(req, res, { items, source: 'rpc' });
      } catch (e) {
        let items = [];
        try { items = cache.opsForName(real).map(publicOp); } catch { items = []; }
        if (items.length) sendApiJson(req, res, { items, source: 'index' });
        else sendApiJson(req, res, { error: e.message, items: [] }, 404);
      }
      return;
    }
    if (n.endsWith('/pending')) {
      const real = n.slice(0, -'/pending'.length);
      try {
        const items = await rpc.namePending(real);
        sendApiJson(req, res, { items, source: 'rpc' });
      } catch (e) {
        sendApiJson(req, res, { error: e.message, items: [] }, 503);
      }
      return;
    }
    const loaded = await loadName(n);
    if (!loaded.show) {
      sendApiJson(req, res, { error: loaded.error || 'Name not found', name: n }, 404);
      return;
    }
    sendApiJson(req, res, { ...loaded.show, source: loaded.fromCache ? 'index' : 'rpc' });
  });

  app.get('/api/stats', async (req, res) => {
    try {
      const s = await loadStats({
        priceRange: parsePriceRange(req.query.range),
        hrRange: parsePriceRange(req.query.hr),
        opsRange: parsePriceRange(req.query.ops),
      });
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

async function loadRecentTxs(rpc, cache, filter = {}) {
  const ops = filter.ops || null;
  const since = filter.since != null ? filter.since : null;
  let headers = [];
  try { headers = cache.latestHeaders(10); } catch { headers = []; }
  let groups = [];
  const failed = [];
  for (const h of headers) {
    try {
      const block = await rpc.call('getblock', [h.hash, 1]);
      groups.push({
        height: h.height,
        hash: h.hash,
        time: h.time,
        tx: (block && block.tx) || [],
      });
    } catch {
      failed.push(h);
    }
  }
  let fallback = [];
  let usedFallback = !groups.length;
  let partialFallback = false;
  let indexRange = false;
  let rangeLimited = false;
  let noneNeedsRpc = false;
  if (groups.length && failed.length) {
    partialFallback = true;
    for (const h of failed) groups.push(cacheTxGroup(cache, h));
    groups.sort((a, b) => Number(b.height) - Number(a.height));
  }

  const loadedGroups = groups;
  const needIndexRange = !usedFallback && !!ops && ops !== 'none' && rangeExceedsWindow(since, loadedGroups);

  if (ops === 'none' && usedFallback) {
    noneNeedsRpc = true;
    fallback = [];
    groups = [];
  } else if (usedFallback || needIndexRange) {
    try { fallback = cache.recentNameOpTxs(nameOpTxQuery(ops, since, 40)); }
    catch { fallback = []; }
    groups = [];
    if (needIndexRange) {
      indexRange = true;
      usedFallback = false;
      partialFallback = false;
    }
  } else {
    let opsByTxid = collectOpsByTxid(cache, groups, []);
    groups = filterTxGroups(groups, { ops, since, opsByTxid });
    fallback = [];
    rangeLimited = since != null;
  }

  const opsByTxid = collectOpsByTxid(cache, groups, fallback);
  const matching = countListedTxs(groups, fallback);
  return {
    groups,
    fallback,
    usedFallback,
    partialFallback,
    opsByTxid,
    indexRange,
    rangeLimited,
    noneNeedsRpc,
    matching,
  };
}

async function loadTxDetail(rpc, cache, id) {
  let tx = null;
  let nameOps = [];
  let fromCache = false;
  let error = null;
  try {
    tx = await rpc.call('getrawtransaction', [id, true]);
    nameOps = nameOpsFromTx(tx).map(withDisplayOp);
  } catch (e) {
    nameOps = nameOpsForTxid(cache, id).map(withDisplayOp);
    if (nameOps.length) fromCache = true;
    else error = e.message;
  }
  return { tx, nameOps, fromCache, error };
}

function publicOp(o) {
  if (!o) return o;
  const d = withDisplayOp(o);
  return {
    txid: d.txid || null,
    vout: d.vout,
    height: d.height != null ? d.height : null,
    time: d.time != null ? d.time : null,
    op: d.op,
    displayOp: d.displayOp,
    name: d.name || null,
    value: d.value != null ? d.value : null,
    address: d.address || null,
    prev_address: d.prev_address || null,
  };
}

function publicName(r) {
  if (!r) return r;
  return {
    name: r.name,
    value: r.value,
    address: r.address || null,
    height: r.height,
    expired: !!r.expired,
    expires_in: r.expires_in != null ? r.expires_in : null,
  };
}

function rpcBlockPayload(block) {
  const tx = (block.tx || []).map((t) => {
    const nameOps = nameOpsFromTx(t).map(publicOp);
    return {
      txid: t.txid,
      vin: (t.vin || []).length,
      vout: (t.vout || []).length,
      nameOps,
    };
  });
  const nameOps = tx.flatMap((t) => t.nameOps.map((o) => ({ ...o, txid: t.txid })));
  const coinbase = (block.tx || []).find((t) => t && isCoinbaseVin((t.vin || [])[0]));
  return {
    hash: block.hash,
    height: block.height,
    time: block.time,
    previousblockhash: block.previousblockhash || null,
    nextblockhash: block.nextblockhash || null,
    nTx: block.nTx,
    merkleroot: block.merkleroot,
    nonce: block.nonce,
    version: block.version != null ? block.version : null,
    bits: block.bits != null ? String(block.bits) : null,
    difficulty: block.difficulty != null ? Number(block.difficulty) : null,
    size: block.size != null ? block.size : null,
    weight: block.weight != null ? block.weight : null,
    parentBitcoinHash: parentBitcoinHash(block.auxpow),
    coinbase: coinbase ? sumVoutNmc(coinbase) : null,
    nameOpCount: nameOps.length,
    nameOps,
    tx,
    source: 'rpc',
  };
}

function cacheBlockPayload(cache, key) {
  let hdr = null;
  try {
    hdr = /^[0-9]+$/.test(key) ? cache.headerAt(Number(key)) : cache.headerByHash(key);
  } catch { hdr = null; }
  if (!hdr) return null;
  let ops = [];
  try { ops = cache.opsAtHeight(hdr.height, { hideCommitments: false }).map(publicOp); } catch { ops = []; }
  let next = null;
  try { next = cache.headerAt(Number(hdr.height) + 1); } catch { next = null; }
  return {
    hash: hdr.hash,
    height: hdr.height,
    time: hdr.time,
    previousblockhash: hdr.prev || null,
    nextblockhash: next && next.hash ? next.hash : null,
    nTx: hdr.ntx != null ? hdr.ntx : null,
    merkleroot: hdr.merkle || null,
    difficulty: hdr.difficulty != null ? Number(hdr.difficulty) : null,
    nameOpCount: ops.length,
    nameOps: ops,
    source: 'index',
  };
}

function cacheTxGroup(cache, h) {
  let ops = [];
  try { ops = cache.opsAtHeight(h.height, { hideCommitments: false }); } catch { ops = []; }
  const seen = new Set();
  const tx = [];
  for (const o of ops) {
    if (!o || !o.txid || seen.has(o.txid)) continue;
    seen.add(o.txid);
    tx.push(o.txid);
  }
  return {
    height: h.height,
    hash: h.hash,
    time: h.time,
    tx,
    fromCache: true,
  };
}

function collectOpsByTxid(cache, groups, fallback) {
  const ids = [];
  for (const g of groups || []) {
    for (const txid of g.tx || []) {
      const id = typeof txid === 'string' ? txid : (txid && txid.txid);
      if (id) ids.push(id);
    }
  }
  for (const o of fallback || []) {
    if (o && o.txid) ids.push(o.txid);
  }
  try { return cache.opsForTxids(ids); } catch { return Object.create(null); }
}

function nameOpsForTxid(cache, txid) {
  try {
    const map = cache.opsForTxids([txid]);
    return map[String(txid || '').toLowerCase()] || [];
  } catch { return []; }
}

function withDisplayOp(o) {
  if (!o) return o;
  const displayOp = (o.op === 'NAME_UPDATE' && o.prev_address && o.address && o.prev_address !== o.address)
    ? 'TRANSFER'
    : o.op;
  return { ...o, displayOp };
}

function parsePage(raw) {
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 1) return 1;
  return Math.min(Math.floor(n), 100000);
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
    try {
      counts = cache.opCountsByHeight(list.map((b) => b.height), { hideCommitments: false });
    } catch { /* empty index */ }
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

