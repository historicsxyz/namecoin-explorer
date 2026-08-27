'use strict';

// Block/tx view helpers from Core RPC objects. No extra round-trips.
const crypto = require('crypto');
const { nameOpsFromTx, addressFromSpk } = require('./txops');

const ZERO_TXID = '0'.repeat(64);

function isHash64(s) {
  return typeof s === 'string' && /^[0-9a-fA-F]{64}$/.test(s);
}

function isCoinbaseVin(vin) {
  if (!vin || typeof vin !== 'object') return false;
  if (vin.coinbase != null) return true;
  return String(vin.txid || '') === ZERO_TXID;
}

function parentBitcoinHash(auxpow) {
  if (!auxpow || typeof auxpow !== 'object') return null;
  const direct = auxpow.parentblockhash || auxpow.parentBlockHash;
  if (isHash64(direct)) return String(direct).toLowerCase();
  const hex = auxpow.parentblock || auxpow.parentBlock;
  if (typeof hex !== 'string') return null;
  const clean = hex.trim().toLowerCase().replace(/^0x/, '');
  if (isHash64(clean)) return clean;
  if (!/^[0-9a-f]+$/.test(clean) || clean.length < 160) return null;
  const header = Buffer.from(clean.slice(0, 160), 'hex');
  if (header.length !== 80) return null;
  const h = crypto.createHash('sha256')
    .update(crypto.createHash('sha256').update(header).digest())
    .digest();
  return Buffer.from(h).reverse().toString('hex');
}

function sumVoutNmc(tx) {
  let sats = 0;
  for (const o of (tx && tx.vout) || []) {
    const n = Number(o && o.value);
    if (!Number.isFinite(n)) continue;
    sats += Math.round(n * 1e8);
  }
  return sats / 1e8;
}

function decorateRpcBlock(block) {
  if (!block) return block;
  for (const tx of block.tx || []) {
    if (tx && typeof tx === 'object') tx._nameOps = nameOpsFromTx(tx);
  }
  block._nameOpCount = (block.tx || []).reduce((a, t) => a + ((t && t._nameOps) || []).length, 0);
  block._parentBitcoinHash = parentBitcoinHash(block.auxpow);
  const coinbase = (block.tx || []).find((t) => t && isCoinbaseVin((t.vin || [])[0]));
  block._coinbaseNmc = coinbase ? sumVoutNmc(coinbase) : null;
  return block;
}

function viewBlockFromCache(payload) {
  if (!payload) return null;
  const ops = payload.nameOps || [];
  const txs = [];
  const seen = new Set();
  for (const o of ops) {
    if (!o || !o.txid || seen.has(o.txid)) continue;
    seen.add(o.txid);
    txs.push({
      txid: o.txid,
      vin: null,
      vout: null,
      _nameOps: ops.filter((x) => x && x.txid === o.txid),
      _indexOnly: true,
    });
  }
  return {
    hash: payload.hash,
    height: payload.height,
    time: payload.time,
    previousblockhash: payload.previousblockhash || null,
    nextblockhash: payload.nextblockhash || null,
    nTx: payload.nTx,
    merkleroot: payload.merkleroot || null,
    nonce: payload.nonce,
    difficulty: payload.difficulty != null ? payload.difficulty : null,
    _nameOpCount: payload.nameOpCount || 0,
    tx: txs,
    _indexOnly: true,
  };
}

function publicInputs(tx) {
  return ((tx && tx.vin) || []).map((v, n) => {
    if (isCoinbaseVin(v)) return { n, coinbase: true };
    return { n, txid: (v && v.txid) || null, vout: v && v.vout };
  });
}

function publicOutputs(tx) {
  return ((tx && tx.vout) || []).map((o, n) => {
    const spk = o && o.scriptPubKey;
    return {
      n,
      value: o && o.value,
      address: addressFromSpk(spk) || null,
      type: (spk && spk.type) || null,
    };
  });
}

module.exports = {
  isCoinbaseVin,
  parentBitcoinHash,
  sumVoutNmc,
  decorateRpcBlock,
  viewBlockFromCache,
  publicInputs,
  publicOutputs,
};
