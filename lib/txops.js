'use strict';

// Extract Namecoin name operations from a verbose transaction.
// Prefer Core's scriptPubKey.nameOp; fall back to ASM.
// Consensus ops: NAME_NEW, NAME_FIRSTUPDATE, NAME_UPDATE only.

function canonicalizeOp(op) {
  if (!op) return null;
  const s = String(op).toUpperCase().replace(/^OP_/, '');
  if (s === 'NAME_NEW' || s === 'NEW') return 'NAME_NEW';
  if (s === 'NAME_FIRSTUPDATE' || s === 'FIRSTUPDATE' || s === 'NAME_FIRST_UPDATE') return 'NAME_FIRSTUPDATE';
  if (s === 'NAME_UPDATE' || s === 'UPDATE') return 'NAME_UPDATE';
  return null;
}

function decodeHexish(hex) {
  if (!hex) return null;
  if (typeof hex !== 'string') return String(hex);
  if (!/^[0-9a-fA-F]+$/.test(hex) || hex.length % 2 !== 0) return hex;
  try {
    const d = Buffer.from(hex, 'hex').toString('utf8');
    if (d.indexOf('\uFFFD') === -1) return d;
  } catch {}
  return hex;
}

function extractFromAsm(asm) {
  if (!asm || asm.indexOf('OP_NAME') === -1) return null;
  const parts = asm.split(/\s+/);
  let op = null;
  let opIdx = -1;
  for (let i = 0; i < parts.length; i++) {
    if (parts[i].indexOf('OP_NAME') === 0) {
      op = canonicalizeOp(parts[i]);
      opIdx = i;
      break;
    }
  }
  if (!op) return null;
  const rest = parts.slice(opIdx + 1);
  if (op === 'NAME_NEW') return { op, nameHex: null, name: null, value: null };
  const nameHex = rest[0] || null;
  const valueHex = rest[1] || null;
  return {
    op,
    nameHex,
    name: decodeHexish(nameHex),
    value: decodeHexish(valueHex),
  };
}

function extractFromNameOp(nameOp) {
  if (!nameOp) return null;
  const op = canonicalizeOp(nameOp.op || nameOp.nameOp);
  if (!op) return null;
  const name = nameOp.name || null;
  const value = nameOp.value != null ? nameOp.value : null;
  const nameHex = name ? Buffer.from(String(name), 'utf8').toString('hex') : null;
  return { op, name, nameHex, value };
}

function addressFromSpk(spk) {
  if (!spk) return '';
  if (spk.address) return spk.address;
  if (Array.isArray(spk.addresses) && spk.addresses[0]) return spk.addresses[0];
  return '';
}

function nameOpsFromTx(tx) {
  const out = [];
  if (!tx || !Array.isArray(tx.vout)) return out;
  for (let vi = 0; vi < tx.vout.length; vi++) {
    const vo = tx.vout[vi];
    const spk = vo && vo.scriptPubKey;
    if (!spk) continue;
    let parsed = null;
    if (spk.nameOp) parsed = extractFromNameOp(spk.nameOp);
    if (!parsed) parsed = extractFromAsm(spk.asm);
    if (parsed) {
      out.push({
        vout: vi,
        txid: tx.txid,
        address: addressFromSpk(spk),
        ...parsed,
      });
    }
  }
  return out;
}

module.exports = {
  nameOpsFromTx,
  extractFromAsm,
  extractFromNameOp,
  canonicalizeOp,
};
