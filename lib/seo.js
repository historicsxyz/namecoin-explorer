'use strict';

const path = require('path');

const THEME_COLOR = '#6787B7';
const OG_PATH = '/og.png';
const OG_WIDTH = 1200;
const OG_HEIGHT = 630;
const LANGS = ['en', 'de'];
const SITEMAP_NAME_LIMIT = 50000;
const SITEMAP_PATHS = [
  { path: '/', priority: '1.0', changefreq: 'hourly' },
  { path: '/names', priority: '0.9', changefreq: 'hourly' },
  { path: '/namespaces', priority: '0.8', changefreq: 'hourly' },
  { path: '/operations', priority: '0.8', changefreq: 'hourly' },
  { path: '/blocks', priority: '0.8', changefreq: 'hourly' },
  { path: '/tx', priority: '0.7', changefreq: 'hourly' },
  { path: '/addresses', priority: '0.7', changefreq: 'hourly' },
  { path: '/stats', priority: '0.7', changefreq: 'daily' },
  { path: '/operations/pending', priority: '0.4', changefreq: 'always' },
];

function publicOrigin(req, env) {
  const src = env || process.env;
  const raw = src.NMC_PUBLIC_URL;
  if (raw && String(raw).trim()) {
    return String(raw).trim().replace(/\/+$/, '');
  }
  const proto = String(
    (req.get && (req.get('x-forwarded-proto') || req.get('X-Forwarded-Proto')))
    || req.protocol
    || 'http',
  ).split(',')[0].trim();
  const host = String(
    (req.get && (req.get('x-forwarded-host') || req.get('host')))
    || '127.0.0.1:3100',
  ).split(',')[0].trim();
  return proto + '://' + host;
}

function requestPath(req) {
  const raw = String(req.path || (req.originalUrl || '').split('?')[0] || '/');
  if (raw.length > 1 && raw.endsWith('/')) return raw.replace(/\/+$/, '') || '/';
  return raw || '/';
}

function requestHost(req) {
  const raw = String(
    (req.get && (req.get('x-forwarded-host') || req.get('host'))) || '',
  ).split(',')[0].trim().toLowerCase().replace(/\.$/, '');
  return raw.split(':')[0];
}

function isLoopbackHost(host) {
  return !host || host === '127.0.0.1' || host === 'localhost' || host === '::1';
}

function canonicalRedirect(req, res, next, env) {
  const src = env || process.env;
  const raw = src.NMC_PUBLIC_URL;
  if (!raw || !String(raw).trim()) return next();
  let want;
  try { want = new URL(String(raw).trim()); } catch { return next(); }
  const wantHost = String(want.hostname || '').toLowerCase();
  if (!wantHost) return next();
  const host = requestHost(req);
  if (isLoopbackHost(host) || host === wantHost) return next();
  const p = requestPath(req);
  if (p === '/health' || p === '/api/health') return next();
  const pathAndQuery = req.originalUrl || req.url || '/';
  res.set('Cache-Control', 'public, max-age=3600');
  return res.redirect(301, want.origin + pathAndQuery);
}

function attachCanonicalRedirect(env) {
  return (req, res, next) => canonicalRedirect(req, res, next, env);
}

function queryVal(req, key) {
  const q = req.query || {};
  const v = q[key];
  if (Array.isArray(v)) return v[0] == null ? '' : String(v[0]);
  return v == null ? '' : String(v);
}

function shortId(s, n) {
  const str = s == null ? '' : String(s);
  const max = n == null ? 16 : n;
  return str.length > max ? str.slice(0, max) : str;
}

function safeJsonLd(obj) {
  return JSON.stringify(obj).replace(/</g, '\\u003c');
}

function dnsLabel(name) {
  const s = String(name || '');
  if (/^d\/[^/]+$/.test(s)) return s.slice(2) + '.bit';
  return '';
}

function nameIsExpired(opts) {
  const show = opts && opts.show;
  const cached = opts && opts.cached;
  if (show && (show.expired === true || show.expired === 1)) return true;
  if (cached && (cached.expired === true || cached.expired === 1)) return true;
  if (show && show.expires_in != null && Number(show.expires_in) <= 0) return true;
  return false;
}

function namePageTitle(name, t, brand, expired) {
  const ident = String(name || '');
  const bit = dnsLabel(ident);
  const parts = [];
  if (bit) parts.push(bit);
  parts.push(ident);
  if (expired) parts.push(t('seo.expired'));
  parts.push(brand);
  return parts.join(' · ');
}

function breadcrumb(origin, items) {
  return {
    '@type': 'BreadcrumbList',
    '@id': origin + '/#crumbs',
    itemListElement: items.map((it, i) => {
      const node = { '@type': 'ListItem', position: i + 1, name: it.name };
      if (it.item) node.item = it.item;
      return node;
    }),
  };
}

function orgNode(origin, brand) {
  return {
    '@type': 'Organization',
    '@id': origin + '/#org',
    name: brand,
    url: origin + '/',
    logo: origin + '/apple-touch-icon.png',
    sameAs: [
      'https://github.com/historicsxyz/namecoin-explorer',
      'https://historics.xyz',
    ],
  };
}

function websiteNode(origin, brand, description, slogan) {
  const node = {
    '@type': 'WebSite',
    '@id': origin + '/#website',
    name: brand,
    url: origin + '/',
    description,
    inLanguage: LANGS,
    publisher: { '@id': origin + '/#org' },
  };
  if (slogan) node.slogan = slogan;
  return node;
}

function webPageNode(origin, pathOnly, title, description, lang) {
  return {
    '@type': 'WebPage',
    '@id': origin + pathOnly + '#webpage',
    url: origin + pathOnly,
    name: title,
    description,
    inLanguage: lang,
    isPartOf: { '@id': origin + '/#website' },
  };
}

function buildSeo(req, res, opts) {
  opts = opts || {};
  const t = (res.locals && res.locals.t) || ((k) => k);
  const page = (res.locals && res.locals.page) || '';
  const lang = (res.locals && res.locals.lang) || 'en';
  const origin = publicOrigin(req);
  const pathOnly = requestPath(req);
  const brand = t('app.title');
  const params = req.params || {};
  const q = queryVal(req, 'q').trim();
  const start = queryVal(req, 'start').trim();
  const after = queryVal(req, 'after').trim();
  const nsQuery = queryVal(req, 'ns').trim();
  const name = opts.name || params.name || '';
  const ns = opts.ns || params.ns || nsQuery;
  const block = opts.block;
  const tx = opts.tx;
  const pending = pathOnly === '/operations/pending';

  let title = brand;
  let description = t('seo.default');
  let noindex = false;
  let nofollow = false;
  let ogType = 'website';
  let extraLd = [];
  let canonicalPath = pathOnly;

  if (page === 'home') {
    title = t('seo.homeTitle');
    description = t('seo.home');
  } else if (page === 'name' && name) {
    const expired = nameIsExpired(opts);
    const bit = dnsLabel(name);
    title = namePageTitle(name, t, brand, expired);
    description = t('seo.name', { name: bit || String(name) });
    extraLd.push(breadcrumb(origin, [
      { name: brand, item: origin + '/' },
      { name: t('nav.names'), item: origin + '/names' },
      { name: bit || String(name) },
    ]));
    const work = {
      '@type': 'CreativeWork',
      name: bit || String(name),
      identifier: String(name),
      url: origin + pathOnly,
      isPartOf: { '@id': origin + '/#website' },
    };
    if (bit) work.alternateName = String(name);
    extraLd.push(work);
  } else if (page === 'names' && q) {
    title = t('seo.searchTitle', { q }) + ' · ' + brand;
    description = t('seo.search', { q });
    noindex = true;
    canonicalPath = '/names';
  } else if (page === 'names') {
    title = t('nav.names') + ' · ' + brand;
    description = t('seo.names');
    if (nsQuery) {
      canonicalPath = '/namespace/' + nsQuery.replace(/\/+$/, '');
    }
  } else if (page === 'namespace' && (pathOnly === '/namespaces' || !ns)) {
    title = t('nav.namespaces') + ' · ' + brand;
    description = t('seo.namespaces');
    extraLd.push(breadcrumb(origin, [
      { name: brand, item: origin + '/' },
      { name: t('nav.namespaces'), item: origin + '/namespaces' },
    ]));
  } else if (page === 'namespace') {
    const prefix = String(ns).replace(/\/+$/, '') + '/';
    title = t('seo.nsTitle', { ns: prefix }) + ' · ' + brand;
    description = t('seo.ns', { ns: prefix });
    extraLd.push(breadcrumb(origin, [
      { name: brand, item: origin + '/' },
      { name: t('nav.namespaces'), item: origin + '/namespaces' },
      { name: prefix, item: origin + '/namespace/' + String(ns).replace(/\/+$/, '') },
    ]));
  } else if (page === 'operations' && pending) {
    title = t('opsPending.title') + ' · ' + brand;
    description = t('seo.opsPending');
  } else if (page === 'operations') {
    title = t('nav.operations') + ' · ' + brand;
    description = t('seo.operations');
  } else if (page === 'blocks' && (block || params.hash)) {
    const n = block && block.height != null ? String(block.height) : shortId(params.hash);
    title = t('seo.blockTitle', { n }) + ' · ' + brand;
    description = t('seo.block', { n });
    extraLd.push(breadcrumb(origin, [
      { name: brand, item: origin + '/' },
      { name: t('nav.blocks'), item: origin + '/blocks' },
      { name: t('seo.blockTitle', { n }) },
    ]));
  } else if (page === 'blocks') {
    title = t('nav.blocks') + ' · ' + brand;
    description = t('seo.blocks');
    if (q || queryVal(req, 'ops').trim()) {
      noindex = true;
      canonicalPath = '/blocks';
    }
  } else if (page === 'txs' && (pathOnly === '/tx' || !params.txid)) {
    title = t('nav.transactions') + ' · ' + brand;
    description = t('seo.txs');
    extraLd.push(breadcrumb(origin, [
      { name: brand, item: origin + '/' },
      { name: t('nav.transactions'), item: origin + '/tx' },
    ]));
    if (q) {
      noindex = true;
      canonicalPath = '/tx';
    }
  } else if (page === 'txs') {
    const id = (tx && tx.txid) || params.txid || '';
    const short = shortId(id);
    title = t('seo.txTitle', { id: short }) + ' · ' + brand;
    description = t('seo.tx');
    extraLd.push(breadcrumb(origin, [
      { name: brand, item: origin + '/' },
      { name: t('nav.transactions'), item: origin + '/tx' },
      { name: t('seo.txTitle', { id: short }) },
    ]));
  } else if (page === 'address' && (pathOnly === '/addresses' || !params.addr)) {
    title = t('nav.addresses') + ' · ' + brand;
    description = t('seo.addresses');
    extraLd.push(breadcrumb(origin, [
      { name: brand, item: origin + '/' },
      { name: t('nav.addresses'), item: origin + '/addresses' },
    ]));
  } else if (page === 'address') {
    const addr = opts.addr || params.addr || '';
    title = (addr ? String(addr) : t('address.title')) + ' · ' + brand;
    description = t('seo.address', { addr: addr || '' });
    extraLd.push(breadcrumb(origin, [
      { name: brand, item: origin + '/' },
      { name: t('nav.addresses'), item: origin + '/addresses' },
      { name: String(addr || t('address.title')) },
    ]));
  } else if (page === 'stats') {
    title = t('nav.stats') + ' · ' + brand;
    description = t('seo.stats');
  } else if (page === 'og') {
    title = t('og.title') + ' · ' + brand;
    description = t('seo.og');
    noindex = true;
    nofollow = true;
  } else if (page === 'api') {
    title = (opts.title || t('nav.api')) + ' · ' + brand;
    description = t('seo.api');
    noindex = true;
    nofollow = true;
  } else if (page === 'error') {
    title = t('error.title') + ' · ' + brand;
    description = t('error.lead');
    noindex = true;
    nofollow = true;
  }

  if (pathOnly === '/health' || pathOnly.startsWith('/api/')) {
    noindex = true;
    nofollow = true;
  }
  if (start || after) noindex = true;

  const canonical = origin + canonicalPath;

  const jsonLd = safeJsonLd({
    '@context': 'https://schema.org',
    '@graph': [
      orgNode(origin, brand),
      websiteNode(origin, brand, t('seo.home'), t('app.tagline')),
      webPageNode(origin, canonicalPath, title, description, lang),
    ].concat(extraLd),
  });

  return {
    title,
    description,
    canonical,
    origin,
    siteName: brand,
    image: origin + OG_PATH,
    imageWidth: OG_WIDTH,
    imageHeight: OG_HEIGHT,
    imageAlt: t('og.alt'),
    noindex,
    nofollow,
    ogType,
    lang,
    locale: lang === 'de' ? 'de_DE' : 'en_US',
    localeAlt: lang === 'de' ? 'en_US' : 'de_DE',
    jsonLd,
    themeColor: THEME_COLOR,
    hreflang: [],
  };
}

function robotsTxt(origin) {
  return [
    'User-agent: *',
    'Allow: /',
    'Disallow: /api/',
    'Disallow: /health',
    '',
    'Sitemap: ' + origin + '/sitemap.xml',
    '',
  ].join('\n');
}

function escXml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function sitemapLastmod(now) {
  return (now || new Date()).toISOString().slice(0, 10);
}

function sitemapXml(origin, now) {
  const lastmod = sitemapLastmod(now);
  const urls = SITEMAP_PATHS.map((entry) => {
    const loc = origin + entry.path;
    return [
      '  <url>',
      '    <loc>' + escXml(loc) + '</loc>',
      '    <lastmod>' + lastmod + '</lastmod>',
      '    <changefreq>' + entry.changefreq + '</changefreq>',
      '    <priority>' + entry.priority + '</priority>',
      '  </url>',
    ].join('\n');
  }).join('\n');
  return '<?xml version="1.0" encoding="UTF-8"?>\n'
    + '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n'
    + urls + '\n</urlset>\n';
}

function sitemapIndexXml(origin, liveCount, now) {
  const lastmod = sitemapLastmod(now);
  const total = Math.max(0, Math.floor(Number(liveCount) || 0));
  const shards = Math.ceil(total / SITEMAP_NAME_LIMIT);
  const locs = [origin + '/sitemap/hubs.xml'];
  for (let i = 1; i <= shards; i++) locs.push(origin + '/sitemap/names-' + i + '.xml');
  const body = locs.map((loc) => [
    '  <sitemap>',
    '    <loc>' + escXml(loc) + '</loc>',
    '    <lastmod>' + lastmod + '</lastmod>',
    '  </sitemap>',
  ].join('\n')).join('\n');
  return '<?xml version="1.0" encoding="UTF-8"?>\n'
    + '<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n'
    + body + '\n</sitemapindex>\n';
}

function nameSitemapPath(name) {
  return '/name/' + encodeURIComponent(String(name || ''));
}

function sitemapNamesXml(origin, names) {
  const list = Array.isArray(names) ? names : [];
  const urls = list.map((row) => {
    const name = row && typeof row === 'object' ? row.name : row;
    return '  <url>\n    <loc>' + escXml(origin + nameSitemapPath(name)) + '</loc>\n  </url>';
  }).join('\n');
  return '<?xml version="1.0" encoding="UTF-8"?>\n'
    + '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n'
    + (urls ? urls + '\n' : '')
    + '</urlset>\n';
}

function sendSitemap(res, xml) {
  res.set('Cache-Control', 'public, max-age=3600, stale-while-revalidate=86400');
  res.type('application/xml; charset=utf-8').send(xml);
}

function attachSeo(req, res, next) {
  const orig = res.render.bind(res);
  res.render = function (view, opts, cb) {
    if (typeof opts === 'function') {
      cb = opts;
      opts = {};
    }
    res.locals.seo = buildSeo(req, res, opts || {});
    return orig(view, opts, cb);
  };
  next();
}

function registerSeoRoutes(app, publicDir, cache) {
  const dir = publicDir || path.join(__dirname, '..', 'public');

  app.get('/robots.txt', (req, res) => {
    res.type('text/plain; charset=utf-8').send(robotsTxt(publicOrigin(req)));
  });

  app.get('/sitemap.xml', (req, res) => {
    let live = 0;
    try { live = cache && cache.countLive ? cache.countLive() : 0; } catch { live = 0; }
    sendSitemap(res, sitemapIndexXml(publicOrigin(req), live));
  });

  app.get('/sitemap/hubs.xml', (req, res) => {
    sendSitemap(res, sitemapXml(publicOrigin(req)));
  });

  app.get('/sitemap/names-:page.xml', (req, res) => {
    const page = Math.floor(Number(req.params.page) || 0);
    if (page < 1 || page > 1000) {
      return res.status(404).type('text/plain; charset=utf-8').send('Not found');
    }
    let rows = [];
    try {
      rows = cache && cache.sitemapNames
        ? cache.sitemapNames(page, SITEMAP_NAME_LIMIT)
        : [];
    } catch { rows = []; }
    if (page > 1 && !rows.length) {
      return res.status(404).type('text/plain; charset=utf-8').send('Not found');
    }
    sendSitemap(res, sitemapNamesXml(publicOrigin(req), rows));
  });

  app.get('/favicon.ico', (req, res) => {
    res.type('image/png');
    res.sendFile(path.join(dir, 'favicon.png'));
  });
}

module.exports = {
  THEME_COLOR,
  OG_WIDTH,
  OG_HEIGHT,
  SITEMAP_PATHS,
  SITEMAP_NAME_LIMIT,
  publicOrigin,
  requestPath,
  canonicalRedirect,
  attachCanonicalRedirect,
  dnsLabel,
  buildSeo,
  robotsTxt,
  sitemapXml,
  sitemapIndexXml,
  sitemapNamesXml,
  attachSeo,
  registerSeoRoutes,
};
