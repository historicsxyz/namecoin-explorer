'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  parseTxOps,
  parseTxRange,
  filterTxGroups,
  nameOpTxQuery,
  rangeExceedsWindow,
  countListedTxs,
} = require('../lib/txfilters');

describe('txfilters', () => {
  it('parses name-op and time-range query params', () => {
    assert.deepEqual(parseTxOps(''), { ops: null, invalid: false });
    assert.equal(parseTxOps('with').ops, 'with');
    assert.equal(parseTxOps('2+').ops, 'busy');
    assert.equal(parseTxOps('NAME_UPDATE').ops, 'NAME_UPDATE');
    assert.equal(parseTxOps('nope').invalid, true);
    const r = parseTxRange('24h', 1_000_000);
    assert.equal(r.range, '24h');
    assert.equal(r.since, 1_000_000 - 86400);
    assert.equal(parseTxRange('nope').invalid, true);
  });

  it('filters grouped txs by name-op count and time', () => {
    const groups = [
      { height: 2, time: 200, tx: ['aa', 'bb'] },
      { height: 1, time: 50, tx: ['cc'] },
    ];
    const opsByTxid = {
      aa: [{ op: 'NAME_UPDATE' }],
      bb: [{ op: 'NAME_UPDATE' }, { op: 'NAME_UPDATE' }],
    };
    const withOps = filterTxGroups(groups, { ops: 'with', opsByTxid });
    assert.deepEqual(withOps.map((g) => g.tx), [['aa', 'bb']]);
    const busy = filterTxGroups(groups, { ops: 'busy', opsByTxid });
    assert.deepEqual(busy.map((g) => g.tx), [['bb']]);
    const none = filterTxGroups(groups, { ops: 'none', opsByTxid });
    assert.deepEqual(none.map((g) => g.tx), [['cc']]);
    const recent = filterTxGroups(groups, { since: 100, opsByTxid });
    assert.equal(recent.length, 1);
    assert.equal(recent[0].height, 2);
  });

  it('builds an index query and detects a range past the RPC window', () => {
    assert.deepEqual(nameOpTxQuery('busy', 9, 40), {
      minOps: 2, since: 9, op: null, hideCommitments: true, limit: 40,
    });
    assert.equal(nameOpTxQuery('NAME_UPDATE').op, 'NAME_UPDATE');
    assert.equal(rangeExceedsWindow(10, [{ time: 20 }]), true);
    assert.equal(rangeExceedsWindow(10, [{ time: 5 }]), false);
    assert.equal(countListedTxs([{ tx: ['a', 'b'] }], [{ txid: 'c' }]), 3);
  });
});
