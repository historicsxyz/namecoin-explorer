'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

let ejs;
try { ejs = require('ejs'); } catch { ejs = null; }

describe('EJS templates', { skip: !ejs && 'ejs not installed (npm install)' }, () => {
  const views = path.join(__dirname, '..', 'views');
  const locals = {
    t: (k) => k,
    nfmt: String,
    lang: 'en',
  };

  it('compile', () => {
    const files = fs.readdirSync(views).filter((f) => f.endsWith('.ejs'));
    assert.ok(files.length > 0);
    for (const f of files) {
      const filename = path.join(views, f);
      ejs.compile(fs.readFileSync(filename, 'utf8'), { filename });
    }
  });

  it('tx page shows indexed name ops when RPC is down', () => {
    const html = ejs.render(fs.readFileSync(path.join(views, 'tx.ejs'), 'utf8'), {
      ...locals,
      tx: null,
      fromCache: true,
      txid: 'dd0b27feb824bb13df13a8b013558469b92166abb39d8054333d62325ef653ce',
      nameOps: [{
        vout: 0, op: 'NAME_UPDATE', displayOp: 'NAME_UPDATE',
        name: 'd/our', value: '{}', height: 1, time: 1,
      }],
    }, { filename: path.join(views, 'tx.ejs') });
    assert.match(html, /tx\.cacheNote/);
    assert.match(html, /d\/our/);
    assert.match(html, /\/name\/d%2Four/);
    assert.doesNotMatch(html, /tx\.outputs/);
  });

  it('pending ops page shows the RPC error instead of an empty mempool', () => {
    const html = ejs.render(fs.readFileSync(path.join(views, 'operations-pending.ejs'), 'utf8'), {
      ...locals,
      error: 'connect ECONNREFUSED 127.0.0.1:18336',
      pending: [],
      mempoolInfo: null,
      now: Date.now(),
    }, { filename: path.join(views, 'operations-pending.ejs') });
    assert.match(html, /ECONNREFUSED/);
    assert.doesNotMatch(html, /opsPending\.empty/);
    assert.doesNotMatch(html, /<form/);
  });

  it('name page shows the indexed record when RPC is down', () => {
    const html = ejs.render(fs.readFileSync(path.join(views, 'name.ejs'), 'utf8'), {
      ...locals,
      name: 'd/our',
      fromCache: true,
      show: {
        name: 'd/our', value: '{}', address: 'Nowner',
        height: 100, expires_in: 1000, expired: 0, txid: 'ab'.repeat(32),
      },
      record: { updateTs: 1, expiresTs: 2, firstTs: 3, firstHeight: 50 },
      history: [{ opLabel: 'UPDATE', opType: 'NAME_UPDATE', height: 100, txid: 'ab'.repeat(32), address: 'Nowner' }],
      pending: [],
      decoded: { kind: 'text', raw: '{}' },
      expiryKind: () => 'live',
      fmtUtc: () => 'now',
      relDur: () => ({ future: false, t: '1d' }),
      shortId: (s) => String(s).slice(0, 8),
      renderValue: () => ({ kind: 'empty' }),
    }, { filename: path.join(views, 'name.ejs') });
    assert.match(html, /name\.cacheNote/);
    assert.match(html, /d\/our/);
    assert.doesNotMatch(html, /name\.noRecord/);
  });

  it('tx index notes a partial RPC fallback', () => {
    const html = ejs.render(fs.readFileSync(path.join(views, 'txs.ejs'), 'utf8'), {
      ...locals,
      q: '',
      invalid: false,
      usedFallback: false,
      partialFallback: true,
      groups: [
        { height: 2, hash: 'h2', time: 1, tx: ['aa'.repeat(32)] },
        { height: 1, hash: 'h1', time: 1, tx: ['bb'.repeat(32)], fromCache: true },
      ],
      fallback: [],
      opsByTxid: {},
    }, { filename: path.join(views, 'txs.ejs') });
    assert.match(html, /txs\.partialNote/);
    assert.doesNotMatch(html, /txs\.fallbackNote/);
    assert.match(html, /txs\.block/);
  });
});
