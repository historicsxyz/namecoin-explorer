'use strict';

// Transaction name-op extraction.
// Given a decoded transaction (from getrawtransaction or block tx), find and
// describe any Namecoin name operations it contains.

const OP_LABELS = {
  NAME_NEW: 'NAME_NEW',
  NAME_FIRSTUPDATE: 'NAME_FIRSTUPDATE',
  NAME_UPDATE: 'NAME_UPDATE',
  NAME_RENEW: 'NAME_RENEW',
  NAME_TRANSFER: 'NAME_TRANSFER',
};

// Detect a name op + decode its name/value from a scriptPubKey ASM string.
// Handles both hex name bytes and ASCII.
function extractFromAsm(asm) {
  if (!asm || asm.indexOf('OP_NAME') === -1) return null;
  const parts = asm.split(/\s+/);
  let op = null;
  let opIdx = -1;
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i];
    if (p.indexOf('OP_NAME') === 0) {
      op = p; opIdx = i; break;
    }
  }
  if (!op) return null;

  // After the op, remaining hex tokens. For NEW it's a hash; for FIRSTUPDATE/UPDATE
  // the next token is the name (could be hex or utf8), then value.
  const rest = parts.slice(opIdx + 1);
  let nameHex = null;
  let value = null;
  // NAME_NEW: <namehash> <rand> <op_drops>
  if (op === 'OP_NAME_NEW') {
    return { op: 'NAME_NEW', nameHex: null, value: null };
  }
  // FIRSTUPDATE/UPDATE: <name> <value> <drops>
  if (rest.length >= 1) nameHex = rest[0];
  if (rest.length >= 2) value = rest[1];

  // Decode name (hex if op is FIRSTUPDATE etc) - try utf8, fall back hex
  let name = null;
  if (nameHex && /^[0-9a-fA-F]+$/.test(nameHex)) {
    try {
      name = Buffer.from(nameHex, 'hex').toString('utf8');
      // if result contains replacement chars, keep hex
      if (name.indexOf('\uFFFD') !== -1) name = 'hex:' + nameHex;
    } catch { name = 'hex:' + nameHex; }
  } else {
    name = nameHex;
  }

  return { op, nameHex, name, value };
}

// Given a decoded tx (verbose object), return list of { op, name, value, vout }.
function nameOpsFromTx(tx) {
  const out = [];
  if (!tx || !Array.isArray(tx.vout)) return out;
  for (let vi = 0; vi < tx.vout.length; vi++) {
    const vo = tx.vout[vi];
    const spk = vo && vo.scriptPubKey;
    if (!spk) continue;
    const parsed = extractFromAsm(spk.asm);
    if (parsed) out.push({ vout: vi, ...parsed, value: parsed.value !== null ? decodedValue(parsed.value) : null });
  }
  return out;
}

// Value bytes -> readable string (hex or utf8)
function decodedValue(v) {
  if (!v) return '';
  if (typeof v !== 'string') return String(v);
  if (/^[0-9a-fA-F]+$/.test(v) && v.length % 2 === 0) {
    try {
      const d = Buffer.from(v, 'hex').toString('utf8');
      if (d.indexOf('\uFFFD') === -1) return d;
    } catch {}
  }
  return v;
}

module.exports = { nameOpsFromTx, extractFromAsm, OP_LABELS };