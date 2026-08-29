'use strict';

// In-process TTL LRU. No deps. Optional stale-while-revalidate via getOrLoad.

class TtlCache {
  constructor({ max = 256, ttlMs = 15000, swrMs = 45000 } = {}) {
    this.max = Math.max(1, Number(max) || 256);
    this.ttlMs = Math.max(0, Number(ttlMs) || 0);
    this.swrMs = Math.max(0, Number(swrMs) || 0);
    this.map = new Map();
    this._inflight = new Map();
  }

  get size() { return this.map.size; }

  get(key) {
    const e = this.map.get(key);
    if (!e) return { hit: false, stale: false, value: undefined };
    const age = Date.now() - e.at;
    if (age <= this.ttlMs) {
      this._touch(key, e);
      return { hit: true, stale: false, value: e.value };
    }
    if (age <= this.ttlMs + this.swrMs) {
      this._touch(key, e);
      return { hit: true, stale: true, value: e.value };
    }
    this.map.delete(key);
    return { hit: false, stale: false, value: undefined };
  }

  set(key, value) {
    if (this.map.has(key)) this.map.delete(key);
    this.map.set(key, { value, at: Date.now(), refreshing: false });
    while (this.map.size > this.max) {
      const oldest = this.map.keys().next().value;
      this.map.delete(oldest);
    }
  }

  async getOrLoad(key, loader) {
    const g = this.get(key);
    if (g.hit && !g.stale) return g.value;
    const inflight = this._inflight.get(key);
    if (g.hit && g.stale) {
      if (!inflight) this._refresh(key, loader);
      return g.value;
    }
    if (inflight) return inflight;
    return this._refresh(key, loader);
  }

  // Manual inflight slot for attachHtmlCache: one Express render, N waiters.
  shareLoad(key) {
    const existing = this._inflight.get(key);
    if (existing) return { leader: false, promise: existing };
    let resolve;
    const p = new Promise((r) => { resolve = r; });
    this._inflight.set(key, p);
    let settled = false;
    return {
      leader: true,
      promise: p,
      finish: (value) => {
        if (settled) return;
        settled = true;
        if (this._inflight.get(key) === p) {
          this._inflight.delete(key);
          if (value) this.set(key, value);
        }
        resolve(value || null);
      },
    };
  }

  invalidate(prefix) {
    if (prefix == null || prefix === '') {
      this.map.clear();
      this._inflight.clear();
      return;
    }
    const p = String(prefix);
    for (const k of [...this.map.keys()]) {
      if (k === p || k.startsWith(p)) this.map.delete(k);
    }
    for (const k of [...this._inflight.keys()]) {
      if (k === p || k.startsWith(p)) this._inflight.delete(k);
    }
  }

  clear() {
    this.map.clear();
    this._inflight.clear();
  }

  _touch(key, entry) {
    this.map.delete(key);
    this.map.set(key, entry);
  }

  _refresh(key, loader) {
    const p = Promise.resolve()
      .then(loader)
      .then((v) => {
        if (this._inflight.get(key) === p) this.set(key, v);
        return v;
      })
      .finally(() => {
        if (this._inflight.get(key) === p) this._inflight.delete(key);
      });
    this._inflight.set(key, p);
    return p;
  }
}

function weakEtag(body) {
  const crypto = require('crypto');
  const buf = Buffer.isBuffer(body) ? body : Buffer.from(String(body));
  return 'W/"' + crypto.createHash('sha1').update(buf).digest('hex').slice(0, 20) + '"';
}

module.exports = { TtlCache, weakEtag };
