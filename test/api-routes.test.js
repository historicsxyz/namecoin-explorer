'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const { NameCache } = require('../lib/cache');
const registerRoutes = require('../lib/routes');

function downRpc() {
  const err = new Error('connect ECONNREFUSED 127.0.0.1:18336');
  return {
    nameShow: async () => { throw err; },
    nameHistory: async () => { throw err; },
    namePending: async () => { throw err; },
    call: async () => { throw err; },
  };
}

function seed(cache) {
  cache.insertBlock({
    header: { height: 10, hash: 'h10', time: 1, prev: '00', ntx: 1, merkle: 'mm' },
    ops: [{
      txid: 'tt',
      vout: 0,
      op: 'NAME_UPDATE',
      name: 'd/our',
      nameHex: Buffer.from('d/our').toString('hex'),
      value: '{}',
      address: 'N1',
    }],
    tipHeight: 10,
  });
  cache.setTip(10, 'h10');
  cache.upsertNameRecord({
    name: 'd/our', value: '{}', address: 'N1', height: 10,
  }, 10);
}

async function withServer(fn) {
  const cache = new NameCache(':memory:');
  seed(cache);
  const app = express();
  registerRoutes(app, { rpc: downRpc(), cache, ingest: { backfillName: async () => null } });
  const server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const port = server.address().port;
  try {
    await fn(port);
  } finally {
    await new Promise((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
    cache.close();
  }
}

async function getJson(port, path) {
  const res = await fetch('http://127.0.0.1:' + port + path, {
    headers: { accept: 'application/json' },
  });
  return { status: res.status, body: await res.json() };
}

describe('JSON API cache fallbacks', () => {
  it('serves /api/name from the index when RPC is down', async () => {
    await withServer(async (port) => {
      const { status, body } = await getJson(port, '/api/name/d%2Four');
      assert.equal(status, 200);
      assert.equal(body.source, 'index');
      assert.equal(body.name, 'd/our');
      const hist = await getJson(port, '/api/name/d%2Four/history');
      assert.equal(hist.status, 200);
      assert.equal(hist.body.source, 'index');
      assert.equal(hist.body.items[0].op, 'NAME_UPDATE');
      const pending = await getJson(port, '/api/name/d%2Four/pending');
      assert.equal(pending.status, 503);
      assert.match(pending.body.error, /ECONNREFUSED/);
    });
  });

  it('mirrors tx, block, ops, addresses, and namespaces from the index', async () => {
    await withServer(async (port) => {
      const tx = await getJson(port, '/api/tx/tt');
      assert.equal(tx.status, 200);
      assert.equal(tx.body.source, 'index');
      assert.equal(tx.body.nameOps[0].name, 'd/our');

      const txs = await getJson(port, '/api/tx');
      assert.equal(txs.status, 200);
      assert.equal(txs.body.source, 'index');
      assert.ok(txs.body.items.some((i) => i.txid === 'tt'));

      const block = await getJson(port, '/api/block/10');
      assert.equal(block.status, 200);
      assert.equal(block.body.source, 'index');
      assert.equal(block.body.height, 10);
      assert.equal(block.body.nameOpCount, 1);

      const ops = await getJson(port, '/api/operations');
      assert.equal(ops.body.source, 'index');
      assert.equal(ops.body.items[0].name, 'd/our');

      const pending = await getJson(port, '/api/operations/pending');
      assert.equal(pending.status, 503);

      const addr = await getJson(port, '/api/address/N1');
      assert.equal(addr.body.seen, true);
      assert.equal(addr.body.names[0].name, 'd/our');

      const ns = await getJson(port, '/api/namespaces');
      assert.equal(ns.body.source, 'index');
      assert.ok(ns.body.items.some((r) => r.namespace === 'd/'));
    });
  });
});
