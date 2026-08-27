'use strict';

const RANGE_SEC = {
  '1h': 3600,
  '6h': 6 * 3600,
  '24h': 24 * 3600,
  '7d': 7 * 24 * 3600,
};

function canonicalizeTxOps(raw) {
  if (raw == null || raw === '') return null;
  const s = String(raw).trim();
  if (!s) return null;
  const low = s.toLowerCase();
  if (low === 'with' || low === 'ops') return 'with';
  if (low === 'none' || low === 'empty') return 'none';
  if (low === 'busy' || low === 'hot' || low === '2+') return 'busy';
  const u = s.toUpperCase().replace(/^OP_/, '');
  if (u === 'NAME_NEW' || u === 'NEW') return 'NAME_NEW';
  if (u.indexOf('FIRST') >= 0) return 'NAME_FIRSTUPDATE';
  if (u === 'NAME_UPDATE' || u === 'UPDATE') return 'NAME_UPDATE';
  return null;
}

function parseTxOps(raw) {
  const s = String(raw == null ? '' : raw).trim();
  if (!s) return { ops: null, invalid: false };
  const ops = canonicalizeTxOps(s);
  return { ops, invalid: !ops };
}

function parseTxRange(raw, nowSec = Math.floor(Date.now() / 1000)) {
  const s = String(raw == null ? '' : raw).trim().toLowerCase();
  if (!s) return { range: null, since: null, invalid: false };
  const sec = RANGE_SEC[s];
  if (!sec) return { range: null, since: null, invalid: true };
  const now = Number(nowSec);
  const base = Number.isFinite(now) ? Math.floor(now) : Math.floor(Date.now() / 1000);
  return { range: s, since: base - sec, invalid: false };
}

function txidOf(txid) {
  if (txid == null) return '';
  if (typeof txid === 'string') return txid;
  return txid.txid ? String(txid.txid) : '';
}

function opRows(opsByTxid, txid) {
  if (!opsByTxid || !txid) return [];
  return opsByTxid[String(txid).toLowerCase()] || [];
}

function txMatches(id, time, { ops = null, since = null, opsByTxid = null } = {}) {
  if (since != null) {
    const ts = Number(time);
    if (!Number.isFinite(ts) || ts < since) return false;
  }
  if (!ops) return true;
  const rows = opRows(opsByTxid, id);
  const n = rows.length;
  if (ops === 'with') return n >= 1;
  if (ops === 'none') return n === 0;
  if (ops === 'busy') return n >= 2;
  if (ops === 'NAME_NEW' || ops === 'NAME_FIRSTUPDATE' || ops === 'NAME_UPDATE') {
    return rows.some((row) => row && row.op === ops);
  }
  return true;
}

function filterTxGroups(groups, opts) {
  return (groups || []).map((g) => {
    const tx = (g.tx || []).filter((item) => {
      const id = txidOf(item);
      return id && txMatches(id, g.time, opts);
    });
    return { ...g, tx };
  }).filter((g) => (g.tx || []).length);
}

function nameOpTxQuery(ops, since, limit = 40) {
  const q = {
    minOps: 1,
    since: since != null ? since : null,
    op: null,
    hideCommitments: true,
    limit,
  };
  if (ops === 'busy') q.minOps = 2;
  else if (ops === 'NAME_NEW' || ops === 'NAME_FIRSTUPDATE' || ops === 'NAME_UPDATE') {
    q.op = ops;
    q.hideCommitments = false;
  }
  return q;
}

function windowOldest(groups) {
  let min = null;
  for (const g of groups || []) {
    const ts = Number(g && g.time);
    if (!Number.isFinite(ts)) continue;
    if (min == null || ts < min) min = ts;
  }
  return min;
}

function rangeExceedsWindow(since, groups) {
  if (since == null) return false;
  const oldest = windowOldest(groups);
  return oldest == null || oldest > since;
}

function countListedTxs(groups, fallback) {
  let n = 0;
  for (const g of groups || []) n += (g.tx || []).length;
  n += (fallback || []).length;
  return n;
}

module.exports = {
  RANGE_SEC,
  canonicalizeTxOps,
  parseTxOps,
  parseTxRange,
  txidOf,
  txMatches,
  filterTxGroups,
  nameOpTxQuery,
  windowOldest,
  rangeExceedsWindow,
  countListedTxs,
};
