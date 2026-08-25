'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { NameCache, sqliteBackendError } = require('../lib/cache');
const { inferUpdateKind } = require('../lib/names');
const { HEX_OPTS, SHOW_OPTS } = require('../lib/rpc');

describe('rpc encodings', () => {
  it('sends Core nameEncoding / valueEncoding hex options', () => {
    assert.equal(JSON.stringify(HEX_OPTS), '{"nameEncoding":"hex","valueEncoding":"hex"}');
    assert.equal(SHOW_OPTS.allowExpired, true);
  });
});

describe('sqliteBackendError', () => {
  it('names both backends instead of leaking ERR_UNKNOWN_BUILTIN_MODULE', () => {
    const err = sqliteBackendError(
      new Error('NODE_MODULE_VERSION 147 vs 115'),
      Object.assign(new Error('No such built-in module: node:sqlite'), { code: 'ERR_UNKNOWN_BUILTIN_MODULE' }),
    );
    assert.match(err.message, /better-sqlite3 failed to load/);
    assert.match(err.message, /node:sqlite needs Node ≥ 22\.5/);
    assert.match(err.message, /npm rebuild better-sqlite3/);
    assert.equal(err.cause.message, 'NODE_MODULE_VERSION 147 vs 115');
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
    assert.equal(cache.txidSeen('tt'), true);
    assert.equal(cache.txidSeen('nope'), false);
    const byTx = cache.opsForTxids(['tt', 'nope']);
    assert.equal(byTx.tt.length, 1);
    assert.equal(byTx.tt[0].op, 'NAME_FIRSTUPDATE');
    assert.equal(byTx.nope, undefined);
    const byAddr = cache.opsByAddress('N1');
    assert.equal(byAddr.length, 1);
    assert.equal(byAddr[0].name, 'd/x');
    assert.equal(cache.isHistorySynced('d/x'), false);
    cache.markHistorySynced('d/x');
    assert.equal(cache.isHistorySynced('d/x'), true);
    cache.close();
  });

  it('ranks addresses by live names using tip-overlay expiry', () => {
    const cache = new NameCache(':memory:');
    cache.upsertNameRecord({ name: 'd/a', value: '{}', address: 'Nbig', height: 37000 }, 37000);
    cache.upsertNameRecord({ name: 'd/b', value: '{}', address: 'Nbig', height: 37000 }, 37000);
    cache.upsertNameRecord({ name: 'd/c', value: '{}', address: 'Nsmall', height: 37000 }, 37000);
    cache.upsertNameRecord({ name: 'd/old', value: '{}', address: 'Nbig', height: 1 }, 1);
    cache.upsertNameRecord({ name: 'd/blank', value: '{}', address: '', height: 37000 }, 37000);
    cache.setTip(37001, 'x');
    const top = cache.topAddresses(10);
    assert.equal(top[0].address, 'Nbig');
    assert.equal(Number(top[0].live), 2);
    assert.equal(Number(top[0].expired), 1);
    assert.equal(Number(top[0].total), 3);
    assert.equal(top[1].address, 'Nsmall');
    assert.equal(Number(top[1].live), 1);
    assert.equal(top.some((r) => r.address === ''), false);
    assert.equal(cache.countAddresses(), 2);
    const names = cache.namesByAddress('Nbig');
    assert.equal(names.length, 3);
    assert.ok(cache.addressSeen('Nbig'));
    assert.equal(cache.addressSeen('Nnobody'), false);
    cache.close();
  });

  it('pages headers and counts name ops per height', () => {
    const cache = new NameCache(':memory:');
    for (let h = 1; h <= 25; h++) {
      cache.insertBlock({
        header: { height: h, hash: 'h' + h, time: h, prev: 'p' + h, ntx: 1, merkle: 'm' },
        ops: h % 5 === 0 ? [{
          txid: 'tx' + h, vout: 0, op: 'NAME_UPDATE', name: 'd/x',
          nameHex: Buffer.from('d/x').toString('hex'), value: '{}', address: 'A',
        }, {
          txid: 'new' + h, vout: 0, op: 'NAME_NEW', name: null, nameHex: null, value: 'aa', address: 'A',
        }] : [],
        tipHeight: h,
      });
    }
    assert.equal(cache.headerCount(), 25);
    const page1 = cache.latestHeaders(20);
    assert.equal(page1.length, 20);
    assert.equal(page1[0].height, 25);
    assert.equal(page1[19].height, 6);
    const page2 = cache.latestHeaders(20, 20);
    assert.equal(page2.length, 5);
    assert.equal(page2[0].height, 5);
    const counts = cache.opCountsByHeight(page1.map((b) => b.height));
    assert.equal(counts.get(25), 1);
    assert.equal(counts.get(20), 1);
    assert.equal(counts.has(24), false);
    assert.equal(cache.opCountsByHeight([25], { hideCommitments: false }).get(25), 2);
    assert.equal(cache.opsAtHeight(25, { hideCommitments: false }).length, 2);

    const from10 = cache.pageHeaders({ maxHeight: 10, limit: 5 });
    assert.equal(from10.map((b) => b.height).join(','), '10,9,8,7,6');
    assert.equal(cache.countHeaders({ maxHeight: 10 }), 10);
    assert.equal(cache.headerByHash('h25').height, 25);

    const withOps = cache.pageHeaders({ ops: 'with', limit: 20 });
    assert.equal(withOps.map((b) => b.height).join(','), '25,20,15,10,5');
    assert.equal(cache.countHeaders({ ops: 'none' }), 20);
    assert.equal(cache.pageHeaders({ ops: 'NAME_UPDATE', limit: 3 })[0].height, 25);
    assert.equal(cache.pageHeaders({ hashPrefix: 'h2', limit: 20 }).map((b) => b.height).join(','), '25,24,23,22,21,20,2');
    cache.close();
  });

  it('filters headers by busy name-op counts', () => {
    const cache = new NameCache(':memory:');
    for (let h = 1; h <= 3; h++) {
      const ops = h === 3
        ? Array.from({ length: 10 }, (_, i) => ({
          txid: 'u' + i, vout: 0, op: 'NAME_UPDATE', name: 'd/x',
          nameHex: Buffer.from('d/x').toString('hex'), value: '{}', address: 'A',
        }))
        : [{
          txid: 'one' + h, vout: 0, op: 'NAME_UPDATE', name: 'd/x',
          nameHex: Buffer.from('d/x').toString('hex'), value: '{}', address: 'A',
        }];
      cache.insertBlock({
        header: { height: h, hash: 'h' + h, time: h, prev: 'p', ntx: ops.length, merkle: 'm' },
        ops,
        tipHeight: h,
      });
    }
    assert.equal(cache.countHeaders({ ops: 'busy' }), 1);
    assert.equal(cache.pageHeaders({ ops: 'busy', limit: 5 })[0].height, 3);
    assert.equal(cache.countHeaders({ maxHeight: 20, ops: 'with' }), 3);
    cache.close();
  });

  it('pages recent ops without loading the full feed', () => {
    const cache = new NameCache(':memory:');
    for (let h = 1; h <= 6; h++) {
      cache.insertBlock({
        header: { height: h, hash: 'h' + h, time: h, prev: 'p', ntx: 1, merkle: 'm' },
        ops: [{
          txid: 'u' + h, vout: 0, op: 'NAME_UPDATE', name: 'd/a',
          nameHex: Buffer.from('d/a').toString('hex'), value: '{}', address: 'A',
        }, {
          txid: 'n' + h, vout: 0, op: 'NAME_NEW', name: null, nameHex: null, value: 'aa', address: 'A',
        }],
        tipHeight: h,
      });
    }
    assert.equal(cache.countRecentOps(), 6);
    assert.equal(cache.countRecentOps({ hideCommitments: false }), 12);
    assert.equal(cache.countRecentOps({ op: 'NAME_UPDATE' }), 6);
    const page1 = cache.recentOps({ limit: 4 });
    assert.equal(page1.length, 4);
    assert.equal(page1[0].height, 6);
    assert.equal(page1[0].op, 'NAME_UPDATE');
    const page2 = cache.recentOps({ limit: 4, offset: 4 });
    assert.equal(page2.length, 2);
    assert.equal(page2[0].height, 2);
    assert.equal(page2[1].height, 1);
    const news = cache.recentOps({ op: 'NAME_NEW', limit: 2, offset: 2 });
    assert.equal(news.length, 2);
    assert.equal(news[0].op, 'NAME_NEW');
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
