'use strict';

// Decoding/interpretation layer for the Namecoin name registry.
// Turns raw RPC entries into rich UI-ready objects.

// What namespace is this name? Returns { prefix, namespace, full }
function parseNamespace(name) {
  if (typeof name !== 'string') return { prefix: '', namespace: '(root)', full: name || '(empty)' };
  const slash = name.indexOf('/');
  if (slash === -1) return { prefix: '', namespace: '(root)', full: name };
  return { prefix: name.slice(0, slash), namespace: name.slice(0, slash) + '/', full: name };
}

// Classify a name's value. Namecoin values are arbitrary bytes; most are JSON.
// d/ names often hold a dex-style "map" (DNS); u/ and id/ hold identity JSON.
// Some values are wrapped in literal single or double quotes ('{...}' or "{...}"),
// a storage quirk — strip those before attempting JSON parse.
function classifyValue(value) {
  if (value === undefined || value === null) return { type: 'none', preview: '' };
  const str = String(value);
  const trimmed = str.trim();
  if (trimmed === '') return { type: 'empty', preview: '' };
  if (trimmed === 'reserved') return { type: 'reserved', preview: str };

  // Strip a single outer layer of wrapping quotes if present ('{...}' or "{...}")
  let candidate = trimmed;
  if ((candidate.startsWith("'") && candidate.endsWith("'") && candidate.length > 1) ||
      (candidate.startsWith('"') && candidate.endsWith('"') && candidate.length > 1)) {
    candidate = candidate.slice(1, -1);
  }

  // Try JSON (never truncate; keep full for the raw display)
  try {
    const obj = JSON.parse(candidate);
    if (obj && typeof obj === 'object' && !Array.isArray(obj)) {
      return { type: 'json', parsed: obj, preview: candidate };
    }
    if (obj !== undefined) {
      return { type: 'json', parsed: obj, preview: candidate };
    }
  } catch (e) {
    /* not JSON */
  }

  // Heuristic: DNS "map" patterns (only if parsing failed above)
  if (/ns|map|ip|ip6|tls|tor|i2p/.test(trimmed) && /\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}/.test(trimmed)) {
    return { type: 'dns-hint', preview: trimmed, full: trimmed };
  }

  return { type: 'text', preview: trimmed, full: trimmed };
}

// The registry "height" field = last update height. Convert to a compact
// "first seen" vs "last updated" view from a name record and its history.
function lifespan(record, history) {
  const firstHeight = history && history.length ? history[history.length - 1].height : record.height;
  const lastHeight = record.height;
  const span = history ? history.length : null;
  return { firstHeight, lastHeight, operationCount: span };
}

// Decode a name's value into displayable segments. Values with JSON `map`
// render as a DNS table; identity JSON renders as key/value pairs.
// `raw` is always the FULL original value (pretty-printed for JSON) so the
// value box never truncates structured data.
function renderValue(record) {
  const cls = classifyValue(record.value);
  if (cls.type === 'json') {
    const p = cls.parsed;
    const raw = (typeof p === 'string') ? p : JSON.stringify(p, null, 2);
    // DNS map
    if (p && typeof p === 'object' && p.map && typeof p.map === 'object') {
      const table = [];
      for (const [k, v] of Object.entries(p.map)) {
        table.push({ label: (k === '') ? '(default)' : k, value: typeof v === 'object' ? JSON.stringify(v, null, 2) : v, isObject: typeof v === 'object' });
      }
      return { kind: 'json', table, raw };
    }
    // Any other JSON -> key/value table
    if (p && typeof p === 'object') {
      const table = [];
      for (const [k, v] of Object.entries(p)) {
        table.push({ label: k, value: typeof v === 'object' ? JSON.stringify(v, null, 2) : v, isObject: typeof v === 'object' });
      }
      return { kind: 'json', table, raw };
    }
    // Scalar JSON (string/number/bool) -> just show it
    return { kind: 'json', table: [], raw };
  }
  if (cls.type === 'empty') return { kind: 'empty' };
  return { kind: 'text', raw: cls.full || cls.preview };
}

// Human label for a name operation type.
const OP_LABELS = {
  NAME_NEW: { short: 'NEW', title: 'Registration commitment (name_new)' },
  NAME_FIRSTUPDATE: { short: 'REGISTER', title: 'First update / registration (name_firstupdate)' },
  NAME_UPDATE: { short: 'UPDATE', title: 'Update (name_update)' },
  NAME_RENEW: { short: 'RENEW', title: 'Renewal (name_renew)' },
  NAME_TRANSFER: { short: 'TRANSFER', title: 'Transfer to new owner' },
  NAME_CHECK: { short: 'CHECK', title: 'Check' },
  NAME_NOP: { short: 'NOP', title: 'No-op' },
};

const OPERATIONS_ORDER = ['NAME_FIRSTUPDATE', 'NAME_NEW', 'NAME_UPDATE', 'NAME_RENEW', 'NAME_TRANSFER'];

// Classify a full history array into an operation timeline.
// `opType` is an optional map already resolved by the route: txid -> op type
// (`NAME_NEW`/`FIRSTUPDATE`/`UPDATE`/`RENEW`), because name_history itself does
// not return the `op` type. When empty, fall back to best guess (first=REGISTER, rest=UPDATE).
function operationTimeline(history, opTypeMap, heightDates) {
  if (!Array.isArray(history)) return [];
  opTypeMap = opTypeMap || {};
  heightDates = heightDates || {};
  // history is most-recent-first typically. Recreate ascending timeline.
  return history.slice().reverse().map((op, i) => {
    const isFirst = i === 0;
    const isLatest = i === history.length - 1;
    const opType = op.op || opTypeMap[op.txid] || (isFirst ? 'NAME_FIRSTUPDATE' : 'NAME_UPDATE');
    const meta = OP_LABELS[opType] || { label: opType, title: opType };
    // real date from the block if we resolved it, else keep any `time` the RPC gave
    const ts = heightDates[op.height] || (op.time ? op.time * 1000 : null);
    const dateStr = ts ? new Date(ts).toISOString() : null;
    return { ...op, opType, opLabel: meta.short || meta.label, opTitle: meta.title,
             isFirst, isLatest, timeMs: ts, dateStr };
  });
}

module.exports = {
  parseNamespace,
  classifyValue,
  renderValue,
  OP_LABELS,
  operationTimeline,
  lifespan,
};