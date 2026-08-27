'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { NamecoinRPC } = require('../lib/rpc');

describe('NamecoinRPC wait cap', () => {
  it('rejects with RPC_BUSY when the queue is full', async () => {
    const rpc = new NamecoinRPC({ concurrency: 1, maxWait: 1, timeout: 1000 });
    const gates = [];
    rpc._rawCall = () => new Promise((resolve) => { gates.push(resolve); });
    const first = rpc.call('a');
    while (rpc._active < 1) await new Promise((r) => setImmediate(r));
    const second = rpc.call('b');
    while (rpc._wait.length < 1) await new Promise((r) => setImmediate(r));
    await assert.rejects(() => rpc.call('c'), (err) => err && err.code === 'RPC_BUSY');
    gates[0]({});
    await first;
    while (gates.length < 2) await new Promise((r) => setImmediate(r));
    gates[1]({});
    await second;
  });
});
