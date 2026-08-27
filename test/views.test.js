'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

let ejs;
try { ejs = require('ejs'); } catch { ejs = null; }

const { renderValue, valuePreview } = require('../lib/names');
const { fmtNmc } = require('../lib/chainmetrics');

describe('EJS templates', { skip: !ejs && 'ejs not installed (npm install)' }, () => {
  const views = path.join(__dirname, '..', 'views');
  const locals = {
    t: (k) => k,
    nfmt: String,
    lang: 'en',
    renderValue,
    valuePreview,
    fmtNmc,
    fmtUtc: () => 'now UTC',
    relDur: () => ({ future: false, t: '1d' }),
    shortId: (s) => String(s).slice(0, 8),
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
    assert.match(html, /name\.decoded/);
    assert.doesNotMatch(html, /tx\.outputs/);
  });

  it('tx page lists coinbase and spent outpoints', () => {
    const html = ejs.render(fs.readFileSync(path.join(views, 'tx.ejs'), 'utf8'), {
      ...locals,
      shortId: (s) => String(s).slice(0, 8),
      tx: {
        txid: 'aa'.repeat(32),
        confirmations: 3,
        vin: [
          { coinbase: '04ffff' },
          { txid: 'bb'.repeat(32), vout: 1 },
        ],
        vout: [{ value: 6.25, scriptPubKey: { type: 'pubkeyhash', address: 'N1' } }],
      },
      nameOps: [],
      fromCache: false,
      txid: 'aa'.repeat(32),
    }, { filename: path.join(views, 'tx.ejs') });
    assert.match(html, /tx\.inputs/);
    assert.match(html, /tx\.coinbase/);
    assert.match(html, /\/tx\/bb/);
    assert.match(html, /:1/);
    assert.match(html, /6\.25 NMC/);
  });

  it('block page shows next, size, difficulty, and Bitcoin parent', () => {
    const html = ejs.render(fs.readFileSync(path.join(views, 'block.ejs'), 'utf8'), {
      ...locals,
      formatDifficulty: (d) => String(d),
      bytesOnDisk: (n) => n + ' B',
      fromCache: false,
      block: {
        hash: 'aa'.repeat(32),
        height: 100,
        time: 1,
        previousblockhash: 'bb'.repeat(32),
        nextblockhash: 'cc'.repeat(32),
        nTx: 1,
        size: 1400,
        weight: 4000,
        difficulty: 12,
        bits: '1d00ffff',
        version: 1,
        merkleroot: 'dd'.repeat(32),
        nonce: 1,
        _nameOpCount: 0,
        _coinbaseNmc: 6.25,
        _parentBitcoinHash: '00'.repeat(32),
        tx: [{ txid: 'ee'.repeat(32), vin: [{ coinbase: '00' }], vout: [{}], _nameOps: [] }],
      },
    }, { filename: path.join(views, 'block.ejs') });
    assert.match(html, /block\.next/);
    assert.match(html, /\/block\/cc/);
    assert.match(html, /block\.size/);
    assert.match(html, /1400 B/);
    assert.match(html, /block\.difficulty/);
    assert.match(html, /block\.bitcoinParent/);
    assert.match(html, /block\.coinbase/);
    assert.doesNotMatch(html, /block\.cacheNote/);
  });

  it('block page falls back to the index without inventing a full tx list', () => {
    const html = ejs.render(fs.readFileSync(path.join(views, 'block.ejs'), 'utf8'), {
      ...locals,
      formatDifficulty: (d) => String(d),
      bytesOnDisk: (n) => String(n),
      fromCache: true,
      block: {
        hash: 'h10',
        height: 10,
        time: 1,
        previousblockhash: '00',
        nTx: 2,
        merkleroot: 'mm',
        difficulty: 1,
        _nameOpCount: 1,
        _indexOnly: true,
        tx: [{ txid: 'tt', vin: null, vout: null, _nameOps: [{ op: 'NAME_UPDATE', name: 'd/our', value: '{}' }] }],
      },
    }, { filename: path.join(views, 'block.ejs') });
    assert.match(html, /block\.cacheNote/);
    assert.match(html, /d\/our/);
    assert.match(html, />—</);
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

  it('name value defaults to on-chain raw and keeps decoded fields behind a toggle', () => {
    const html = ejs.render(fs.readFileSync(path.join(views, 'includes/_value.ejs'), 'utf8'), {
      ...locals,
      fallback: '{"ip":"1.2.3.4"}',
      decoded: {
        kind: 'json',
        table: [
          { label: 'ip', value: '1.2.3.4', isObject: false },
          { label: 'www', value: '{\n  "ip": "1.2.3.4"\n}', isObject: true },
        ],
        raw: '{\n  "ip": "1.2.3.4"\n}',
      },
    }, { filename: path.join(views, 'includes/_value.ejs') });
    assert.match(html, /<dt>ip<\/dt>/);
    assert.match(html, /1\.2\.3\.4/);
    assert.match(html, /name\.decoded/);
    assert.match(html, /name\.raw/);
    assert.match(html, /data-mode="raw"/);
    assert.match(html, /data-value-pane="raw"/);
    assert.match(html, /data-value-pane="raw"[\s\S]*\{&#34;ip&#34;:&#34;1\.2\.3\.4&#34;\}/);
    assert.doesNotMatch(html, /<details/);
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

  it('tx index filterbar lists name-op and time-range controls', () => {
    const html = ejs.render(fs.readFileSync(path.join(views, 'txs.ejs'), 'utf8'), {
      ...locals,
      q: '',
      invalid: false,
      ops: 'with',
      range: '24h',
      matching: 2,
      usedFallback: true,
      indexRange: false,
      rangeLimited: false,
      noneNeedsRpc: false,
      groups: [],
      fallback: [
        { txid: 'aa'.repeat(32), height: 9, time: 1, nameOps: 1 },
      ],
      opsByTxid: {},
    }, { filename: path.join(views, 'txs.ejs') });
    assert.match(html, /txs\.withOps/);
    assert.match(html, /txs\.range24h/);
    assert.match(html, /txs\.matching/);
    assert.match(html, /name="ops"/);
    assert.match(html, /name="range"/);
  });

  it('blocks filterbar lists name-op and time-range controls', () => {
    const html = ejs.render(fs.readFileSync(path.join(views, 'blocks.ejs'), 'utf8'), {
      ...locals,
      q: '',
      ops: 'with',
      range: '24h',
      height: 100,
      maxHeight: null,
      blocks: [],
      pager: { total: 3, page: 1, pages: 1, prevHref: null, nextHref: null },
    }, { filename: path.join(views, 'blocks.ejs') });
    assert.match(html, /blocks\.withOps/);
    assert.match(html, /blocks\.range24h/);
    assert.match(html, /blocks\.matching/);
    assert.match(html, /name="ops"/);
    assert.match(html, /name="range"/);
    assert.match(html, /blocks\.clear/);
  });

  it('address empty state says names are not a coin balance', () => {
    const html = ejs.render(fs.readFileSync(path.join(views, 'address.ejs'), 'utf8'), {
      ...locals,
      addr: 'N1',
      seen: false,
      names: [],
      ops: [],
    }, { filename: path.join(views, 'address.ejs') });
    assert.match(html, /address\.empty/);
    assert.doesNotMatch(html, /address\.note/);
  });
});
