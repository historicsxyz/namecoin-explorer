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
    assert.equal(decoded.kind, 'list');
    assert.equal(decoded.items.length, 4);
    assert.equal(decoded.items[0].isObject, true);
    assert.match(decoded.items[0].value, /"avatar"/);
    assert.doesNotMatch(decoded.items[0].value, /\\"/);
    assert.equal(decoded.items[1].isObject, false);
    assert.equal(decoded.items[1].value, 'reserved');
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
});
