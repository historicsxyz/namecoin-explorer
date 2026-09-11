'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { t } = require('../lib/i18n');
const {
  publicOrigin,
  requestPath,
  canonicalRedirect,
  dnsLabel,
  buildSeo,
  robotsTxt,
  sitemapXml,
  sitemapIndexXml,
  sitemapNamesXml,
  SITEMAP_PATHS,
  SITEMAP_NAME_LIMIT,
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
      publicOrigin(req(), { NMC_PUBLIC_URL: 'https://explorer.namecoin.co/' }),
      'https://explorer.namecoin.co',
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

describe('canonicalRedirect', () => {
  it('301s alias hosts to NMC_PUBLIC_URL and skips loopback and health', () => {
    const env = { NMC_PUBLIC_URL: 'https://explorer.namecoin.co' };
    let dest = null;
    const res = {
      set() {},
      redirect(code, url) { dest = { code, url }; },
    };
    let nextCalled = false;
    canonicalRedirect(
      req({
        headers: { host: 'nmc.historics.xyz', 'x-forwarded-host': 'nmc.historics.xyz' },
        path: '/names',
        originalUrl: '/names?status=live',
      }),
      res,
      () => { nextCalled = true; },
      env,
    );
    assert.equal(nextCalled, false);
    assert.deepEqual(dest, { code: 301, url: 'https://explorer.namecoin.co/names?status=live' });

    dest = null;
    nextCalled = false;
    canonicalRedirect(req({ path: '/' }), res, () => { nextCalled = true; }, env);
    assert.equal(nextCalled, true);
    assert.equal(dest, null);

    dest = null;
    nextCalled = false;
    canonicalRedirect(
      req({
        headers: { host: 'nmc.historics.xyz' },
        path: '/health',
        originalUrl: '/health',
      }),
      res,
      () => { nextCalled = true; },
      env,
    );
    assert.equal(nextCalled, true);
    assert.equal(dest, null);

    dest = null;
    nextCalled = false;
    canonicalRedirect(
      req({ headers: { host: 'explorer.namecoin.co' }, path: '/', originalUrl: '/' }),
      res,
      () => { nextCalled = true; },
      env,
    );
    assert.equal(nextCalled, true);
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
    assert.match(seo.jsonLd, /slogan/);
    assert.equal(seo.jsonLd.includes('SearchAction'), false);
    assert.match(seo.jsonLd, /Organization/);
    assert.match(seo.jsonLd, /WebPage/);
    const org = JSON.parse(seo.jsonLd)['@graph'].find((n) => n['@type'] === 'Organization');
    assert.equal(org.name, 'Namecoin Explorer');
    assert.equal(org.url, 'http://127.0.0.1:3100/');
    assert.equal(seo.canonical, 'http://127.0.0.1:3100/');
    assert.equal(seo.image, 'http://127.0.0.1:3100/og.png');
    assert.equal(seo.imageWidth, 1200);
    assert.equal(seo.imageHeight, 630);
    assert.deepEqual(seo.hreflang, []);
  });

  it('titles a name page and marks API HTML noindex nofollow', () => {
    assert.equal(dnsLabel('d/bitcoin'), 'bitcoin.bit');
    const name = buildSeo(
      req({ path: '/name/d%2Fbitcoin', params: { name: 'd/bitcoin' } }),
      resLocals('name'),
      { name: 'd/bitcoin' },
    );
    assert.equal(name.title, 'bitcoin.bit · d/bitcoin · Namecoin Explorer');
    assert.match(name.description, /bitcoin\.bit/);
    assert.match(name.jsonLd, /CreativeWork/);
    assert.match(name.jsonLd, /bitcoin\.bit/);

    const expired = buildSeo(
      req({ path: '/name/d%2Fbitcoin', params: { name: 'd/bitcoin' } }),
      resLocals('name'),
      { name: 'd/bitcoin', show: { expired: true } },
    );
    assert.equal(expired.title, 'bitcoin.bit · d/bitcoin · expired · Namecoin Explorer');

    const api = buildSeo(req({ path: '/api/stats' }), resLocals('api'), { title: 'JSON API' });
    assert.equal(api.noindex, true);
    assert.equal(api.nofollow, true);
    assert.match(api.title, /JSON API/);
  });

  it('noindexes search, pagination, OG, and 404; canonicalizes ns filters', () => {
    const search = buildSeo(req({ path: '/names', query: { q: 'bit' } }), resLocals('names'));
    assert.equal(search.noindex, true);
    assert.equal(search.nofollow, false);
    assert.equal(search.canonical, 'http://127.0.0.1:3100/names');
    assert.match(search.title, /bit/);

    const page2 = buildSeo(req({ path: '/names', query: { start: 'd/foo' } }), resLocals('names'));
    assert.equal(page2.noindex, true);
    assert.equal(page2.nofollow, false);
    const afterPage = buildSeo(req({ path: '/names', query: { after: '100:d/foo' } }), resLocals('names'));
    assert.equal(afterPage.noindex, true);
    assert.equal(afterPage.nofollow, false);

    const ns = buildSeo(req({ path: '/names', query: { ns: 'd' } }), resLocals('names'));
    assert.equal(ns.canonical, 'http://127.0.0.1:3100/namespace/d');

    const og = buildSeo(req({ path: '/og' }), resLocals('og'));
    assert.equal(og.noindex, true);
    assert.equal(og.nofollow, true);

    const missing = buildSeo(req({ path: '/nope' }), resLocals('error'));
    assert.equal(missing.noindex, true);
    assert.equal(missing.nofollow, true);
    assert.match(missing.title, /not found/i);

    const blocksQ = buildSeo(req({ path: '/blocks', query: { q: '808000' } }), resLocals('blocks'));
    assert.equal(blocksQ.noindex, true);
    assert.equal(blocksQ.nofollow, false);
    assert.equal(blocksQ.canonical, 'http://127.0.0.1:3100/blocks');
    const blocksOps = buildSeo(req({ path: '/blocks', query: { ops: 'with' } }), resLocals('blocks'));
    assert.equal(blocksOps.noindex, true);
    const blocksPlain = buildSeo(req({ path: '/blocks' }), resLocals('blocks'));
    assert.equal(blocksPlain.noindex, false);

    const nsIndex = buildSeo(req({ path: '/namespaces' }), resLocals('namespace'));
    assert.match(nsIndex.title, /Namespaces/);
    const nsPage = buildSeo(
      req({ path: '/namespace/d', params: { ns: 'd' } }),
      resLocals('namespace'),
      { ns: 'd' },
    );
    assert.match(nsPage.title, /d\//);
    assert.match(nsPage.jsonLd, /\/namespaces/);

    const txIndex = buildSeo(req({ path: '/tx' }), resLocals('txs'));
    assert.match(txIndex.title, /Transactions/);
    const addrIndex = buildSeo(req({ path: '/addresses' }), resLocals('address'));
    assert.match(addrIndex.title, /Addresses/);
    const addrPage = buildSeo(
      req({ path: '/address/Nabc', params: { addr: 'Nabc' } }),
      resLocals('address'),
      { addr: 'Nabc' },
    );
    assert.match(addrPage.title, /Nabc/);
  });

  it('uses German copy when lang is de', () => {
    const seo = buildSeo(req({ path: '/stats' }), resLocals('stats', 'de'));
    assert.match(seo.title, /Statistik/);
    assert.match(seo.description, /Hashrate/);
    assert.equal(seo.locale, 'de_DE');
    const expired = buildSeo(
      req({ path: '/name/d%2Fbitcoin', params: { name: 'd/bitcoin' } }),
      resLocals('name', 'de'),
      { name: 'd/bitcoin', show: { expired: true } },
    );
    assert.match(expired.title, /abgelaufen/);
  });
});

describe('robots and sitemap', () => {
  it('disallows API and health, and indexes hubs plus live-name shards', () => {
    const robots = robotsTxt('https://explorer.namecoin.co');
    assert.match(robots, /Disallow: \/api\//);
    assert.match(robots, /Disallow: \/health/);
    assert.match(robots, /Sitemap: https:\/\/explorer\.namecoin\.co\/sitemap\.xml/);

    const hubs = sitemapXml('https://explorer.namecoin.co', new Date('2026-08-24T00:00:00Z'));
    for (const entry of SITEMAP_PATHS) {
      assert.match(hubs, new RegExp('<loc>https://explorer\\.namecoin\\.co' + entry.path.replace(/\//g, '\\/') + '</loc>'));
    }
    assert.equal(hubs.includes('xmlns:xhtml'), false);
    assert.equal(hubs.includes('hreflang'), false);
    assert.match(hubs, /<lastmod>2026-08-24<\/lastmod>/);
    assert.equal(hubs.includes('/og'), false);
    assert.equal(hubs.includes('/name/'), false);
    assert.equal(hubs.includes('/api/'), false);

    const index = sitemapIndexXml('https://explorer.namecoin.co', 50001, new Date('2026-08-24T00:00:00Z'));
    assert.match(index, /<sitemapindex /);
    assert.match(index, /https:\/\/explorer\.namecoin\.co\/sitemap\/hubs\.xml/);
    assert.match(index, /https:\/\/explorer\.namecoin\.co\/sitemap\/names-1\.xml/);
    assert.match(index, /https:\/\/explorer\.namecoin\.co\/sitemap\/names-2\.xml/);
    assert.equal(index.includes('names-3.xml'), false);
    assert.equal(SITEMAP_NAME_LIMIT, 50000);

    const names = sitemapNamesXml('https://explorer.namecoin.co', ['d/bitcoin', 'id/alice']);
    assert.match(names, /<loc>https:\/\/explorer\.namecoin\.co\/name\/d%2Fbitcoin<\/loc>/);
    assert.match(names, /<loc>https:\/\/explorer\.namecoin\.co\/name\/id%2Falice<\/loc>/);
  });
});
