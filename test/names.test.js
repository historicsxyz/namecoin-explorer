'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { classifyValue, renderValue } = require('../lib/names');

describe('classifyValue / renderValue', () => {
  it('keeps DNS map objects as a json table', () => {
    const rec = { value: '{"map":{"":"1.2.3.4","www":{"ip":"1.2.3.4"}}}' };
    const decoded = renderValue(rec);
    assert.equal(decoded.kind, 'json');
    assert.equal(decoded.table[0].label, '(default)');
    assert.equal(decoded.table[0].value, '1.2.3.4');
    assert.equal(decoded.table[1].isObject, true);
  });

  it('unwraps JSON arrays whose items are string-encoded objects', () => {
    const value = JSON.stringify([
      '{"avatar":{"url":"https://example.com/a.png"}}',
      'reserved',
      'BM-2cUbTezXC3TyUFXwUA7gY4AfMKXQ7YG4wm',
      '{"avatar":{"url":"https://example.com/a.png"}}',
    ]);
    const cls = classifyValue(value);
    assert.equal(cls.type, 'json');
    assert.ok(Array.isArray(cls.parsed));
    assert.equal(typeof cls.parsed[0], 'object');
    assert.equal(cls.parsed[0].avatar.url, 'https://example.com/a.png');
    assert.equal(cls.parsed[1], 'reserved');

    const decoded = renderValue({ value });
    assert.equal(decoded.kind, 'json');
    const parsed = JSON.parse(decoded.raw);
    assert.equal(parsed.length, 4);
    assert.equal(parsed[0].avatar.url, 'https://example.com/a.png');
    assert.equal(parsed[1], 'reserved');
    assert.match(decoded.raw, /"avatar"/);
    assert.doesNotMatch(decoded.raw, /\\"/);
    assert.match(decoded.raw, /reserved/);
  });

  it('unwraps quote-wrapped and double-encoded JSON objects', () => {
    const inner = '{"ip":"1.2.3.4"}';
    const decoded = renderValue({ value: `'${inner}'` });
    assert.equal(decoded.kind, 'json');
    assert.equal(decoded.table[0].label, 'ip');
    assert.equal(decoded.table[0].value, '1.2.3.4');

    const twice = JSON.stringify(inner);
    const again = renderValue({ value: twice });
    assert.equal(again.kind, 'json');
    assert.equal(again.table[0].value, '1.2.3.4');
  });

  it('keeps the closing brace in pretty JSON for a simple object', () => {
    const decoded = renderValue({ value: '{ "info" : "The Church of Bitcoin." }' });
    assert.equal(decoded.kind, 'json');
    assert.match(decoded.raw, /Church of Bitcoin/);
    assert.match(decoded.raw, /\}$/);
    assert.equal(decoded.table[0].label, 'info');
  });
});

describe('showFromCache', () => {
  it('maps an indexed name row to a name_show-shaped record', () => {
    const { showFromCache } = require('../lib/names');
    assert.equal(showFromCache(null), null);
    const show = showFromCache({
      name: 'd/our',
      value: '{}',
      address: 'N1',
      height: 100,
      expires_in: 2000,
      expired: 0,
    }, { txid: 'ab'.repeat(32) });
    assert.equal(show.name, 'd/our');
    assert.equal(show.txid, 'ab'.repeat(32));
    assert.equal(show.expired, false);
    assert.equal(showFromCache({ name: 'd/x', expired: 1 }).txid, null);
  });
});

describe('loadNameRecord', () => {
  it('falls back to the index when name_show fails', async () => {
    const { loadNameRecord } = require('../lib/names');
    const { NameCache } = require('../lib/cache');
    const cache = new NameCache(':memory:');
    cache.upsertNameRecord({ name: 'd/our', value: '{}', address: 'N1', height: 10 }, 10);
    const rpc = { nameShow: async () => { throw new Error('ECONNREFUSED'); } };
    const hit = await loadNameRecord(rpc, cache, 'd/our');
    assert.equal(hit.fromCache, true);
    assert.equal(hit.show.name, 'd/our');
    const miss = await loadNameRecord(rpc, cache, 'd/missing');
    assert.equal(miss.show, null);
    assert.match(miss.error, /ECONNREFUSED/);
    cache.close();
  });
});
