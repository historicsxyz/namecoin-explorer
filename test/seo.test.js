'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { t } = require('../lib/i18n');
const {
  publicOrigin,
  requestPath,
  buildSeo,
  robotsTxt,
  sitemapXml,
  SITEMAP_PATHS,
} = require('../lib/seo');

function req(opts) {
  const headers = Object.assign({ host: '127.0.0.1:3100' }, opts && opts.headers);
  return {
    protocol: (opts && opts.protocol) || 'http',
    path: (opts && opts.path) || '/',
    originalUrl: (opts && opts.originalUrl) || (opts && opts.path) || '/',
    params: (opts && opts.params) || {},
    query: (opts && opts.query) || {},
    get: (h) => headers[String(h).toLowerCase()],
  };
}

function resLocals(page, lang) {
  const code = lang || 'en';
  return {
    locals: {
      page: page || '',
      lang: code,
      t: (key, vars) => t(code, key, vars),
    },
  };
}

describe('publicOrigin', () => {
  it('prefers NMC_PUBLIC_URL and strips a trailing slash', () => {
    assert.equal(
      publicOrigin(req(), { NMC_PUBLIC_URL: 'https://nmc.historics.xyz/' }),
      'https://nmc.historics.xyz',
    );
  });

  it('uses forwarded proto and host when the env is unset', () => {
    assert.equal(
      publicOrigin(req({
        headers: { 'x-forwarded-proto': 'https', 'x-forwarded-host': 'nmc.example.org' },
      }), {}),
      'https://nmc.example.org',
    );
  });
});

describe('requestPath', () => {
  it('drops a trailing slash except for root', () => {
    assert.equal(requestPath(req({ path: '/' })), '/');
    assert.equal(requestPath(req({ path: '/names/' })), '/names');
  });
});

describe('buildSeo', () => {
  it('sets a unique home title and WebSite JSON-LD', () => {
    const seo = buildSeo(req({ path: '/' }), resLocals('home'));
    assert.match(seo.title, /Namecoin Explorer/);
    assert.match(seo.title, /names/);
    assert.equal(seo.noindex, false);
    assert.match(seo.description, /Namecoin/);
    assert.match(seo.jsonLd, /WebSite/);
    assert.match(seo.jsonLd, /SearchAction/);
    assert.match(seo.jsonLd, /Organization/);
    assert.match(seo.jsonLd, /WebPage/);
    assert.equal(seo.canonical, 'http://127.0.0.1:3100/');
    assert.equal(seo.image, 'http://127.0.0.1:3100/og.png');
    assert.equal(seo.imageWidth, 1200);
    assert.equal(seo.imageHeight, 630);
  });

  it('titles a name page and marks API HTML noindex', () => {
    const name = buildSeo(
      req({ path: '/name/d%2Fbitcoin', params: { name: 'd/bitcoin' } }),
      resLocals('name'),
      { name: 'd/bitcoin' },
    );
    assert.equal(name.title, 'd/bitcoin · Namecoin Explorer');
    assert.match(name.description, /d\/bitcoin/);
    assert.match(name.jsonLd, /CreativeWork/);

    const api = buildSeo(req({ path: '/api/stats' }), resLocals('api'), { title: 'JSON API' });
    assert.equal(api.noindex, true);
    assert.match(api.title, /JSON API/);
  });

  it('noindexes search, pagination, OG, and 404; canonicalizes ns filters', () => {
    const search = buildSeo(req({ path: '/names', query: { q: 'bit' } }), resLocals('names'));
    assert.equal(search.noindex, true);
    assert.equal(search.canonical, 'http://127.0.0.1:3100/names');
    assert.match(search.title, /bit/);

    const page2 = buildSeo(req({ path: '/names', query: { start: 'd/foo' } }), resLocals('names'));
    assert.equal(page2.noindex, true);

    const ns = buildSeo(req({ path: '/names', query: { ns: 'd' } }), resLocals('names'));
    assert.equal(ns.canonical, 'http://127.0.0.1:3100/namespace/d');

    const og = buildSeo(req({ path: '/og' }), resLocals('og'));
    assert.equal(og.noindex, true);

    const missing = buildSeo(req({ path: '/nope' }), resLocals('error'));
    assert.equal(missing.noindex, true);
    assert.match(missing.title, /not found/i);

    const blocksQ = buildSeo(req({ path: '/blocks', query: { q: '808000' } }), resLocals('blocks'));
    assert.equal(blocksQ.noindex, true);
    assert.equal(blocksQ.canonical, 'http://127.0.0.1:3100/blocks');
    const blocksOps = buildSeo(req({ path: '/blocks', query: { ops: 'with' } }), resLocals('blocks'));
    assert.equal(blocksOps.noindex, true);
    const blocksPlain = buildSeo(req({ path: '/blocks' }), resLocals('blocks'));
    assert.equal(blocksPlain.noindex, false);
  });

  it('uses German copy when lang is de', () => {
    const seo = buildSeo(req({ path: '/stats' }), resLocals('stats', 'de'));
    assert.match(seo.title, /Statistik/);
    assert.match(seo.description, /Hashrate/);
    assert.equal(seo.locale, 'de_DE');
  });
});

describe('robots and sitemap', () => {
  it('disallows API and health, and lists landing pages only', () => {
    const robots = robotsTxt('https://nmc.historics.xyz');
    assert.match(robots, /Disallow: \/api\//);
    assert.match(robots, /Disallow: \/health/);
    assert.match(robots, /Sitemap: https:\/\/nmc\.historics\.xyz\/sitemap\.xml/);

    const xml = sitemapXml('https://nmc.historics.xyz', new Date('2026-08-24T00:00:00Z'));
    for (const entry of SITEMAP_PATHS) {
      assert.match(xml, new RegExp('<loc>https://nmc\\.historics\\.xyz' + entry.path.replace(/\//g, '\\/') + '</loc>'));
    }
    assert.match(xml, /xmlns:xhtml/);
    assert.match(xml, /hreflang="de"/);
    assert.match(xml, /<lastmod>2026-08-24<\/lastmod>/);
    assert.equal(xml.includes('/og'), false);
    assert.equal(xml.includes('/name/'), false);
    assert.equal(xml.includes('/api/'), false);
  });
});
