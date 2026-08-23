'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { ingestOptionsFromEnv } = require('../lib/ingest');
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

describe('i18n', () => {
  it('falls back to English and interpolates', () => {
    assert.equal(t('en', 'nav.home'), 'Explorer');
    assert.equal(t('de', 'nav.home'), 'Explorer');
    assert.equal(t('xx', 'nav.home'), 'Explorer');
    assert.match(t('en', 'ops.chainTip', { n: 12 }), /12/);
  });

  it('picks lang from query then Accept-Language', () => {
    assert.equal(pickLang('de', 'en-US,en;q=0.9'), 'de');
    assert.equal(pickLang(undefined, 'de-DE,de;q=0.9,en;q=0.8'), 'de');
    assert.equal(pickLang('zz', 'fr-FR'), 'en');
  });
});
