'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { wantsHtml } = require('../lib/api-json');

function req(accept, query) {
  return {
    query: query || {},
    get: (h) => (String(h).toLowerCase() === 'accept' ? accept : undefined),
  };
}

describe('wantsHtml', () => {
  it('is false with no Accept (curl, health probes)', () => {
    assert.equal(wantsHtml(req('')), false);
    assert.equal(wantsHtml(req(undefined)), false);
  });

  it('is false for application/json and */*', () => {
    assert.equal(wantsHtml(req('application/json')), false);
    assert.equal(wantsHtml(req('*/*')), false);
  });

  it('is true for a browser navigation Accept', () => {
    assert.equal(wantsHtml(req('text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8')), true);
  });

  it('prefers raw JSON when the client asks for it', () => {
    assert.equal(wantsHtml(req('text/html,application/json')), false);
    assert.equal(wantsHtml(req('text/html', { format: 'json' })), false);
    assert.equal(wantsHtml(req('text/html', { raw: '1' })), false);
  });
});
