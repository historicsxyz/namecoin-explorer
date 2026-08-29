'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const { TtlCache, weakEtag } = require('../lib/ttlcache');
const { tokenBucket, rateLimitEnabled } = require('../lib/ratelimit');
const {
  htmlCacheKey,
  invalidateNameCaches,
  attachHtmlCache,
  cacheControl,
  parseLimit,
} = require('../lib/httpcache');

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

describe('TtlCache', () => {
  it('returns a hit inside TTL and evicts the oldest key', () => {
    const c = new TtlCache({ max: 2, ttlMs: 60_000, swrMs: 0 });
    c.set('a', 1);
    c.set('b', 2);
    c.set('c', 3);
    assert.equal(c.size, 2);
    assert.equal(c.get('a').hit, false);
    assert.equal(c.get('b').value, 2);
    assert.equal(c.get('c').value, 3);
  });

  it('serves stale values during the SWR window', async () => {
    const c = new TtlCache({ max: 8, ttlMs: 20, swrMs: 80 });
    c.set('k', 'fresh');
    assert.equal(c.get('k').stale, false);
    await sleep(30);
    const g = c.get('k');
    assert.equal(g.hit, true);
    assert.equal(g.stale, true);
    assert.equal(g.value, 'fresh');
  });

  it('coalesces loaders and refreshes stale keys in the background', async () => {
    const c = new TtlCache({ max: 8, ttlMs: 20, swrMs: 200 });
    let n = 0;
    const loader = async () => {
      n += 1;
      await sleep(20);
      return n;
    };
    const first = await Promise.all([c.getOrLoad('x', loader), c.getOrLoad('x', loader)]);
    assert.deepEqual(first, [1, 1]);
    assert.equal(n, 1);
    await sleep(30);
    const stale = await c.getOrLoad('x', loader);
    assert.equal(stale, 1);
    await sleep(80);
    const next = c.get('x');
    assert.equal(next.hit, true);
    assert.equal(next.value, 2);
  });

  it('invalidate drops a prefix and leaves other keys', () => {
    const c = new TtlCache({ max: 8, ttlMs: 60_000, swrMs: 0 });
    c.set('s|en|1y', 1);
    c.set('n|en|d/our', 2);
    c.invalidate('s|');
    assert.equal(c.get('s|en|1y').hit, false);
    assert.equal(c.get('n|en|d/our').value, 2);
  });

  it('does not recache a loader that finishes after invalidate', async () => {
    const c = new TtlCache({ max: 8, ttlMs: 60_000, swrMs: 0 });
    const pending = c.getOrLoad('p|d/our', async () => {
      await sleep(40);
      return 'stale-write';
    });
    await sleep(5);
    c.invalidate('p|');
    await pending;
    assert.equal(c.get('p|d/our').hit, false);
  });

  it('shareLoad coalesces waiters and skips set after invalidate', async () => {
    const c = new TtlCache({ max: 8, ttlMs: 60_000, swrMs: 0 });
    const lead = c.shareLoad('h|en');
    assert.equal(lead.leader, true);
    const wait = c.shareLoad('h|en');
    assert.equal(wait.leader, false);
    c.invalidate('h|');
    lead.finish({ body: 'home' });
    assert.deepEqual(await wait.promise, { body: 'home' });
    assert.equal(c.get('h|en').hit, false);
  });
});

describe('httpcache helpers', () => {
  it('keys stats, home, names, namespace, and name pages', () => {
    const stats = htmlCacheKey({
      method: 'GET',
      path: '/stats',
      query: { range: '7d', hr: '1m', ops: '3m' },
      get: () => 'en',
    });
    assert.equal(stats, 's|en|7d|1m|3m');
    assert.equal(htmlCacheKey({
      method: 'GET', path: '/', query: {}, get: () => 'en',
    }), 'h|en');
    assert.equal(htmlCacheKey({
      method: 'GET', path: '/names', query: {}, get: () => 'en',
    }), 'l|en||||50|');
    assert.equal(htmlCacheKey({
      method: 'GET',
      path: '/names',
      query: { ns: 'd', status: 'live', start: 'd/aa', limit: '20', q: 'bit' },
      get: () => 'de',
    }), 'l|de|d|live|d/aa|20|bit');
    assert.equal(htmlCacheKey({
      method: 'GET', path: '/namespaces', query: {}, get: () => 'en',
    }), 'm|en');
    assert.equal(htmlCacheKey({
      method: 'GET', path: '/namespace/d', query: {}, get: () => 'en',
    }), 'k|en|d|||50');
    assert.equal(htmlCacheKey({
      method: 'GET',
      path: '/namespace/id',
      query: { status: 'expired', start: 'id/z', limit: '80' },
      get: () => 'en',
    }), 'k|en|id|expired|id/z|80');
    const name = htmlCacheKey({
      method: 'GET',
      path: '/name/d%2Four',
      query: {},
      get: () => 'de-DE,de;q=0.9',
    });
    assert.equal(name, 'n|de|d/our');
    assert.equal(htmlCacheKey({
      method: 'GET', path: '/blocks', query: {}, get: () => 'en',
    }), null);
    assert.equal(htmlCacheKey({
      method: 'GET', path: '/names', query: { limit: '999' }, get: () => 'en',
    }), 'l|en||||50|');
  });

  it('parseLimit matches the names and namespace route caps', () => {
    assert.equal(parseLimit('999', 50, 50), 50);
    assert.equal(parseLimit('80', 50, 100), 80);
    assert.equal(parseLimit('', 50, 50), 50);
    assert.equal(parseLimit(undefined, 20, 50), 20);
  });

  it('invalidates stats always and only the named HTML/payload keys', () => {
    const caches = {
      html: new TtlCache({ max: 16, ttlMs: 60_000, swrMs: 0 }),
      stats: new TtlCache({ max: 8, ttlMs: 60_000, swrMs: 0 }),
      names: new TtlCache({ max: 8, ttlMs: 60_000, swrMs: 0 }),
    };
    caches.html.set('s|en|1y|1y|1y', { body: 'stats' });
    caches.html.set('h|en', { body: 'home' });
    caches.html.set('l|en||||50|', { body: 'names' });
    caches.html.set('m|en', { body: 'namespaces' });
    caches.html.set('k|en|d|||50', { body: 'ns' });
    caches.html.set('n|en|d/our', { body: 'our' });
    caches.html.set('n|en|d/bit', { body: 'bit' });
    caches.stats.set('st|1y|1y|1y', { ok: 1 });
    caches.names.set('p|d/our', { show: 1 });
    caches.names.set('p|d/bit', { show: 1 });
    invalidateNameCaches(caches, ['d/our']);
    assert.equal(caches.stats.size, 0);
    assert.equal(caches.html.get('s|en|1y|1y|1y').hit, false);
    assert.equal(caches.html.get('h|en').hit, false);
    assert.equal(caches.html.get('l|en||||50|').hit, false);
    assert.equal(caches.html.get('m|en').hit, false);
    assert.equal(caches.html.get('k|en|d|||50').hit, false);
    assert.equal(caches.html.get('n|en|d/our').hit, false);
    assert.equal(caches.html.get('n|en|d/bit').hit, true);
    assert.equal(caches.names.get('p|d/our').hit, false);
    assert.equal(caches.names.get('p|d/bit').hit, true);
  });

  it('flush after a reorg clears every store', () => {
    const caches = {
      html: new TtlCache({ max: 4, ttlMs: 60_000, swrMs: 0 }),
      names: new TtlCache({ max: 4, ttlMs: 60_000, swrMs: 0 }),
    };
    caches.html.set('n|en|d/our', { body: 'x' });
    caches.names.set('p|d/our', { show: 1 });
    invalidateNameCaches(caches, [], { flush: true });
    assert.equal(caches.html.size, 0);
    assert.equal(caches.names.size, 0);
  });
});

describe('HTML response cache', () => {
  it('serves the second GET from memory and answers 304 on If-None-Match', async () => {
    const store = new TtlCache({ max: 8, ttlMs: 60_000, swrMs: 0 });
    let renders = 0;
    const app = express();
    app.use(attachHtmlCache(store));
    app.get('/name/:name', (req, res) => {
      renders += 1;
      res.type('html').send('<html>' + req.params.name + '</html>');
    });
    const server = await new Promise((resolve) => {
      const s = app.listen(0, '127.0.0.1', () => resolve(s));
    });
    const port = server.address().port;
    try {
      const a = await fetch('http://127.0.0.1:' + port + '/name/d%2Four');
      const bodyA = await a.text();
      const etag = a.headers.get('etag');
      assert.equal(a.status, 200);
      assert.equal(renders, 1);
      assert.ok(etag);
      const b = await fetch('http://127.0.0.1:' + port + '/name/d%2Four');
      const bodyB = await b.text();
      assert.equal(b.status, 200);
      assert.equal(bodyB, bodyA);
      assert.equal(renders, 1);
      const c = await fetch('http://127.0.0.1:' + port + '/name/d%2Four', {
        headers: { 'if-none-match': etag },
      });
      assert.equal(c.status, 304);
      assert.equal(renders, 1);
      assert.equal(weakEtag(bodyA), etag);
    } finally {
      await new Promise((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
    }
  });

  it('coalesces concurrent misses for the homepage into one render', async () => {
    const store = new TtlCache({ max: 8, ttlMs: 60_000, swrMs: 0 });
    let renders = 0;
    const app = express();
    app.use(attachHtmlCache(store));
    app.get('/', (_req, res) => {
      renders += 1;
      setTimeout(() => res.type('html').send('<html>home</html>'), 40);
    });
    const server = await new Promise((resolve) => {
      const s = app.listen(0, '127.0.0.1', () => resolve(s));
    });
    const port = server.address().port;
    try {
      const [a, b, c] = await Promise.all([
        fetch('http://127.0.0.1:' + port + '/'),
        fetch('http://127.0.0.1:' + port + '/'),
        fetch('http://127.0.0.1:' + port + '/'),
      ]);
      assert.equal(a.status, 200);
      assert.equal(b.status, 200);
      assert.equal(c.status, 200);
      assert.equal(await a.text(), '<html>home</html>');
      assert.equal(renders, 1);
    } finally {
      await new Promise((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
    }
  });
});

describe('cacheControl', () => {
  it('sets short SWR on HTML and no-store on health', async () => {
    const app = express();
    app.use(cacheControl);
    app.get('/health', (_req, res) => res.send('ok'));
    app.get('/name/x', (_req, res) => res.send('n'));
    app.get('/api/stats', (_req, res) => res.send('{}'));
    const server = await new Promise((resolve) => {
      const s = app.listen(0, '127.0.0.1', () => resolve(s));
    });
    const port = server.address().port;
    try {
      const health = await fetch('http://127.0.0.1:' + port + '/health');
      assert.match(health.headers.get('cache-control') || '', /no-store/);
      const html = await fetch('http://127.0.0.1:' + port + '/name/x');
      assert.match(html.headers.get('cache-control') || '', /max-age=10/);
      const api = await fetch('http://127.0.0.1:' + port + '/api/stats');
      assert.match(api.headers.get('cache-control') || '', /max-age=15/);
    } finally {
      await new Promise((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
    }
  });
});

describe('tokenBucket', () => {
  it('returns 429 after the burst and skips when disabled', async () => {
    assert.equal(rateLimitEnabled({ NODE_ENV: 'test', NMC_RATE_LIMIT: '' }), false);
    assert.equal(rateLimitEnabled({ NODE_ENV: 'production', NMC_RATE_LIMIT: '' }), true);
    const mw = tokenBucket({ windowMs: 60_000, max: 2 });
    const app = express();
    app.use(mw);
    app.get('/x', (_req, res) => res.send('ok'));
    const server = await new Promise((resolve) => {
      const s = app.listen(0, '127.0.0.1', () => resolve(s));
    });
    const port = server.address().port;
    try {
      assert.equal((await fetch('http://127.0.0.1:' + port + '/x')).status, 200);
      assert.equal((await fetch('http://127.0.0.1:' + port + '/x')).status, 200);
      const limited = await fetch('http://127.0.0.1:' + port + '/x');
      assert.equal(limited.status, 429);
      assert.ok(limited.headers.get('retry-after'));
    } finally {
      await new Promise((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
    }
  });
});
