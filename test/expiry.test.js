'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  NAME_EXPIRY_DEPTH,
  SEMI_EXPIRE_WINDOW,
  expiresIn,
  isExpired,
  isSemiExpired,
  expiryStatus,
  parseNamespace,
} = require('../lib/expiry');

describe('expiry', () => {
  it('uses Core depths (36000 live, 4032 semi-expire)', () => {
    assert.equal(NAME_EXPIRY_DEPTH, 36000);
    assert.equal(SEMI_EXPIRE_WINDOW, 4032);
  });

  it('computes live / expiring / expired at a given tip', () => {
    assert.equal(expiresIn(1000, 1000), 36000);
    assert.equal(expiryStatus(1000, 1000), 'live');
    assert.equal(isExpired(1000, 1000), false);

    const semiTip = 1000 + (36000 - 4032);
    assert.equal(expiresIn(1000, semiTip), 4032);
    assert.equal(isSemiExpired(1000, semiTip), true);
    assert.equal(expiryStatus(1000, semiTip), 'expiring');

    assert.equal(expiresIn(1000, 37000), 0);
    assert.equal(isExpired(1000, 37001), true);
    assert.equal(expiryStatus(1000, 37001), 'expired');
  });
});

describe('parseNamespace', () => {
  it('treats d/ and id/ as application prefixes', () => {
    assert.deepEqual(parseNamespace('d/bitcoin'), { prefix: 'd', namespace: 'd/', full: 'd/bitcoin' });
    assert.equal(parseNamespace('id/example').namespace, 'id/');
  });

  it('uses (root) when there is no slash', () => {
    assert.equal(parseNamespace('bare').namespace, '(root)');
    assert.equal(parseNamespace(null).namespace, '(root)');
  });
});
