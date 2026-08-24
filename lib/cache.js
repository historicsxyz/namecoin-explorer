'use strict';

// SQLite store: current names + indexed name ops + headers.
// WAL, one writer (ingest). HTTP only reads. Never load the full registry into JS.
const { parseNamespace, expiresIn, NAME_EXPIRY_DEPTH, SEMI_EXPIRE_WINDOW } = require('./expiry');
const { classifyValue } = require('./names');

function openDb(dbPath) {
  try {
    const Database = require('better-sqlite3');
    return new Database(dbPath);
  } catch (e) {
    const { DatabaseSync } = require('node:sqlite');
    return wrapNodeSqlite(new DatabaseSync(dbPath));
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
    if (typeof this.db.pragma === 'function') {
      this.db.pragma('journal_mode = WAL');
      this.db.pragma('synchronous = NORMAL');
      this.db.pragma('busy_timeout = 5000');
      this.db.pragma('foreign_keys = ON');
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
        merkle TEXT
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
    if (!nameCols.some((c) => c.name === 'history_synced')) {
      try { this.db.exec('ALTER TABLE names ADD COLUMN history_synced INTEGER DEFAULT 0'); }
      catch { /* exists */ }
    }
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
      INSERT OR REPLACE INTO headers (height, hash, time, prev, ntx, merkle)
      VALUES (@height, @hash, @time, @prev, @ntx, @merkle)
    `);
    this._insertOp = this.db.prepare(`
      INSERT OR REPLACE INTO name_ops
        (txid, vout, height, time, op, name, name_hex, value, address, prev_address)
      VALUES
        (@txid, @vout, @height, @time, @op, @name, @name_hex, @value, @address, @prev_address)
    `);
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

  latestHeaders(limit = 15) {
    return this.db.prepare('SELECT * FROM headers ORDER BY height DESC LIMIT ?').all(limit);
  }

  deleteAbove(height) {
    this.db.prepare('DELETE FROM headers WHERE height > ?').run(height);
    this.db.prepare('DELETE FROM name_ops WHERE height > ?').run(height);
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
      for (const op of ops) this._insertOp.run(op);
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

  recentOps({ op = null, limit = 50, hideCommitments = true } = {}) {
    if (op) {
      return this.db.prepare(
        'SELECT * FROM name_ops WHERE op=? ORDER BY height DESC, txid DESC LIMIT ?'
      ).all(op, limit);
    }
    if (hideCommitments) {
      return this.db.prepare(
        "SELECT * FROM name_ops WHERE op != 'NAME_NEW' ORDER BY height DESC, txid DESC LIMIT ?"
      ).all(limit);
    }
    return this.db.prepare(
      'SELECT * FROM name_ops ORDER BY height DESC, txid DESC LIMIT ?'
    ).all(limit);
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

module.exports = { NameCache };
