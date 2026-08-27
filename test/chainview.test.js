'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  isCoinbaseVin,
  parentBitcoinHash,
  sumVoutNmc,
  decorateRpcBlock,
  viewBlockFromCache,
  publicInputs,
  publicOutputs,
} = require('../lib/chainview');

const GENESIS_HEADER = '0100000000000000000000000000000000000000000000000000000000000000000000003ba3edfd7a7b12b27ac72c3e67768f617fc81bc3888a51323a9fb8aa4b1e5e4a29ab5f49ffff001d1dac2b7c';
const GENESIS_HASH = '000000000019d6689c085ae165831e934ff763ae46a2a6c172b3f1b60a8ce26f';

describe('chainview', () => {
  it('hashes an auxpow parent Bitcoin header', () => {
    assert.equal(parentBitcoinHash({ parentblock: GENESIS_HEADER }), GENESIS_HASH);
    assert.equal(parentBitcoinHash({ parentblockhash: GENESIS_HASH }), GENESIS_HASH);
    assert.equal(parentBitcoinHash(null), null);
  });

  it('detects coinbase inputs and sums outputs in whole satoshis', () => {
    assert.equal(isCoinbaseVin({ coinbase: '04ffff' }), true);
    assert.equal(isCoinbaseVin({ txid: 'ab'.repeat(32), vout: 0 }), false);
    assert.equal(sumVoutNmc({ vout: [{ value: 6.25 }, { value: 0.00000001 }] }), 6.25000001);
  });

  it('decorates an RPC block with name ops, coinbase, and parent hash', () => {
    const block = decorateRpcBlock({
      auxpow: { parentblock: GENESIS_HEADER },
      tx: [{
        txid: 'cc'.repeat(32),
        vin: [{ coinbase: '00' }],
        vout: [
          { value: 6.25, scriptPubKey: { type: 'pubkeyhash', address: 'N1' } },
          {
            value: 0.01,
            scriptPubKey: {
              type: 'nulldata',
              nameOp: { op: 'name_update', name: 'd/x', value: '{}' },
            },
          },
        ],
      }],
    });
    assert.equal(block._parentBitcoinHash, GENESIS_HASH);
    assert.equal(block._coinbaseNmc, 6.26);
    assert.equal(block._nameOpCount, 1);
    assert.equal(block.tx[0]._nameOps[0].name, 'd/x');
  });

  it('builds an index-only block view without inventing vin/vout counts', () => {
    const view = viewBlockFromCache({
      hash: 'hh',
      height: 10,
      time: 1,
      previousblockhash: 'pp',
      nextblockhash: 'nn',
      nTx: 3,
      merkleroot: 'mm',
      difficulty: 1.5,
      nameOpCount: 1,
      nameOps: [{ txid: 'tt', op: 'NAME_UPDATE', name: 'd/our', value: '{}' }],
    });
    assert.equal(view.nextblockhash, 'nn');
    assert.equal(view.tx.length, 1);
    assert.equal(view.tx[0].vin, null);
    assert.equal(view.tx[0]._nameOps[0].name, 'd/our');
  });

  it('publishes tx inputs and outputs without changing vin counts', () => {
    const tx = {
      vin: [{ coinbase: 'aa' }, { txid: 'ab'.repeat(32), vout: 1 }],
      vout: [{ value: 1, scriptPubKey: { type: 'pubkeyhash', address: 'N1' } }],
    };
    assert.deepEqual(publicInputs(tx)[0], { n: 0, coinbase: true });
    assert.equal(publicInputs(tx)[1].vout, 1);
    assert.equal(publicOutputs(tx)[0].address, 'N1');
  });
});
