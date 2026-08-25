'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { NameCache } = require('../lib/cache');
const { looksLikeAddress, classifyQuery, lookupItems, pickEnterHref } = require('../lib/search');

describe('classifyQuery', () => {
  it('detects height, 64-hex, address, and name', () => {
    assert.equal(classifyQuery('808000').kind, 'height');
    assert.equal(classifyQuery('808000').value, 808000);
    const hex = 'ab'.repeat(32);
    assert.equal(classifyQuery(hex).kind, 'hex64');
    assert.equal(classifyQuery('0x' + hex).value, hex);
    assert.equal(looksLikeAddress('Nxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx'), true);
    assert.equal(classifyQuery('nc1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq').kind, 'address');
    assert.equal(classifyQuery('d/bitcoin').kind, 'name');
    assert.equal(classifyQuery('').kind, null);
  });
});

describe('lookupItems', () => {
  it('returns a block jump for a known height and names after', async () => {
    const cache = new NameCache(':memory:');
    cache.insertBlock({
      header: { height: 12, hash: 'hh', time: 1, prev: '00', ntx: 1, merkle: 'mm' },
      ops: [],
      tipHeight: 12,
    });
    cache.setTip(12, 'hh');
    cache.upsertNameRecord({ name: 'd/12foo', value: '{}', address: 'Nabcdefghijklmnopqrstuvwxyzabcde', height: 12 }, 12);
    const items = await lookupItems('12', { cache, limit: 12 });
    assert.equal(items[0].kind, 'block');
    assert.equal(items[0].href, '/block/12');
    assert.ok(items.some((i) => i.kind === 'name' && i.name === 'd/12foo'));
    cache.close();
  });

  it('prefers a tx jump for an indexed txid', async () => {
    const cache = new NameCache(':memory:');
    const txid = 'cd'.repeat(32);
    cache.insertBlock({
      header: { height: 1, hash: 'h1', time: 1, prev: '00', ntx: 1, merkle: 'mm' },
      ops: [{
        txid,
        vout: 0,
        op: 'NAME_FIRSTUPDATE',
        name: 'd/x',
        nameHex: Buffer.from('d/x').toString('hex'),
        value: '{}',
        address: 'N1',
      }],
      tipHeight: 1,
    });
    const items = await lookupItems(txid, { cache });
    assert.equal(items[0].kind, 'tx');
    assert.equal(items[0].href, '/tx/' + txid);
    cache.close();
  });
});

describe('pickEnterHref', () => {
  it('uses the unique exact jump, else names search', () => {
    assert.equal(pickEnterHref([{ kind: 'block', href: '/block/9', exact: true }], '9'), '/block/9');
    assert.equal(pickEnterHref([], 'd/bit'), '/names?q=d%2Fbit');
    assert.equal(pickEnterHref([], 'ab'.repeat(32)), '/tx/' + 'ab'.repeat(32));
  });
});
