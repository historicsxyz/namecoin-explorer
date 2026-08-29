'use strict';

// SQLite store: current names + indexed name ops + headers.
// WAL, one writer (ingest). HTTP only reads. Never load the full registry into JS.
const { parseNamespace, expiresIn, NAME_EXPIRY_DEPTH, SEMI_EXPIRE_WINDOW } = require('./expiry');
const { classifyValue } = require('./names');
const { sampleHeights } = require('./chainmetrics');

function sqliteBackendError(nativeErr, builtinErr) {
  const err = new Error(
    'SQLite backend unavailable. better-sqlite3 failed to load (' + nativeErr.message + '). '
    + 'node:sqlite needs Node ≥ 22.5 (' + builtinErr.message + '). '
    + 'Rebuild the native module with the same Node binary the process uses: npm rebuild better-sqlite3'
  );
  err.cause = nativeErr;
  return err;
}

function openDb(dbPath) {
  let nativeErr;
  try {
    const Database = require('better-sqlite3');
    return new Database(dbPath);
  } catch (e) {
    nativeErr = e;
  }
  try {
    const { DatabaseSync } = require('node:sqlite');
    return wrapNodeSqlite(new DatabaseSync(dbPath));
  } catch (builtinErr) {
    throw sqliteBackendError(nativeErr, builtinErr);
  }
}

function wrapNodeSqlite(raw) {
  return {
    exec: (sql) => raw.exec(sql),
    pragma: (s) => raw.exec('PRAGMA ' + s),
    prepare: (sql) => {
      const converted = sql.replace(/@([A-Za-z_][A-Za-z0-9_]*)/g, '$$$1');
      const stmt = raw.prepare(converted);
      const mapArgs = (args) => {
        if (args.length === 1 && args[0] && typeof args[0] === 'object' && !Array.isArray(args[0])) {
          const o = {};
          for (const [k, v] of Object.entries(args[0])) o['$' + k.replace(/^[@$]/, '')] = v;
          return [o];
        }
        return args;
      };
      return {
        run: (...a) => stmt.run(...mapArgs(a)),
        get: (...a) => stmt.get(...mapArgs(a)),
        all: (...a) => stmt.all(...mapArgs(a)),
      };
    },
    transaction: (fn) => {
      const wrapped = (...args) => {
        raw.exec('BEGIN');
        try {
          const result = fn(...args);
          raw.exec('COMMIT');
          return result;
        } catch (err) {
          try { raw.exec('ROLLBACK'); } catch { /* ignore */ }
          throw err;
        }
      };
      return wrapped;
    },
    close: () => raw.close(),
  };
}

class NameCache {
  constructor(dbPath) {
    this.db = openDb(dbPath);
    // Both backends expose .pragma: better-sqlite3 natively, node:sqlite via
    // wrapNodeSqlite (raw.exec('PRAGMA …')). The typeof guard is therefore
    // equivalent to un-nesting; the hot-db pragmas below are standard SQLite.
    if (typeof this.db.pragma === 'function') {
      this.db.pragma('journal_mode = WAL');
      this.db.pragma('synchronous = NORMAL');
      this.db.pragma('busy_timeout = 5000');
      this.db.pragma('foreign_keys = ON');
      // hot-db tuning for 3+ GB cache: bigger page cache, mmap reads, rarer checkpoints
      this.db.pragma('cache_size = -393216');        // 384MB page cache (negative = KiB)
      this.db.pragma('mmap_size = 1073741824');      // 1GB memory-mapped I/O
      this.db.pragma('wal_autocheckpoint = 4000');   // ~16MB WAL before checkpoint (was 1000 = 4MB)
    }
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS names (
        name TEXT PRIMARY KEY,
        name_hex TEXT,
        namespace TEXT,
        value TEXT,
        value_type TEXT,
        address TEXT,
        height INTEGER,
        expires_in INTEGER,
        expired INTEGER,
        first_seen INTEGER,
        last_sync INTEGER,
        history_synced INTEGER DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS idx_names_height ON names(height);
      CREATE INDEX IF NOT EXISTS idx_names_expired ON names(expired);
      CREATE INDEX IF NOT EXISTS idx_names_namespace ON names(namespace);
      CREATE INDEX IF NOT EXISTS idx_names_address ON names(address);
      CREATE INDEX IF NOT EXISTS idx_names_expires_in ON names(expires_in);

      CREATE TABLE IF NOT EXISTS meta (
        key TEXT PRIMARY KEY,
        value TEXT
      );
      CREATE TABLE IF NOT EXISTS headers (
        height INTEGER PRIMARY KEY,
        hash TEXT NOT NULL,
        time INTEGER,
        prev TEXT,
        ntx INTEGER,
        merkle TEXT,
        difficulty REAL
      );
      CREATE TABLE IF NOT EXISTS name_ops (
        txid TEXT NOT NULL,
        vout INTEGER NOT NULL,
        height INTEGER,
        time INTEGER,
        op TEXT,
        name TEXT,
        name_hex TEXT,
        value TEXT,
        address TEXT,
        prev_address TEXT,
        PRIMARY KEY (txid, vout)
      );
      CREATE INDEX IF NOT EXISTS idx_ops_name ON name_ops(name);
      CREATE INDEX IF NOT EXISTS idx_ops_height ON name_ops(height DESC);
      CREATE INDEX IF NOT EXISTS idx_ops_op ON name_ops(op);
      CREATE INDEX IF NOT EXISTS idx_ops_address ON name_ops(address);
      CREATE INDEX IF NOT EXISTS idx_ops_prev_address ON name_ops(prev_address);
      CREATE INDEX IF NOT EXISTS idx_headers_hash ON headers(hash);
      CREATE TABLE IF NOT EXISTS ops_daily (
        day INTEGER PRIMARY KEY,
        n INTEGER NOT NULL DEFAULT 0
      );
    `);
    this._fts = this._initFts();
    this._migrate();
    this._prepare();
  }

  _initFts() {
    try {
      this.db.exec(`
        CREATE VIRTUAL TABLE IF NOT EXISTS names_fts USING fts5(
          name,
          content='names',
          content_rowid='rowid',
          tokenize='unicode61'
        );
        CREATE TRIGGER IF NOT EXISTS names_fts_ai AFTER INSERT ON names BEGIN
          INSERT INTO names_fts(rowid, name) VALUES (new.rowid, new.name);
        END;
        CREATE TRIGGER IF NOT EXISTS names_fts_ad AFTER DELETE ON names BEGIN
          INSERT INTO names_fts(names_fts, rowid, name) VALUES('delete', old.rowid, old.name);
        END;
        CREATE TRIGGER IF NOT EXISTS names_fts_au AFTER UPDATE OF name ON names BEGIN
          INSERT INTO names_fts(names_fts, rowid, name) VALUES('delete', old.rowid, old.name);
          INSERT INTO names_fts(rowid, name) VALUES (new.rowid, new.name);
        END;
      `);
      const n = this.db.prepare('SELECT COUNT(*) c FROM names').get().c;
      const f = this.db.prepare('SELECT COUNT(*) c FROM names_fts').get().c;
      if (n && !f) {
        this.db.exec("INSERT INTO names_fts(names_fts) VALUES('rebuild')");
      }
      return true;
    } catch (e) {
      console.error('[cache] FTS5 unavailable, using LIKE search:', e.message);
      return false;
    }
  }

  _migrate() {
    const nameCols = this.db.prepare('PRAGMA table_info(names)').all();
    if (nameCols.some((c) => c.name === 'ismine')) {
      try { this.db.exec('ALTER TABLE names DROP COLUMN ismine'); }
      catch { /* SQLite < 3.35: leave unused column */ }
    }
    const headerCols = this.db.prepare('PRAGMA table_info(headers)').all().map((c) => c.name);
    if (!headerCols.includes('ntx')) {
      try { this.db.exec('ALTER TABLE headers ADD COLUMN ntx INTEGER'); } catch { /* exists */ }
    }
    if (!headerCols.includes('merkle')) {
      try { this.db.exec('ALTER TABLE headers ADD COLUMN merkle TEXT'); } catch { /* exists */ }
    }
    if (!headerCols.includes('difficulty')) {
      try { this.db.exec('ALTER TABLE headers ADD COLUMN difficulty REAL'); } catch { /* exists */ }
    }
    if (!nameCols.some((c) => c.name === 'history_synced')) {
      try { this.db.exec('ALTER TABLE names ADD COLUMN history_synced INTEGER DEFAULT 0'); }
      catch { /* exists */ }
    }
    try { this.db.exec('CREATE INDEX IF NOT EXISTS idx_ops_address ON name_ops(address)'); } catch { /* exists */ }
    try { this.db.exec('CREATE INDEX IF NOT EXISTS idx_ops_prev_address ON name_ops(prev_address)'); } catch { /* exists */ }
    try { this.db.exec('CREATE INDEX IF NOT EXISTS idx_ops_time ON name_ops(time DESC)'); } catch { /* exists */ }
  }

  _prepare() {
    this._upsertName = this.db.prepare(`
      INSERT INTO names
        (name, name_hex, namespace, value, value_type, address, height, expires_in, expired, first_seen, last_sync)
      VALUES
        (@name, @name_hex, @namespace, @value, @value_type, @address, @height, @expires_in, @expired, @first_seen, @last_sync)
      ON CONFLICT(name) DO UPDATE SET
        name_hex = excluded.name_hex,
        namespace = excluded.namespace,
        value = excluded.value,
        value_type = excluded.value_type,
        address = excluded.address,
        height = excluded.height,
        expires_in = excluded.expires_in,
        expired = excluded.expired,
        first_seen = MIN(names.first_seen, excluded.first_seen),
        last_sync = excluded.last_sync
    `);
    this._insertHeader = this.db.prepare(`
      INSERT OR REPLACE INTO headers (height, hash, time, prev, ntx, merkle, difficulty)
      VALUES (@height, @hash, @time, @prev, @ntx, @merkle, @difficulty)
    `);
    this._insertOp = this.db.prepare(`
      INSERT OR REPLACE INTO name_ops
        (txid, vout, height, time, op, name, name_hex, value, address, prev_address)
      VALUES
        (@txid, @vout, @height, @time, @op, @name, @name_hex, @value, @address, @prev_address)
    `);
    this._upsertOpsDaily = this.db.prepare(`
      INSERT INTO ops_daily (day, n) VALUES (?, ?)
      ON CONFLICT(day) DO UPDATE SET n = n + excluded.n
    `);
    this._opsDailyReady = false;
  }

  metaGet(key) {
    const row = this.db.prepare('SELECT value FROM meta WHERE key=?').get(key);
    return row ? row.value : null;
  }

  metaSet(key, value) {
    this.db.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)').run(key, String(value));
  }

  getTip() {
    const height = this.metaGet('tip_height');
    const hash = this.metaGet('tip_hash');
    if (height == null) return null;
    return { height: Number(height), hash };
  }

  setTip(height, hash) {
    this.metaSet('tip_height', height);
    if (hash) this.metaSet('tip_hash', hash);
  }

  headerAt(height) {
    return this.db.prepare('SELECT * FROM headers WHERE height=?').get(height);
  }

  headerByHash(hash) {
    if (!hash) return null;
    return this.db.prepare('SELECT * FROM headers WHERE hash=?').get(String(hash).toLowerCase());
  }

  latestHeaders(limit = 20, offset = 0) {
    return this.pageHeaders({ limit, offset });
  }

  headerCount() {
    return this.countHeaders();
  }

  _headerFilter({ maxHeight = null, hashPrefix = null, ops = null, since = null } = {}) {
    let join = '';
    const where = [];
    const params = [];
    if (ops === 'with') {
      join = "INNER JOIN (SELECT DISTINCT height FROM name_ops WHERE op != 'NAME_NEW') _ops ON _ops.height = h.height";
    } else if (ops === 'busy') {
      join = 'INNER JOIN (SELECT height FROM name_ops WHERE op != \'NAME_NEW\' GROUP BY height HAVING COUNT(*) >= 10) _ops ON _ops.height = h.height';
    } else if (ops === 'NAME_NEW' || ops === 'NAME_FIRSTUPDATE' || ops === 'NAME_UPDATE') {
      join = 'INNER JOIN (SELECT DISTINCT height FROM name_ops WHERE op = ?) _ops ON _ops.height = h.height';
      params.push(ops);
    } else if (ops === 'none') {
      where.push("NOT EXISTS (SELECT 1 FROM name_ops o WHERE o.height = h.height AND o.op != 'NAME_NEW')");
    }
    if (maxHeight != null && Number.isFinite(Number(maxHeight))) {
      where.push('h.height <= ?');
      params.push(Math.floor(Number(maxHeight)));
    }
    if (hashPrefix) {
      where.push('h.hash LIKE ?');
      params.push(String(hashPrefix).toLowerCase() + '%');
    }
    if (since != null && Number.isFinite(Number(since))) {
      where.push('h.time >= ?');
      params.push(Math.floor(Number(since)));
    }
    const sql = (join ? join + ' ' : '') + (where.length ? 'WHERE ' + where.join(' AND ') : '');
    return { sql, params };
  }

  pageHeaders({ limit = 20, offset = 0, maxHeight = null, hashPrefix = null, ops = null, since = null } = {}) {
    const n = Math.max(0, Number(limit) || 0);
    const off = Math.max(0, Number(offset) || 0);
    const { sql, params } = this._headerFilter({ maxHeight, hashPrefix, ops, since });
    return this.db.prepare(
      `SELECT h.* FROM headers h ${sql} ORDER BY h.height DESC LIMIT ? OFFSET ?`
    ).all(...params, n, off);
  }

  countHeaders({ maxHeight = null, hashPrefix = null, ops = null, since = null } = {}) {
    const { sql, params } = this._headerFilter({ maxHeight, hashPrefix, ops, since });
    return this.db.prepare(`SELECT COUNT(*) AS c FROM headers h ${sql}`).get(...params).c;
  }

  headerExtent() {
    return this.db.prepare('SELECT MIN(height) minH, MAX(height) maxH FROM headers').get();
  }

  difficultySeries() {
    return this.db.prepare(
      'SELECT height, time, difficulty FROM headers WHERE difficulty IS NOT NULL AND difficulty > 0 ORDER BY height ASC'
    ).all();
  }

  difficultySparkSeries(limit = 48) {
    const n = Math.min(Math.max(Number(limit) || 48, 8), 120);
    const ext = this.db.prepare(
      'SELECT MIN(height) minH, MAX(height) maxH FROM headers WHERE difficulty IS NOT NULL AND difficulty > 0'
    ).get();
    if (!ext || ext.minH == null || ext.maxH == null) return [];
    const heights = sampleHeights(ext.minH, ext.maxH, n);
    if (!heights.length) return [];
    const ph = heights.map(() => '?').join(',');
    return this.db.prepare(
      `SELECT height, time, difficulty FROM headers
       WHERE height IN (${ph}) AND difficulty IS NOT NULL AND difficulty > 0
       ORDER BY height ASC`
    ).all(...heights);
  }

  setHeaderDifficulty(height, difficulty, time) {
    if (time != null) {
      this.db.prepare('UPDATE headers SET difficulty=?, time=COALESCE(time, ?) WHERE height=?')
        .run(difficulty, time, height);
    } else {
      this.db.prepare('UPDATE headers SET difficulty=? WHERE height=?').run(difficulty, height);
    }
  }

  opsPerDay(days = 90) {
    const n = Math.min(Math.max(Number(days) || 90, 7), 366);
    this._ensureOpsDaily();
    return this.db.prepare(
      'SELECT day, n FROM ops_daily WHERE n > 0 ORDER BY day DESC LIMIT ?'
    ).all(n).reverse();
  }

  _ensureOpsDaily() {
    if (this._opsDailyReady) return;
    if (this.metaGet('ops_daily_ok') === '1') {
      this._opsDailyReady = true;
      return;
    }
    this._rebuildOpsDaily();
    this._opsDailyReady = true;
  }

  _rebuildOpsDaily() {
    const ext = this.db.prepare(
      'SELECT MAX(time) AS t FROM name_ops WHERE time IS NOT NULL AND time > 0'
    ).get();
    const maxT = Number(ext && ext.t) || Math.floor(Date.now() / 1000);
    const since = Math.max(0, maxT - 400 * 86400);
    this.db.transaction(() => {
      this.db.exec('DELETE FROM ops_daily');
      this.db.prepare(`
        INSERT INTO ops_daily (day, n)
        SELECT CAST(time / 86400 AS INTEGER) AS day, COUNT(*) AS n
        FROM name_ops
        WHERE time >= ? AND op != 'NAME_NEW'
        GROUP BY day
      `).run(since);
      this.metaSet('ops_daily_ok', '1');
    })();
  }

  _bumpOpsDaily(time, ops) {
    if (time == null || Number(time) <= 0) return;
    let n = 0;
    for (const op of ops || []) {
      if (op && op.op && op.op !== 'NAME_NEW') n += 1;
    }
    if (!n) return;
    this._upsertOpsDaily.run(Math.floor(Number(time) / 86400), n);
  }

  _bumpOpsDailyRow(time, op) {
    if (!op || op.op === 'NAME_NEW') return;
    const t = time != null ? Number(time) : Number(op.time);
    if (!Number.isFinite(t) || t <= 0) return;
    this._upsertOpsDaily.run(Math.floor(t / 86400), 1);
  }

  deleteAbove(height) {
    this.db.transaction(() => {
      const rows = this.db.prepare(`
        SELECT CAST(time / 86400 AS INTEGER) AS day, COUNT(*) AS n
        FROM name_ops
        WHERE height > ? AND time IS NOT NULL AND time > 0 AND op != 'NAME_NEW'
        GROUP BY day
      `).all(height);
      const dec = this.db.prepare('UPDATE ops_daily SET n = n - ? WHERE day = ?');
      for (const r of rows) dec.run(r.n, r.day);
      this.db.prepare('DELETE FROM ops_daily WHERE n <= 0').run();
      this.db.prepare('DELETE FROM headers WHERE height > ?').run(height);
      this.db.prepare('DELETE FROM name_ops WHERE height > ?').run(height);
    })();
  }

  lastOpForName(name) {
    return this.db.prepare(
      'SELECT * FROM name_ops WHERE name=? AND op != ? ORDER BY height DESC, txid DESC LIMIT 1'
    ).get(name, 'NAME_NEW');
  }

  insertBlock({ header, ops, tipHeight }) {
    this.db.transaction(() => {
      this._insertHeader.run({
        height: header.height,
        hash: header.hash,
        time: header.time,
        prev: header.prev || '',
        ntx: header.ntx != null ? header.ntx : null,
        merkle: header.merkle || null,
        difficulty: header.difficulty != null ? Number(header.difficulty) : null,
      });
      for (const op of ops) {
        const prev = op.name ? this.lastOpForName(op.name) : null;
        const prevAddress = prev ? prev.address : null;
        this._insertOp.run({
          txid: op.txid,
          vout: op.vout,
          height: header.height,
          time: header.time,
          op: op.op,
          name: op.name || null,
          name_hex: op.nameHex || op.name_hex || null,
          value: op.value != null ? String(op.value) : null,
          address: op.address || '',
          prev_address: prevAddress,
        });
        if (op.name && (op.op === 'NAME_FIRSTUPDATE' || op.op === 'NAME_UPDATE')) {
          this._upsertName.run(this._nameRowFromOp(op, header.height, tipHeight, Date.now()));
        }
      }
      this._bumpOpsDaily(header.time, ops);
    })();
  }

  _nameRowFromOp(op, height, tipHeight, now) {
    const ns = parseNamespace(op.name);
    const exp = expiresIn(height, tipHeight);
    return {
      name: op.name,
      name_hex: op.nameHex || op.name_hex || null,
      namespace: ns.namespace,
      value: op.value != null ? String(op.value) : '',
      value_type: classifyValue(op.value).type,
      address: op.address || '',
      height,
      expires_in: exp,
      expired: exp != null && exp <= 0 ? 1 : 0,
      first_seen: height,
      last_sync: now,
    };
  }

  upsertNameRecord(r, tipHeight) {
    const ns = parseNamespace(r.name);
    const height = r.height || 0;
    const exp = r.expires_in != null ? r.expires_in : expiresIn(height, tipHeight);
    this._upsertName.run({
      name: r.name,
      name_hex: r.name_hex || r.nameHex || null,
      namespace: r.namespace || ns.namespace,
      value: typeof r.value === 'string' ? r.value : JSON.stringify(r.value || ''),
      value_type: r.value_type || r.valueType || classifyValue(r.value).type,
      address: r.address || '',
      height,
      expires_in: exp,
      expired: r.expired ? 1 : (exp != null && exp <= 0 ? 1 : 0),
      first_seen: r.first_seen || height,
      last_sync: Date.now(),
    });
  }

  upsertNameRecords(records, tipHeight) {
    this.db.transaction(() => {
      for (const r of records) this.upsertNameRecord(r, tipHeight);
    })();
  }

  deleteNamesNotSyncedSince(ts) {
    return this.db.prepare('DELETE FROM names WHERE last_sync < ?').run(ts).changes;
  }

  _tipHeight() {
    const tip = this.getTip();
    return tip && Number.isFinite(tip.height) ? tip.height : null;
  }

  _paintExpiry(row) {
    if (!row) return row;
    const tip = this._tipHeight();
    if (tip == null) return row;
    const exp = expiresIn(row.height, tip);
    row.expires_in = exp;
    row.expired = exp != null && exp <= 0 ? 1 : 0;
    return row;
  }

  distinctOpNames() {
    return this.db.prepare(
      'SELECT DISTINCT name FROM name_ops WHERE name IS NOT NULL'
    ).all();
  }

  rebuildName(name, tipHeight) {
    const last = this.lastOpForName(name);
    if (!last) return;
    this._upsertName.run(this._nameRowFromOp({
      name: last.name,
      nameHex: last.name_hex,
      value: last.value,
      address: last.address,
      op: last.op,
    }, last.height, tipHeight, Date.now()));
  }

  insertNameOps(ops) {
    this.db.transaction(() => {
      for (const op of ops) {
        this._insertOp.run(op);
        this._bumpOpsDailyRow(op.time, op);
      }
    })();
  }

  opsForName(name) {
    return this.db.prepare(
      'SELECT * FROM name_ops WHERE name=? ORDER BY height ASC, txid ASC'
    ).all(name);
  }

  isHistorySynced(name) {
    const row = this.db.prepare('SELECT history_synced FROM names WHERE name=?').get(name);
    if (row && Number(row.history_synced) === 1) return true;
    return this.metaGet('hist_sync:' + name) === '1';
  }

  markHistorySynced(name) {
    const upd = this.db.prepare('UPDATE names SET history_synced=1 WHERE name=?').run(name);
    if (!upd.changes) this.metaSet('hist_sync:' + name, '1');
  }

  opsAtHeight(height, { hideCommitments = true } = {}) {
    if (hideCommitments) {
      return this.db.prepare(
        "SELECT * FROM name_ops WHERE height=? AND op != 'NAME_NEW' ORDER BY txid ASC, vout ASC"
      ).all(height);
    }
    return this.db.prepare(
      'SELECT * FROM name_ops WHERE height=? ORDER BY txid ASC, vout ASC'
    ).all(height);
  }

  opCountsByHeight(heights, { hideCommitments = true } = {}) {
    const out = new Map();
    const uniq = [...new Set((heights || []).map((h) => Number(h)).filter((h) => Number.isFinite(h)))];
    if (!uniq.length) return out;
    const ph = uniq.map(() => '?').join(',');
    const sql = hideCommitments
      ? `SELECT height, COUNT(*) AS c FROM name_ops WHERE height IN (${ph}) AND op != 'NAME_NEW' GROUP BY height`
      : `SELECT height, COUNT(*) AS c FROM name_ops WHERE height IN (${ph}) GROUP BY height`;
    for (const row of this.db.prepare(sql).all(...uniq)) {
      out.set(Number(row.height), Number(row.c));
    }
    return out;
  }

  recentOps({ op = null, limit = 50, offset = 0, hideCommitments = true } = {}) {
    const n = Math.max(0, Number(limit) || 0);
    const off = Math.max(0, Number(offset) || 0);
    if (op) {
      return this.db.prepare(
        'SELECT * FROM name_ops WHERE op=? ORDER BY height DESC, txid DESC, vout DESC LIMIT ? OFFSET ?'
      ).all(op, n, off);
    }
    if (hideCommitments) {
      return this.db.prepare(
        "SELECT * FROM name_ops WHERE op != 'NAME_NEW' ORDER BY height DESC, txid DESC, vout DESC LIMIT ? OFFSET ?"
      ).all(n, off);
    }
    return this.db.prepare(
      'SELECT * FROM name_ops ORDER BY height DESC, txid DESC, vout DESC LIMIT ? OFFSET ?'
    ).all(n, off);
  }

  countRecentOps({ op = null, hideCommitments = true } = {}) {
    if (op) {
      return this.db.prepare('SELECT COUNT(*) AS c FROM name_ops WHERE op=?').get(op).c;
    }
    if (hideCommitments) {
      return this.db.prepare("SELECT COUNT(*) AS c FROM name_ops WHERE op != 'NAME_NEW'").get().c;
    }
    return this.db.prepare('SELECT COUNT(*) AS c FROM name_ops').get().c;
  }

  recentNameOpTxs({
    minOps = 1,
    since = null,
    until = null,
    op = null,
    limit = 40,
    offset = 0,
    hideCommitments = true,
  } = {}) {
    const n = Math.min(Math.max(Number(limit) || 40, 1), 100);
    const off = Math.max(0, Number(offset) || 0);
    const min = Math.max(1, Math.floor(Number(minOps) || 1));
    const where = [];
    const params = [];
    if (op) {
      where.push('op = ?');
      params.push(op);
    } else if (hideCommitments) {
      where.push("op != 'NAME_NEW'");
    }
    if (since != null && Number.isFinite(Number(since))) {
      where.push('time >= ?');
      params.push(Math.floor(Number(since)));
    }
    if (until != null && Number.isFinite(Number(until))) {
      where.push('time <= ?');
      params.push(Math.floor(Number(until)));
    }
    const whereSql = where.length ? 'WHERE ' + where.join(' AND ') : '';
    return this.db.prepare(`
      SELECT txid, MAX(height) AS height, MAX(time) AS time, COUNT(*) AS nameOps
      FROM name_ops
      ${whereSql}
      GROUP BY txid
      HAVING COUNT(*) >= ?
      ORDER BY height DESC, txid DESC
      LIMIT ? OFFSET ?
    `).all(...params, min, n, off);
  }

  count() { return this.db.prepare('SELECT COUNT(*) c FROM names').get().c; }

  countByNamespace() {
    const tip = this._tipHeight();
    if (tip == null) {
      return this.db.prepare(`
        SELECT namespace, COUNT(*) total,
               SUM(CASE WHEN expired THEN 1 ELSE 0 END) expired,
               SUM(CASE WHEN NOT expired THEN 1 ELSE 0 END) live
        FROM names GROUP BY namespace ORDER BY total DESC
      `).all();
    }
    const liveMin = tip - NAME_EXPIRY_DEPTH;
    return this.db.prepare(`
      SELECT namespace, COUNT(*) total,
             SUM(CASE WHEN height <= ? THEN 1 ELSE 0 END) expired,
             SUM(CASE WHEN height > ? THEN 1 ELSE 0 END) live
      FROM names GROUP BY namespace ORDER BY total DESC
    `).all(liveMin, liveMin);
  }

  topAddresses(limit = 25) {
    const n = Math.min(Math.max(Number(limit) || 25, 5), 100);
    return this.pageAddresses({ limit: n, offset: 0 });
  }

  pageAddresses({ limit = 20, offset = 0 } = {}) {
    const n = Math.min(Math.max(Number(limit) || 20, 1), 100);
    const off = Math.max(0, Number(offset) || 0);
    const tip = this._tipHeight();
    if (tip == null) {
      return this.db.prepare(`
        SELECT address, COUNT(*) total,
               SUM(CASE WHEN NOT expired THEN 1 ELSE 0 END) live,
               SUM(CASE WHEN expired THEN 1 ELSE 0 END) expired
        FROM names
        WHERE address IS NOT NULL AND TRIM(address) != ''
        GROUP BY address
        ORDER BY live DESC, total DESC, address ASC
        LIMIT ? OFFSET ?
      `).all(n, off);
    }
    const liveMin = tip - NAME_EXPIRY_DEPTH;
    return this.db.prepare(`
      SELECT address, COUNT(*) total,
             SUM(CASE WHEN height > ? THEN 1 ELSE 0 END) live,
             SUM(CASE WHEN height <= ? THEN 1 ELSE 0 END) expired
      FROM names
      WHERE address IS NOT NULL AND TRIM(address) != ''
      GROUP BY address
      ORDER BY live DESC, total DESC, address ASC
      LIMIT ? OFFSET ?
    `).all(liveMin, liveMin, n, off);
  }

  countAddresses() {
    return this.db.prepare(`
      SELECT COUNT(*) c FROM (
        SELECT DISTINCT address FROM names
        WHERE address IS NOT NULL AND TRIM(address) != ''
      )
    `).get().c;
  }

  namesByAddress(addr, { limit = 100, offset = 0 } = {}) {
    const a = String(addr || '').trim();
    if (!a) return [];
    const n = Math.min(Math.max(Number(limit) || 100, 1), 500);
    const off = Math.max(0, Number(offset) || 0);
    return this.db.prepare(
      'SELECT * FROM names WHERE address=? ORDER BY name ASC LIMIT ? OFFSET ?'
    ).all(a, n, off).map((r) => this._paintExpiry(r));
  }

  opsByAddress(addr, { limit = 50, offset = 0 } = {}) {
    const a = String(addr || '').trim();
    if (!a) return [];
    const n = Math.min(Math.max(Number(limit) || 50, 1), 200);
    const off = Math.max(0, Number(offset) || 0);
    return this.db.prepare(`
      SELECT * FROM name_ops
      WHERE address=? OR prev_address=?
      ORDER BY height DESC, txid DESC, vout DESC
      LIMIT ? OFFSET ?
    `).all(a, a, n, off);
  }

  addressSeen(addr) {
    const a = String(addr || '').trim();
    if (!a) return false;
    if (this.db.prepare(
      "SELECT 1 AS x FROM names WHERE address=? LIMIT 1"
    ).get(a)) return true;
    return !!this.db.prepare(
      'SELECT 1 AS x FROM name_ops WHERE address=? OR prev_address=? LIMIT 1'
    ).get(a, a);
  }

  txidSeen(txid) {
    const id = String(txid || '').trim();
    if (!id) return false;
    return !!this.db.prepare(
      'SELECT 1 AS x FROM name_ops WHERE txid=? OR txid=? LIMIT 1'
    ).get(id, id.toLowerCase());
  }

  opsForTxids(txids) {
    const out = Object.create(null);
    const uniq = [];
    const seen = new Set();
    for (const raw of txids || []) {
      const id = String(raw || '').trim();
      if (!id) continue;
      for (const key of [id, id.toLowerCase()]) {
        if (seen.has(key)) continue;
        seen.add(key);
        uniq.push(key);
      }
    }
    const chunkSize = 400;
    for (let i = 0; i < uniq.length; i += chunkSize) {
      const chunk = uniq.slice(i, i + chunkSize);
      const ph = chunk.map(() => '?').join(',');
      const rows = this.db.prepare(
        `SELECT * FROM name_ops WHERE txid IN (${ph}) ORDER BY vout ASC`
      ).all(...chunk);
      for (const row of rows) {
        const k = String(row.txid || '').toLowerCase();
        if (!out[k]) out[k] = [];
        out[k].push(row);
      }
    }
    return out;
  }

  recent(limit = 25, { expired } = {}) {
    const tip = this._tipHeight();
    let q = 'SELECT * FROM names';
    const params = [];
    if (tip != null) {
      const liveMin = tip - NAME_EXPIRY_DEPTH;
      if (expired === true) { q += ' WHERE height <= ?'; params.push(liveMin); }
      else if (expired === false) { q += ' WHERE height > ?'; params.push(liveMin); }
    } else if (expired === true) q += ' WHERE expired=1';
    else if (expired === false) q += ' WHERE NOT expired';
    q += ' ORDER BY height DESC LIMIT ?';
    params.push(limit);
    return this.db.prepare(q).all(...params).map((r) => this._paintExpiry(r));
  }

  expiringSoon(limit = 25) {
    const tip = this._tipHeight();
    if (tip == null) {
      return this.db.prepare(`
        SELECT * FROM names
        WHERE NOT expired AND expires_in IS NOT NULL AND expires_in <= ?
        ORDER BY expires_in ASC LIMIT ?
      `).all(SEMI_EXPIRE_WINDOW, limit).map((r) => this._paintExpiry(r));
    }
    const liveMin = tip - NAME_EXPIRY_DEPTH;
    return this.db.prepare(`
      SELECT * FROM names
      WHERE height > ? AND height <= ?
      ORDER BY height ASC LIMIT ?
    `).all(liveMin, liveMin + SEMI_EXPIRE_WINDOW, limit).map((r) => this._paintExpiry(r));
  }

  page({ start = '', limit = 100, ns = null, status = null } = {}) {
    const where = [];
    const params = [];
    const tip = this._tipHeight();
    const liveMin = tip != null ? tip - NAME_EXPIRY_DEPTH : null;
    if (ns) { where.push('namespace=?'); params.push(ns.endsWith('/') ? ns : ns + '/'); }
    if (tip != null) {
      if (status === 'live') { where.push('height > ?'); params.push(liveMin); }
      else if (status === 'expired') { where.push('height <= ?'); params.push(liveMin); }
      else if (status === 'expiring') {
        where.push('height > ? AND height <= ?');
        params.push(liveMin, liveMin + SEMI_EXPIRE_WINDOW);
      }
    } else if (status === 'live') { where.push('NOT expired'); }
    else if (status === 'expired') { where.push('expired=1'); }
    else if (status === 'expiring') {
      where.push('NOT expired AND expires_in IS NOT NULL AND expires_in <= ?');
      params.push(SEMI_EXPIRE_WINDOW);
    }
    let q = 'SELECT * FROM names';
    if (where.length) q += ' WHERE ' + where.join(' AND ');
    if (start) { q += (where.length ? ' AND ' : ' WHERE ') + 'name > ?'; params.push(start); }
    q += ' ORDER BY name ASC LIMIT ?';
    params.push(limit);
    return this.db.prepare(q).all(...params).map((r) => this._paintExpiry(r));
  }

  get(name) {
    return this._paintExpiry(this.db.prepare('SELECT * FROM names WHERE name=?').get(name));
  }

  search(term, limit = 30) {
    const q = String(term || '').trim();
    if (!q) return [];
    let rows;
    if (this._fts) {
      try {
        const prefix = q.replace(/["'*]/g, ' ') + '*';
        rows = this.db.prepare(`
          SELECT n.* FROM names n
          JOIN names_fts f ON n.rowid = f.rowid
          WHERE names_fts MATCH ?
          ORDER BY length(n.name) ASC, n.name ASC
          LIMIT ?
        `).all(prefix, limit);
        if (rows.length) return rows.map((r) => this._paintExpiry(r));
      } catch { /* fall through to LIKE */ }
    }
    return this.db.prepare(`
      SELECT * FROM names WHERE name LIKE ? ORDER BY length(name) ASC, name ASC LIMIT ?
    `).all('%' + q + '%', limit).map((r) => this._paintExpiry(r));
  }

  close() { this.db.close(); }
}

module.exports = { NameCache, sqliteBackendError };
