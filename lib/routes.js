'use strict';

// Extra routes: namespace, blocks, txs, operations feed, stats, JSON API
const { nameOpsFromTx } = require('./txops');
const { sendApiJson } = require('./api-json');

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
    const count = Math.min(Number(req.query.count) || 15, 50);
    let height = (cache.getTip() || {}).height || 0;
    let blocks = cache.latestHeaders(count);
    if (!blocks.length) {
      try { height = (await rpc.call('getblockchaininfo')).blocks || 0; } catch { /* node down */ }
      blocks = [];
      for (let h = height; h > Math.max(0, height - count); h--) {
        try {
          const hash = await rpc.call('getblockhash', [h]);
          blocks.push(await rpc.call('getblockheader', [hash, true]));
        } catch { /* skip */ }
      }
    } else {
      blocks = blocks.map((b) => ({
        height: b.height,
        hash: b.hash,
        time: b.time,
        previousblockhash: b.prev,
        nTx: b.ntx,
      }));
    }
    res.render('blocks', { blocks, height });
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
    const { op = null, limit = 50 } = req.query;
    const n = Math.min(Number(limit) || 50, 200);
    const tip = cache.getTip();
    const chainTip = tip ? tip.height : 0;
    const canonical = canonicalizeFilter(op);
    const showCommitments = flagOn(req.query.commitments) || canonical === 'NAME_NEW';
    const feed = cache.recentOps({
      op: canonical,
      limit: n,
      hideCommitments: !showCommitments,
    }).map((o) => ({
      ...o,
      block: o.height,
      time: o.time,
      displayOp: (o.op === 'NAME_UPDATE' && o.prev_address && o.address && o.prev_address !== o.address)
        ? 'TRANSFER'
        : o.op,
    }));
    const scanRange = feed.length ? feed[feed.length - 1].height : chainTip;
    res.render('operations', {
      feed,
      scanInfo: { range: scanRange, tip: chainTip },
      op: canonical || null,
      commitments: showCommitments,
      limit: n,
      now: Date.now(),
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
    let stats = {};
    try {
      const byNs = cache.countByNamespace();
      stats.totalNames = byNs.reduce((a, r) => a + r.total, 0);
      stats.liveNames = byNs.reduce((a, r) => a + (r.live || 0), 0);
      stats.expiredNames = byNs.reduce((a, r) => a + (r.expired || 0), 0);
      stats.namespaces = byNs;
      stats.chain = res.locals.chainInfo || {};
    } catch (e) { res.locals.error = e.message; }
    res.render('stats', { stats });
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
    const byNs = cache.countByNamespace();
    sendApiJson(req, res, {
      totalNames: byNs.reduce((a, r) => a + r.total, 0),
      byNamespace: byNs,
      chain: res.locals.chainInfo || {},
    });
  });
};

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
