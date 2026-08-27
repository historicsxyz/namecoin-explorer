'use strict';

const { pickLang } = require('./i18n');
const { parseChartRange } = require('./statsdata');
const { weakEtag } = require('./ttlcache');

function htmlCacheKey(req) {
  if (!req || (req.method !== 'GET' && req.method !== 'HEAD')) return null;
  const p = String(req.path || '');
  const lang = pickLang(req.query && req.query.lang, req.get && req.get('accept-language'));
  if (p === '/stats') {
    const range = parseChartRange(req.query && req.query.range);
    const hr = parseChartRange(req.query && req.query.hr);
    const ops = parseChartRange(req.query && req.query.ops);
    return 's|' + lang + '|' + range + '|' + hr + '|' + ops;
  }
  if (p.startsWith('/name/') && p.length > 6) {
    let name = p.slice(6);
    try { name = decodeURIComponent(name); } catch { /* keep raw */ }
    return 'n|' + lang + '|' + name;
  }
  return null;
}

function invalidateNameCaches(caches, names, extra = {}) {
  if (!caches) return;
  if (extra.flush) {
    if (caches.stats) caches.stats.clear();
    if (caches.html) caches.html.clear();
    if (caches.names) caches.names.clear();
    return;
  }
  if (caches.stats) caches.stats.invalidate();
  if (caches.html) caches.html.invalidate('s|');
  const list = (Array.isArray(names) ? names : []).filter(Boolean).map(String);
  if (!list.length) return;
  const want = new Set(list);
  if (caches.names) {
    for (const n of want) caches.names.invalidate('p|' + n);
  }
  if (caches.html) {
    for (const k of [...caches.html.map.keys()]) {
      if (!k.startsWith('n|')) continue;
      const name = k.split('|').slice(2).join('|');
      if (want.has(name)) caches.html.map.delete(k);
    }
  }
}

function ifNoneMatch(req, etag) {
  const inm = req.get && req.get('If-None-Match');
  if (!inm || !etag) return false;
  const want = String(etag);
  if (inm.trim() === '*') return true;
  return String(inm).split(',').some((token) => {
    const m = token.trim();
    return m === want || m === 'W/' + want || 'W/' + m === want;
  });
}

function attachHtmlCache(store) {
  return function htmlCacheMiddleware(req, res, next) {
    if (!store) return next();
    const key = htmlCacheKey(req);
    if (!key) return next();
    res.set('Vary', 'Accept-Language');
    const hit = store.get(key);
    if (hit.hit && req.method === 'GET') {
      const body = hit.value && hit.value.body;
      const etag = (hit.value && hit.value.etag) || weakEtag(body);
      res.set('ETag', etag);
      if (ifNoneMatch(req, etag)) return res.status(304).end();
      res.status(200);
      res.type('html');
      return res.send(body);
    }
    const send = res.send.bind(res);
    res.send = function cachedSend(body) {
      const text = Buffer.isBuffer(body) ? body.toString('utf8')
        : (typeof body === 'string' ? body : null);
      if (res.statusCode === 200 && text && text.length) {
        const etag = weakEtag(text);
        if (!res.get('ETag')) res.set('ETag', etag);
        store.set(key, { body: text, etag: res.get('ETag') || etag });
      }
      return send(body);
    };
    next();
  };
}

function cacheControl(req, res, next) {
  const p = String(req.path || '');
  if (p === '/health' || p === '/api/health' || p.endsWith('/pending')) {
    res.set('Cache-Control', 'no-store');
  } else if (p.startsWith('/api/')) {
    res.set('Cache-Control', 'public, max-age=15, stale-while-revalidate=45');
  } else {
    res.set('Cache-Control', 'public, max-age=10, stale-while-revalidate=30');
  }
  next();
}

function requestTimeout(ms = 60000) {
  const limit = Math.max(1000, Number(ms) || 60000);
  return function timeoutMiddleware(req, res, next) {
    req.setTimeout(limit);
    res.setTimeout(limit);
    const t = setTimeout(() => {
      if (res.headersSent) return;
      res.set('Cache-Control', 'no-store');
      res.status(503).type('text/plain').send('Request timed out');
    }, limit);
    const clear = () => clearTimeout(t);
    res.on('finish', clear);
    res.on('close', clear);
    next();
  };
}

module.exports = {
  htmlCacheKey,
  invalidateNameCaches,
  attachHtmlCache,
  cacheControl,
  requestTimeout,
  ifNoneMatch,
};
