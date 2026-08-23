'use strict';

// Block-follow indexer. Fills SQLite from namecoind.
// Catch-up + reorg, once-off paged name_scan bootstrap, optional 36k rewind,
// lazy name_history backfill per name. Optional hashblock ZMQ (10s poll remains).
const { nameOpsFromTx } = require('./txops');
const { hexToName, nameToHex } = require('./rpc');
const { NAME_EXPIRY_DEPTH } = require('./expiry');
const { classifyValue } = require('./names');

const SCAN_PAGE = 500;
const POLL_MS = 10000;
const SCAN_PAUSE_MS = 50;

function ingestOptionsFromEnv(env = process.env) {
  const raw = env.NMC_INGEST_FROM;
  const fromGenesis = raw === '0' || String(raw || '').toLowerCase() === 'genesis';
  const zmqUrl = String(env.NMC_ZMQ_HASHBLOCK || '').trim() || null;
  return {
    fromGenesis,
    rewindBlocks: fromGenesis ? Number.MAX_SAFE_INTEGER : NAME_EXPIRY_DEPTH,
    zmqUrl,
  };
}

class IngestService {
  constructor(rpc, cache, {
    rewindBlocks = NAME_EXPIRY_DEPTH,
    fromGenesis = false,
    zmqUrl = null,
  } = {}) {
    this.rpc = rpc;
    this.cache = cache;
    this.fromGenesis = !!fromGenesis;
    this.rewindBlocks = this.fromGenesis ? Number.MAX_SAFE_INTEGER : rewindBlocks;
    this.zmqUrl = zmqUrl || null;
    this.lastResult = null;
    this.catchingUp = false;
    this._timer = null;
    this._running = false;
    this._tickPromise = null;
    this._zmq = null;
  }

  start() {
    if (this._running) return;
    if (this.zmqUrl) this._startZmq();
    this._running = true;
    this._loop().catch((e) => console.error('[ingest]', e.message));
  }

  stop() {
    this._running = false;
    if (this._timer) clearTimeout(this._timer);
    this._closeZmq();
  }

  isCatchingUp() { return this.catchingUp; }

  async _loop() {
    while (this._running) {
      try {
        await this.tick();
      } catch (e) {
        console.error('[ingest] tick error:', e.message);
      }
      await this._sleep(POLL_MS);
    }
  }

  tick() {
    if (this._tickPromise) return this._tickPromise;
    this._tickPromise = this._doTick().finally(() => { this._tickPromise = null; });
    return this._tickPromise;
  }

  async _doTick() {
    let info;
    try {
      info = await this.rpc.call('getblockchaininfo');
    } catch (e) {
      this.lastResult = { error: e.message, at: new Date().toISOString() };
      return;
    }
    const chainTip = info.blocks || 0;
    this.cache.metaSet('chain', info.chain || 'main');
    this.cache.metaSet('headers', info.headers || chainTip);
    this.cache.metaSet('ibd', info.initialblockdownload ? '1' : '0');

    const stored = this.cache.getTip();
    let startHeight;
    if (!stored) {
      startHeight = this.fromGenesis ? 0 : Math.max(0, chainTip - this.rewindBlocks);
      if (this.fromGenesis) {
        console.log(`[ingest] first run from genesis (height 0 → tip ${chainTip}); needs txindex=1; one writer only`);
      } else {
        console.log(`[ingest] first run: rewind from ${startHeight} (tip ${chainTip})`);
      }
    } else {
      startHeight = stored.height + 1;
      if (stored.height > 0) {
        await this._handleReorg(stored, chainTip);
        const after = this.cache.getTip();
        startHeight = after ? after.height + 1 : startHeight;
      }
    }

    this.catchingUp = startHeight <= chainTip;
    this.lastResult = {
      height: stored ? stored.height : Math.max(0, startHeight - 1),
      tip: chainTip,
      catchingUp: this.catchingUp,
      at: new Date().toISOString(),
    };
    for (let h = startHeight; h <= chainTip && this._running; h++) {
      await this._ingestHeight(h, chainTip);
      this.lastResult = {
        height: h,
        tip: chainTip,
        catchingUp: h < chainTip,
        at: new Date().toISOString(),
      };
      if (h % 500 === 0 || h === chainTip) {
        console.log(`[ingest] height ${h}/${chainTip}`);
      }
    }
    this.catchingUp = false;

    if (!this.cache.metaGet('bootstrap_done')) {
      await this._bootstrapScan(chainTip);
    }

    this.cache.refreshExpiry(chainTip);
    this.lastResult = {
      height: chainTip,
      tip: chainTip,
      catchingUp: false,
      at: new Date().toISOString(),
    };
  }

  _startZmq() {
    const url = this.zmqUrl;
    if (!/^(tcp|ipc):\/\//i.test(url)) {
      throw new Error(`NMC_ZMQ_HASHBLOCK must be a tcp:// or ipc:// URL, got ${url}`);
    }
    let zmq;
    try {
      zmq = require('zeromq');
    } catch (e) {
      throw new Error(
        `NMC_ZMQ_HASHBLOCK is set (${url}) but the zeromq package is not installed. Run: npm install zeromq`
      );
    }
    try {
      if (typeof zmq.Subscriber === 'function') {
        const sock = new zmq.Subscriber();
        sock.connect(url);
        sock.subscribe('hashblock');
        this._zmq = sock;
        console.log('[ingest] ZMQ hashblock subscribed at', url);
        this._zmqLoopV6(sock);
        return;
      }
      if (typeof zmq.socket === 'function') {
        const sock = zmq.socket('sub');
        sock.connect(url);
        sock.subscribe('hashblock');
        sock.on('message', () => {
          if (!this._running) return;
          this.tick().catch((e) => console.error('[ingest] zmq tick:', e.message));
        });
        this._zmq = sock;
        console.log('[ingest] ZMQ hashblock subscribed at', url);
        return;
      }
    } catch (e) {
      this._closeZmq();
      throw new Error(`NMC_ZMQ_HASHBLOCK failed to connect to ${url}: ${e.message}`);
    }
    throw new Error('NMC_ZMQ_HASHBLOCK is set but this zeromq build has no Subscriber/socket API');
  }

  _zmqLoopV6(sock) {
    (async () => {
      try {
        for await (const _msg of sock) {
          if (!this._running) break;
          this.tick().catch((e) => console.error('[ingest] zmq tick:', e.message));
        }
      } catch (e) {
        if (this._running) {
          console.error('[ingest] ZMQ subscriber error:', e.message);
          this.lastResult = { error: 'zmq: ' + e.message, at: new Date().toISOString() };
        }
      }
    })();
  }

  _closeZmq() {
    if (!this._zmq) return;
    try {
      if (typeof this._zmq.close === 'function') this._zmq.close();
    } catch { /* already closed */ }
    this._zmq = null;
  }

  async _handleReorg(stored, chainTip) {
    if (!stored.hash) return;
    let height = stored.height;
    try {
      const hash = await this.rpc.call('getblockhash', [height]);
      if (hash === stored.hash) return;
    } catch {
      return;
    }
    console.log('[ingest] reorg detected at', height);
    while (height > 0) {
      height--;
      const local = this.cache.headerAt(height);
      if (!local) break;
      try {
        const hash = await this.rpc.call('getblockhash', [height]);
        if (hash === local.hash) {
          this.cache.deleteAbove(height);
          for (const row of this.cache.distinctOpNames()) {
            this.cache.rebuildName(row.name, chainTip);
          }
          this.cache.setTip(height, local.hash);
          console.log('[ingest] reorg settled at', height);
          return;
        }
      } catch {
        break;
      }
    }
  }

  async _ingestHeight(height, chainTip) {
    const hash = await this.rpc.call('getblockhash', [height]);
    const block = await this.rpc.call('getblock', [hash, 2]);
    const ops = [];
    for (const tx of block.tx || []) {
      for (const o of nameOpsFromTx(tx)) {
        ops.push({
          txid: tx.txid,
          vout: o.vout,
          op: o.op,
          name: o.name || null,
          nameHex: o.nameHex || (o.name ? Buffer.from(o.name, 'utf8').toString('hex') : null),
          value: o.value,
          address: o.address || '',
        });
      }
    }
    this.cache.insertBlock({
      header: {
        height,
        hash: block.hash,
        time: block.time || 0,
        prev: block.previousblockhash || '',
        ntx: block.nTx != null ? block.nTx : (block.tx || []).length,
        merkle: block.merkleroot || '',
      },
      ops,
      tipHeight: chainTip,
    });
    this.cache.setTip(height, block.hash);
  }

  async _bootstrapScan(tipHeight) {
    console.log('[ingest] name_scan bootstrap (500/page)…');
    const passStarted = Date.now();
    let cursor = '';
    let total = 0;
    // eslint-disable-next-line no-constant-condition
    while (true) {
      let arr;
      try {
        arr = await this.rpc.nameScan(cursor, SCAN_PAGE);
      } catch (e) {
        console.error('[ingest] name_scan failed:', e.message);
        break;
      }
      if (!arr || arr.length === 0) break;
      const recs = [];
      for (const r of arr) {
        const rec = scanRowToRecord(r);
        if (rec && rec.name) recs.push(rec);
      }
      this.cache.upsertNameRecords(recs, tipHeight);
      total += recs.length;
      const last = arr[arr.length - 1];
      cursor = scanRowName(last);
      if (arr.length < SCAN_PAGE) break;
      await this._sleep(SCAN_PAUSE_MS);
    }
    this.cache.deleteNamesNotSyncedSince(passStarted);
    this.cache.metaSet('bootstrap_done', '1');
    this.cache.refreshExpiry(tipHeight);
    console.log(`[ingest] name_scan bootstrap stored ${total} names`);
  }

  async backfillName(name) {
    let history;
    try {
      history = await this.rpc.nameHistory(name);
    } catch (e) {
      return null;
    }
    if (!Array.isArray(history)) return null;
    if (history.length === 0) {
      this.cache.markHistorySynced(name);
      return this.cache.opsForName(name);
    }
    const existing = new Set(
      this.cache.opsForName(name).map((o) => o.txid + ':' + o.vout)
    );
    const rows = [];
    for (const h of history) {
      if (!h || !h.txid) continue;
      try {
        const tx = await this.rpc.call('getrawtransaction', [h.txid, true]);
        const ops = nameOpsFromTx(tx);
        const match = ops.find((o) => o.name === name) || ops[0];
        if (!match) continue;
        const key = h.txid + ':' + match.vout;
        if (existing.has(key)) continue;
        let time = null;
        if (h.height) {
          try {
            const bh = await this.rpc.call('getblockhash', [h.height]);
            const hdr = await this.rpc.call('getblockheader', [bh, true]);
            time = hdr && hdr.time ? hdr.time : null;
          } catch { /* header missing */ }
        }
        rows.push({
          txid: h.txid,
          vout: match.vout,
          height: h.height || null,
          time,
          op: match.op,
          name,
          name_hex: match.nameHex || nameToHex(name),
          value: match.value != null ? String(match.value) : (h.value != null ? String(h.value) : null),
          address: match.address || h.address || '',
          prev_address: null,
        });
      } catch { /* pruned / no txindex */ }
    }
    if (rows.length) this.cache.insertNameOps(rows);
    const stored = this.cache.opsForName(name);
    const have = new Set(stored.map((o) => o.txid));
    const complete = history.every((h) => !h || !h.txid || have.has(h.txid));
    if (complete) this.cache.markHistorySynced(name);
    return stored;
  }

  _sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
}

function scanRowName(r) {
  if (!r) return '';
  return r.name || '';
}

function scanRowToRecord(r) {
  if (!r || !r.name) return null;
  return {
    name: r.name,
    name_hex: r.name_hex || nameToHex(r.name),
    value: r.value || '',
    address: r.address || '',
    height: r.height != null ? r.height : 0,
    expires_in: r.expires_in != null ? r.expires_in : null,
    expired: r.expired ? 1 : 0,
    first_seen: r.height != null ? r.height : 0,
    value_type: classifyValue(r.value).type,
  };
}

module.exports = { IngestService, ingestOptionsFromEnv };
