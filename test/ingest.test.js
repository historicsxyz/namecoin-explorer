'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { IngestService, ingestOptionsFromEnv } = require('../lib/ingest');
const { NameCache } = require('../lib/cache');
const { NAME_EXPIRY_DEPTH } = require('../lib/expiry');
const { t, pickLang } = require('../lib/i18n');

describe('ingestOptionsFromEnv', () => {
  it('defaults to a 36k rewind and no ZMQ', () => {
    const o = ingestOptionsFromEnv({});
    assert.equal(o.fromGenesis, false);
    assert.equal(o.rewindBlocks, NAME_EXPIRY_DEPTH);
    assert.equal(o.zmqUrl, null);
  });

  it('treats 0 and genesis as a full-history first run', () => {
    assert.equal(ingestOptionsFromEnv({ NMC_INGEST_FROM: '0' }).fromGenesis, true);
    assert.equal(ingestOptionsFromEnv({ NMC_INGEST_FROM: 'genesis' }).fromGenesis, true);
    assert.ok(ingestOptionsFromEnv({ NMC_INGEST_FROM: '0' }).rewindBlocks > NAME_EXPIRY_DEPTH);
  });

  it('passes through a hashblock ZMQ URL', () => {
    const o = ingestOptionsFromEnv({ NMC_ZMQ_HASHBLOCK: 'tcp://127.0.0.1:28332' });
    assert.equal(o.zmqUrl, 'tcp://127.0.0.1:28332');
  });
});

function nameTx(txid, op, name, value, address) {
  return {
    txid,
    vout: [{
      scriptPubKey: {
        nameOp: { op, name, value },
        address,
      },
    }],
  };
}

describe('IngestService.backfillName', () => {
  it('merges name_history onto a name that already has one windowed op', async () => {
    const cache = new NameCache(':memory:');
    cache.insertBlock({
      header: { height: 200, hash: 'h2', time: 20, prev: 'h1', ntx: 1, merkle: 'm' },
      ops: [{
        txid: 'recent',
        vout: 0,
        op: 'NAME_UPDATE',
        name: 'd/paper',
        nameHex: Buffer.from('d/paper').toString('hex'),
        value: 'v2',
        address: 'N2',
      }],
      tipHeight: 200,
    });
    assert.equal(cache.opsForName('d/paper').length, 1);
    assert.equal(cache.isHistorySynced('d/paper'), false);

    const rpc = {
      nameHistory: async () => ([
        { txid: 'first', height: 50 },
        { txid: 'recent', height: 200 },
      ]),
      call: async (method, params) => {
        if (method === 'getrawtransaction') {
          return params[0] === 'first'
            ? nameTx('first', 'name_firstupdate', 'd/paper', 'v1', 'N1')
            : nameTx('recent', 'name_update', 'd/paper', 'v2', 'N2');
        }
        if (method === 'getblockhash') return 'bh';
        if (method === 'getblockheader') return { time: 10 };
        throw new Error(method);
      },
    };
    const ingest = new IngestService(rpc, cache);
    const ops = await ingest.backfillName('d/paper');
    assert.equal(ops.length, 2);
    assert.equal(ops[0].op, 'NAME_FIRSTUPDATE');
    assert.equal(ops[0].txid, 'first');
    assert.equal(ops[1].op, 'NAME_UPDATE');
    assert.equal(cache.isHistorySynced('d/paper'), true);
    cache.close();
  });

  it('returns null and leaves history unsynced when name_history fails', async () => {
    const cache = new NameCache(':memory:');
    const rpc = {
      nameHistory: async () => { throw new Error('rpc down'); },
    };
    const ingest = new IngestService(rpc, cache);
    const ops = await ingest.backfillName('d/missing');
    assert.equal(ops, null);
    assert.equal(cache.isHistorySynced('d/missing'), false);
    cache.close();
  });
});

describe('IngestService.stop', () => {
  it('wakes poll sleep and waits for the loop to exit', async () => {
    const cache = new NameCache(':memory:');
    const rpc = {
      call: async () => { throw new Error('rpc down'); },
    };
    const ingest = new IngestService(rpc, cache);
    ingest.start();
    await new Promise((r) => setTimeout(r, 50));
    const t0 = Date.now();
    await ingest.stop();
    assert.ok(Date.now() - t0 < 2000);
    cache.close();
  });
});

describe('i18n', () => {
  it('falls back to English and interpolates', () => {
    assert.equal(t('en', 'nav.home'), 'Home');
    assert.equal(t('de', 'nav.home'), 'Start');
    assert.equal(t('xx', 'nav.home'), 'Home');
    assert.match(t('en', 'ops.chainTip', { n: 12 }), /12/);
  });

  it('picks lang from query then Accept-Language', () => {
    assert.equal(pickLang('de', 'en-US,en;q=0.9'), 'de');
    assert.equal(pickLang(undefined, 'de-DE,de;q=0.9,en;q=0.8'), 'de');
    assert.equal(pickLang('zz', 'fr-FR'), 'en');
  });
});
