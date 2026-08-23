'use strict';

// Registry service: maintains a cached, indexed snapshot of the entire
// Namecoin name registry (name_scan) so the UI can filter/count/paginate
// without hitting RPC for every request.
// The registry is ~790k rows; full sync takes a while, so we do it in one
// background pass and refresh periodically. For a big registry we page
// name_scan incrementally and upsert.
const { classifyValue } = require('./names');

class RegistryService {
  constructor(rpc, cache, { refreshMs = 3600 * 1000 } = {}) {
    this.rpc = rpc;
    this.cache = cache;
    this.refreshMs = refreshMs;
    this.lock = null;
    this.lastResult = null;
    this.inFlight = null;
  }

  // Start periodic refresh. Non-blocking; individual sync runs in background.
  start() {
    this._refreshLoop();
  }

  // Force a synchronous full refresh (used on startup).
  async syncNow() {
    return this._doSync();
  }

  _refreshLoop() {
    const tick = async () => {
      try {
        await this._doSync();
      } catch (e) {
        console.error('[registry] refresh error:', e.message);
      }
      setTimeout(tick, this.refreshMs);
    };
    tick(); // first immediately
  }

  async _doSync() {
    if (this.inFlight) return this.inFlight;
    this.inFlight = (async () => {
      const t0 = Date.now();
      let records = [];
      let cursor = '';
      const pageSize = 50000;
      let total = 0;
      // eslint-disable-next-line no-constant-condition
      while (true) {
        let arr;
        try {
          // name_scan [start, count] - start is a string (cursor), count is number
          arr = await this.rpc.call('name_scan', [cursor || '', pageSize]);
        } catch (e) {
          // If we've collected nothing yet, raise; else keep what we have
          if (records.length === 0) throw e;
          break;
        }
        if (!arr || arr.length === 0) break;
        const pageRecs = [];
        for (const r of arr) {
          if (!r.name) continue;
          pageRecs.push({
            name: r.name,
            name_hex: r.name != null ? Buffer.from(r.name, 'utf8').toString('hex') : r.name,
            namespace: r.name.includes('/') ? r.name.split('/')[0] + '/' : '(root)',
            value: r.value || '',
            value_type: classifyValue(r.value).type,
            address: r.address || '',
            height: r.height != null ? r.height : 0,
            expires_in: r.expires_in != null ? r.expires_in : null,
            expired: r.expired ? 1 : 0,
            ismine: r.ismine ? 1 : 0,
            first_seen: r.height != null ? r.height : 0,
          });
        }
        records = records.concat(pageRecs);
        total += arr.length;
        cursor = arr[arr.length - 1].name;
        if (arr.length < pageSize) break;
        // brief pause to be nice to the node
        await new Promise((r) => setTimeout(r, 50));
      }
      const n = this.cache.syncFull(records);
      this.lastResult = { count: n, ms: Date.now() - t0, at: new Date().toISOString() };
      console.log(`[registry] synced ${n} names in ${Date.now() - t0}ms (${total} read)`);
      return this.lastResult;
    })();
    try { return await this.inFlight; }
    finally { this.inFlight = null; }
  }

  // Stats
  summary() {
    return {
      count: this.cache.count(),
      byNamespace: this.cache.countByNamespace(),
      lastSync: this.lastResult || this.cache.summary() || null,
      synchronizedAt: this._synchronizedAt,
    };
  }
}

module.exports = { RegistryService };