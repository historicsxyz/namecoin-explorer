'use strict';

// Decoding/interpretation layer for the Namecoin name registry.
// Turns raw RPC entries into rich UI-ready objects.

function parseNamespace(name) {
  if (typeof name !== 'string') return { prefix: '', namespace: '(root)', full: name || '(empty)' };
  const slash = name.indexOf('/');
  if (slash === -1) return { prefix: '', namespace: '(root)', full: name };
  return { prefix: name.slice(0, slash), namespace: name.slice(0, slash) + '/', full: name };
}

// Namecoin values are arbitrary bytes; most are JSON.
// Some values are wrapped in literal quotes ('{...}' or "{...}").
function classifyValue(value) {
  if (value === undefined || value === null) return { type: 'none', preview: '' };
  const str = String(value);
  const trimmed = str.trim();
  if (trimmed === '') return { type: 'empty', preview: '' };
  if (trimmed === 'reserved') return { type: 'reserved', preview: str };

  let candidate = trimmed;
  if ((candidate.startsWith("'") && candidate.endsWith("'") && candidate.length > 1) ||
      (candidate.startsWith('"') && candidate.endsWith('"') && candidate.length > 1)) {
    candidate = candidate.slice(1, -1);
  }

  try {
    const obj = JSON.parse(candidate);
    if (obj !== undefined) {
      return { type: 'json', parsed: obj, preview: candidate };
    }
  } catch (e) {
    /* not JSON */
  }

  if (/ns|map|ip|ip6|tls|tor|i2p/.test(trimmed) && /\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}/.test(trimmed)) {
    return { type: 'dns-hint', preview: trimmed, full: trimmed };
  }

  return { type: 'text', preview: trimmed, full: trimmed };
}

function lifespan(record, history) {
  const firstHeight = history && history.length ? history[history.length - 1].height : record.height;
  const lastHeight = record.height;
  const span = history ? history.length : null;
  return { firstHeight, lastHeight, operationCount: span };
}

function renderValue(record) {
  const cls = classifyValue(record.value);
  if (cls.type === 'json') {
    const p = cls.parsed;
    const raw = (typeof p === 'string') ? p : JSON.stringify(p, null, 2);
    if (p && typeof p === 'object' && p.map && typeof p.map === 'object') {
      const table = [];
      for (const [k, v] of Object.entries(p.map)) {
        table.push({
          label: (k === '') ? '(default)' : k,
          value: typeof v === 'object' ? JSON.stringify(v, null, 2) : v,
          isObject: typeof v === 'object',
        });
      }
      return { kind: 'json', table, raw };
    }
    if (p && typeof p === 'object') {
      const table = [];
      for (const [k, v] of Object.entries(p)) {
        table.push({
          label: k,
          value: typeof v === 'object' ? JSON.stringify(v, null, 2) : v,
          isObject: typeof v === 'object',
        });
      }
      return { kind: 'json', table, raw };
    }
    return { kind: 'json', table: [], raw };
  }
  if (cls.type === 'empty') return { kind: 'empty' };
  return { kind: 'text', raw: cls.full || cls.preview };
}

const OP_LABELS = {
  NAME_NEW: { short: 'NEW', title: 'Registration commitment (name_new)' },
  NAME_FIRSTUPDATE: { short: 'REGISTER', title: 'First update / registration (name_firstupdate)' },
  NAME_UPDATE: { short: 'UPDATE', title: 'Update (name_update)' },
};

function canonicalizeOpLocal(op) {
  if (!op) return null;
  const s = String(op).toUpperCase().replace(/^OP_/, '');
  if (s === 'NAME_NEW' || s === 'NEW') return 'NAME_NEW';
  if (s.indexOf('FIRST') >= 0) return 'NAME_FIRSTUPDATE';
  if (s.indexOf('UPDATE') >= 0) return 'NAME_UPDATE';
  return s.startsWith('NAME_') ? s : null;
}

function inferUpdateKind(op, prev) {
  if (!op || canonicalizeOpLocal(op.op || op.opType) !== 'NAME_UPDATE') return null;
  if (prev && prev.address && op.address && prev.address !== op.address) return 'TRANSFER';
  if (prev && String(prev.value || '') === String(op.value || '')) return 'RENEW';
  return null;
}

function operationTimeline(history, opTypeMap, heightDates) {
  if (!Array.isArray(history)) return [];
  opTypeMap = opTypeMap || {};
  heightDates = heightDates || {};
  const asc = history.slice().reverse();
  return asc.map((op, i) => {
    const isFirst = i === 0;
    const isLatest = i === history.length - 1;
    const opType = canonicalizeOpLocal(op.op || opTypeMap[op.txid]) || (isFirst ? 'NAME_FIRSTUPDATE' : 'NAME_UPDATE');
    const prev = i > 0 ? asc[i - 1] : null;
    const inferred = inferUpdateKind({ ...op, op: opType }, prev);
    const meta = OP_LABELS[opType] || { short: opType, title: opType };
    const ts = heightDates[op.height] || (op.time ? op.time * 1000 : (op.timeMs || null));
    const dateStr = ts ? new Date(ts).toISOString() : null;
    return {
      ...op,
      opType,
      inferred,
      opLabel: inferred === 'TRANSFER' ? 'TRANSFER' : inferred === 'RENEW' ? 'RENEW' : (meta.short || meta.label),
      opTitle: inferred === 'TRANSFER'
        ? 'Transfer to new owner (name_update)'
        : inferred === 'RENEW'
          ? 'Renewal (name_update, same value)'
          : meta.title,
      isFirst,
      isLatest,
      timeMs: ts,
      dateStr,
    };
  });
}

function timelineFromOps(ops) {
  if (!Array.isArray(ops)) return [];
  const heightDates = {};
  for (const o of ops) {
    if (o.height && o.time) heightDates[o.height] = o.time * 1000;
  }
  return operationTimeline(ops.slice().reverse(), null, heightDates);
}

module.exports = {
  parseNamespace,
  classifyValue,
  renderValue,
  OP_LABELS,
  operationTimeline,
  timelineFromOps,
  inferUpdateKind,
  lifespan,
};
