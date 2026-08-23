'use strict';

// Additional routes: namespace browser, blocks, txs, name-operations feed, stats, JSON API
// Attaches to the app instance passed in. Kept separate for clarity.
const { nameOpsFromTx } = require('./txops');

module.exports = function registerRoutes(app, { rpc, cache, registry }) {
  const PAGE_SIZES = { 25: 25, 50: 50, 100: 100, 200: 200, 500: 500 };

  // -----------------------------------------------------------------
  // NAMESPACE browser
  // -----------------------------------------------------------------
  app.get('/namespace/:ns', async (req, res) => {
    res.locals.page = 'names';
    const ns = (req.params.ns || '').replace(/\/+$/, '').toLowerCase();
    const { limit = 100, start = '', status = null } = req.query;
    const rows = cache.page({ start, limit: Math.min(Number(limit) || 100, 500), ns, status });
    const info = cache.countByNamespace().find((r) => r.namespace === ns + '/') || { total: 0, live: 0, expired: 0 };
    res.render('namespace', { ns, rows, info, start, limit: Number(limit), status });
  });

  // =================================================================
  // BLOCKS
  // =================================================================
  app.get('/blocks', async (req, res) => {
    res.locals.page = 'blocks';
    const count = Math.min(Number(req.query.count) || 15, 50);
    let height = 0;
    try { height = (await rpc.call('getblockchaininfo')).blocks || 0; } catch {}
    const blocks = [];
    for (let h = height; h > Math.max(0, height - count); h--) {
      try {
        const hash = await rpc.call('getblockhash', [h]);
        blocks.push(await rpc.call('getblockheader', [hash, true]));
      } catch {}
    }
    res.render('blocks', { blocks, height });
  });

  app.get('/block/:hash', async (req, res) => {
    res.locals.page = 'blocks';
    let block = null;
    try {
      block = await rpc.call('getblock', [req.params.hash, 2]); // verbose=2 includes tx data
      // Extract name ops from each tx
      for (const tx of block.tx || []) {
        tx._nameOps = nameOpsFromTx(tx);
      }
      // count name ops in block
      block._nameOpCount = (block.tx || []).reduce((a, t) => a + (t._nameOps || []).length, 0);
    } catch (e) { res.locals.error = e.message; }
    res.render('block', { block });
  });

  // =================================================================
  // TRANSACTIONS
  // =================================================================
  app.get('/tx/:txid', async (req, res) => {
    res.locals.page = 'txs';
    let tx = null, nameOps = [];
    try {
      tx = await rpc.call('getrawtransaction', [req.params.txid, true]);
      nameOps = nameOpsFromTx(tx);
    } catch (e) { res.locals.error = e.message; }
    res.render('tx', { tx, nameOps });
  });

  // =================================================================
  // NAME OPERATIONS FEED (recent ops from new blocks + mempool)
  // =================================================================
  // We reconstruct recent ops by scanning recent blocks for OP_NAME txs.
  app.get('/operations', async (req, res) => {
    res.locals.page = 'operations';
    const { op = null, limit = 50 } = req.query;
    const n = Math.min(Number(limit) || 50, 200);
    let feed = [];
    let scanRange = null;
    let chainTip = 0;
    try {
      const height = (await rpc.call('getblockchaininfo')).blocks || 0;
      chainTip = height;
      const scanned = [];
      // scan back up to 100 blocks or until we have n ops
      for (let h = height; h > Math.max(0, height - 100) && scanned.length < n; h--) {
        try {
          const hash = await rpc.call('getblockhash', [h]);
          const blk = await rpc.call('getblock', [hash, 2]);
          const ts = blk.time;
          for (const tx of blk.tx || []) {
            const ops = nameOpsFromTx(tx);
            if (op) {
              for (const o of ops) if (o.op === op) scanned.push({ ...o, height: h, time: ts, txid: tx.txid, block: h });
            } else {
              for (const o of ops) scanned.push({ ...o, height: h, time: ts, txid: tx.txid, block: h });
            }
          }
        } catch {}
      }
      feed = scanned.slice(0, n);
      scanRange = scanned.length ? Math.min(scanned[0].height, scanned[scanned.length-1].height) : height;
    } catch (e) { res.locals.error = e.message; }
    res.render('operations', { feed, scanInfo: { range: scanRange, tip: chainTip }, op: op || null, limit: n, now: Date.now() });
  });

  // mempool ops (pending name operations)
  app.get('/operations/pending', async (req, res) => {
    res.locals.page = 'operations';
    let pending = [];
    let mempoolInfo = null;
    try {
      pending = await rpc.call('name_pending', []);
      mempoolInfo = await rpc.call('getmempoolinfo', []);
    } catch (e) { res.locals.error = e.message; }
    res.render('operations-pending', { pending, mempoolInfo, now: Date.now() });
  });

  // =================================================================
  // STATISTICS
  // =================================================================
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
    res.json({ items: rows.map((r) => ({ name: r.name, value: r.value, height: r.height, expired: !!r.expired })) });
  });

  // =================================================================
  // JSON API (read-only) - name lookup. Placed AFTER /api/names.
  // =================================================================
  // Names contain '/', so match the full remaining path and treat it as the name.
  app.get('/api/name/*', async (req, res) => {
    let n = req.params[0] || '';
    try { n = decodeURIComponent(n); } catch (e) {}
    n = n.replace(/\/+$/, '');
    try {
      let result;
      if (n.endsWith('/history')) {
        const real = n.slice(0, -'/history'.length);
        result = await rpc.call('name_history', [real]);
      } else if (n.endsWith('/pending')) {
        result = await rpc.call('name_pending', [n.slice(0, -'/pending'.length)]);
      } else {
        result = await rpc.call('name_show', [n]);
      }
      res.json(result);
    } catch (e) {
      res.status(404).json({ error: e.message });
    }
  });

  app.get('/api/stats', async (req, res) => {
    const byNs = cache.countByNamespace();
    res.json({
      totalNames: byNs.reduce((a, r) => a + r.total, 0),
      byNamespace: byNs,
      chain: res.locals.chainInfo || {},
    });
  });

  // health check
  app.get('/health', async (req, res) => {
    try {
      const info = await rpc.call('getblockchaininfo');
      res.json({ ok: true, blocks: info.blocks, registry: cache.count(), lastSync: registry.lastResult });
    } catch (e) {
      res.json({ ok: false, error: e.message });
    }
  });
};