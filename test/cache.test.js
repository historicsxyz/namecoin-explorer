'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { NameCache } = require('../lib/cache');
const { inferUpdateKind } = require('../lib/names');
const { HEX_OPTS, SHOW_OPTS } = require('../lib/rpc');

describe('rpc encodings', () => {
  it('sends Core nameEncoding / valueEncoding hex options', () => {
    assert.equal(JSON.stringify(HEX_OPTS), '{"nameEncoding":"hex","valueEncoding":"hex"}');
    assert.equal(SHOW_OPTS.allowExpired, true);
  });
});

describe('NameCache', () => {
  it('upserts a name and expires it when the tip advances', () => {
    const cache = new NameCache(':memory:');
    cache.upsertNameRecord({
      name: 'd/example',
      value: '{"map":{}}',
      address: 'Nowner',
      height: 1000,
    }, 1000);
    const live = cache.get('d/example');
    assert.equal(live.namespace, 'd/');
    assert.equal(live.expired, 0);
    assert.equal(live.expires_in, 36000);

    cache.setTip(37001, 'x');
    const dead = cache.get('d/example');
    assert.equal(dead.expired, 1);
    assert.ok(dead.expires_in <= 0);
    assert.ok(cache.page({ status: 'expired' }).some((r) => r.name === 'd/example'));
    assert.equal(cache.expiringSoon().some((r) => r.name === 'd/example'), false);
    cache.close();
  });

  it('hides NAME_NEW commitments from recentOps unless opted in', () => {
    const cache = new NameCache(':memory:');
    cache.insertBlock({
      header: { height: 10, hash: 'h1', time: 1, prev: '00', ntx: 2, merkle: 'mm' },
      ops: [
        { txid: 'new1', vout: 0, op: 'NAME_NEW', name: null, nameHex: null, value: 'aa', address: 'A' },
        {
          txid: 'fu1', vout: 0, op: 'NAME_FIRSTUPDATE', name: 'd/a',
          nameHex: Buffer.from('d/a').toString('hex'), value: '{}', address: 'A',
        },
      ],
      tipHeight: 10,
    });
    const hidden = cache.recentOps({ limit: 10 });
    assert.equal(hidden.length, 1);
    assert.equal(hidden[0].op, 'NAME_FIRSTUPDATE');
    const shown = cache.recentOps({ limit: 10, hideCommitments: false });
    assert.equal(shown.length, 2);
    const onlyNew = cache.recentOps({ op: 'NAME_NEW', limit: 10 });
    assert.equal(onlyNew.length, 1);
    assert.equal(onlyNew[0].op, 'NAME_NEW');
    const atHeight = cache.opsAtHeight(10);
    assert.equal(atHeight.length, 1);
    assert.equal(atHeight[0].op, 'NAME_FIRSTUPDATE');
    assert.equal(cache.opsAtHeight(10, { hideCommitments: false }).length, 2);
    cache.close();
  });

  it('prefix-searches names via FTS5 with a LIKE fallback', () => {
    const cache = new NameCache(':memory:');
    cache.upsertNameRecord({ name: 'd/bitcoin', value: '{}', address: 'N', height: 1 }, 1);
    cache.upsertNameRecord({ name: 'd/bit', value: '{}', address: 'N', height: 1 }, 1);
    cache.upsertNameRecord({ name: 'id/alice', value: '{}', address: 'N', height: 1 }, 1);
    const rows = cache.search('bit', 30);
    const names = rows.map((r) => r.name);
    assert.ok(names.includes('d/bit'));
    assert.ok(names.includes('d/bitcoin'));
    assert.ok(!names.includes('id/alice'));
    assert.ok(rows.length <= 30);
    assert.equal(cache.search('', 30).length, 0);
    cache.close();
  });

  it('indexes name ops from insertBlock', () => {
    const cache = new NameCache(':memory:');
    cache.insertBlock({
      header: { height: 200, hash: 'aa', time: 1, prev: '00', ntx: 1, merkle: 'mm' },
      ops: [{
        txid: 'tt',
        vout: 0,
        op: 'NAME_FIRSTUPDATE',
        name: 'd/x',
        nameHex: Buffer.from('d/x').toString('hex'),
        value: '{}',
        address: 'N1',
      }],
      tipHeight: 200,
    });
    cache.setTip(200, 'aa');
    const ops = cache.opsForName('d/x');
    assert.equal(ops.length, 1);
    assert.equal(ops[0].op, 'NAME_FIRSTUPDATE');
    assert.equal(cache.getTip().height, 200);
    assert.equal(cache.isHistorySynced('d/x'), false);
    cache.markHistorySynced('d/x');
    assert.equal(cache.isHistorySynced('d/x'), true);
    cache.close();
  });
});

describe('inferUpdateKind', () => {
  it('labels address-change updates as TRANSFER and same-value as RENEW', () => {
    const prev = { op: 'NAME_FIRSTUPDATE', address: 'A', value: 'v1' };
    const transfer = { op: 'NAME_UPDATE', address: 'B', value: 'v1' };
    const renew = { op: 'NAME_UPDATE', address: 'A', value: 'v1' };
    const update = { op: 'NAME_UPDATE', address: 'A', value: 'v2' };
    assert.equal(inferUpdateKind(transfer, prev), 'TRANSFER');
    assert.equal(inferUpdateKind(renew, prev), 'RENEW');
    assert.equal(inferUpdateKind(update, prev), null);
  });
});
