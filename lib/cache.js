'use strict';

// SQLite-backed cache for expensive registry-wide scans and statistics.
// The RPC registry (name_scan) can dump thousands of rows; we page it once
// and index in SQLite for fast filtering/counting on every UI request.
const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

class NameCache {
  constructor(dbPath) {
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
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
        ismine INTEGER,
        first_seen INTEGER,
        last_sync INTEGER
      );
      CREATE INDEX IF NOT EXISTS idx_names_height ON names(height);
      CREATE INDEX IF NOT EXISTS idx_names_expired ON names(expired);
      CREATE INDEX IF NOT EXISTS idx_names_namespace ON names(namespace);
      CREATE INDEX IF NOT EXISTS idx_names_address ON names(address);
    `);
    this._synchronizedAt = null;
  }

  // Replace the whole registry snapshot (called on a registry sync).
  syncFull(records) {
    const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO names
        (name, name_hex, namespace, value, value_type, address, height, expires_in, expired, ismine, first_seen, last_sync)
      VALUES (@name, @name_hex, @namespace, @value, @value_type, @address, @height, @expires_in, @expired, @ismine, @first_seen, @last_sync)
    `);
    const now = Date.now();
    this.db.transaction(() => {
      for (const r of records) {
        stmt.run({
          name: r.name,
          name_hex: r.name_hex || null,
          namespace: r.namespace || null,
          value: typeof r.value === 'string' ? r.value : JSON.stringify(r.value),
          value_type: r.value_type || 'text',
          address: r.address || '',
          height: r.height || 0,
          expires_in: r.expires_in != null ? r.expires_in : null,
          expired: r.expired ? 1 : 0,
          ismine: r.ismine ? 1 : 0,
          first_seen: r.first_seen || r.height || 0,
          last_sync: now,
        });
      }
    })();
    this._synchronizedAt = now;
    return records.length;
  }

  // --- queries ---
  count() { return this.db.prepare('SELECT COUNT(*) c FROM names').get().c; }

  countByNamespace() {
    return this.db.prepare(`
      SELECT namespace, COUNT(*) total,
             SUM(CASE WHEN expired THEN 1 ELSE 0 END) expired,
             SUM(CASE WHEN NOT expired THEN 1 ELSE 0 END) live
      FROM names GROUP BY namespace ORDER BY total DESC
    `).all();
  }

  // recently updated (latest height first)
  recent(limit = 25, { expired } = {}) {
    let q = 'SELECT * FROM names';
    if (expired === true) q += ' WHERE expired=1';
    else if (expired === false) q += ' WHERE NOT expired';
    q += ' ORDER BY height DESC LIMIT ?';
    return this.db.prepare(q).all(limit);
  }

  // names expiring soonest (still live)
  expiringSoon(limit = 25) {
    return this.db.prepare(`
      SELECT * FROM names WHERE NOT expired AND expires_in IS NOT NULL
      ORDER BY expires_in ASC LIMIT ?
    `).all(limit);
  }

  // paginated registry browse
  page({ start = '', limit = 100, ns = null, status = null } = {}) {
    let where = [];
    const params = [];
    if (ns) { where.push('namespace=?'); params.push(ns + '/'); }
    if (status === 'live') { where.push('NOT expired'); }
    else if (status === 'expired') { where.push('expired=1'); }
    else if (status === 'expiring') { where.push('NOT expired AND expires_in IS NOT NULL AND expires_in < 1728'); } // ~12 days
    let q = 'SELECT * FROM names';
    if (where.length) q += ' WHERE ' + where.join(' AND ');
    if (start) { q += (where.length ? ' AND ' : ' WHERE ') + 'name > ?'; params.push(start); }
    q += ' ORDER BY name ASC LIMIT ?';
    params.push(limit);
    return this.db.prepare(q).all(...params);
  }

  // exact name (case-sensitive)
  get(name) { return this.db.prepare('SELECT * FROM names WHERE name=?').get(name); }

  search(term, limit = 30) {
    return this.db.prepare(`
      SELECT * FROM names WHERE name LIKE ? ORDER BY length(name) ASC, name ASC LIMIT ?
    `).all('%' + term + '%', limit);
  }

  close() { this.db.close(); }
}

module.exports = { NameCache };