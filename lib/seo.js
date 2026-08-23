'use strict';

const path = require('path');

const THEME_COLOR = '#6787B7';
const OG_PATH = '/og.png';
const OG_WIDTH = 1200;
const OG_HEIGHT = 630;
const LANGS = ['en', 'de'];
const SITEMAP_PATHS = [
  { path: '/', priority: '1.0', changefreq: 'hourly' },
  { path: '/names', priority: '0.9', changefreq: 'hourly' },
  { path: '/operations', priority: '0.8', changefreq: 'hourly' },
  { path: '/blocks', priority: '0.8', changefreq: 'hourly' },
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
    name: 'Historics',
    url: 'https://historics.xyz',
    logo: origin + '/apple-touch-icon.png',
    sameAs: [
      'https://github.com/historicsxyz/namecoin-explorer',
      'https://historics.xyz',
    ],
  };
}

function websiteNode(origin, brand, description) {
  return {
    '@type': 'WebSite',
    '@id': origin + '/#website',
    name: brand,
    url: origin + '/',
    description,
    inLanguage: LANGS,
    publisher: { '@id': origin + '/#org' },
    potentialAction: {
      '@type': 'SearchAction',
      target: origin + '/names?q={search_term_string}',
      'query-input': 'required name=search_term_string',
    },
  };
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
  const nsQuery = queryVal(req, 'ns').trim();
  const name = opts.name || params.name || '';
  const ns = opts.ns || params.ns || nsQuery;
  const block = opts.block;
  const tx = opts.tx;
  const pending = pathOnly === '/operations/pending';

  let title = brand;
  let description = t('seo.default');
  let noindex = false;
  let ogType = 'website';
  let extraLd = [];
  let canonicalPath = pathOnly;

  if (page === 'home') {
    title = t('seo.homeTitle');
    description = t('seo.home');
  } else if (page === 'name' && name) {
    title = t('seo.nameTitle', { name }) + ' · ' + brand;
    description = t('seo.name', { name });
    extraLd.push(breadcrumb(origin, [
      { name: brand, item: origin + '/' },
      { name: t('nav.names'), item: origin + '/names' },
      { name: String(name) },
    ]));
    extraLd.push({
      '@type': 'CreativeWork',
      name: String(name),
      identifier: String(name),
      url: origin + pathOnly,
      isPartOf: { '@id': origin + '/#website' },
    });
  } else if (page === 'names' && ns && pathOnly.indexOf('/namespace/') === 0) {
    const prefix = String(ns).replace(/\/+$/, '') + '/';
    title = t('seo.nsTitle', { ns: prefix }) + ' · ' + brand;
    description = t('seo.ns', { ns: prefix });
    extraLd.push(breadcrumb(origin, [
      { name: brand, item: origin + '/' },
      { name: t('nav.names'), item: origin + '/names' },
      { name: prefix, item: origin + '/namespace/' + String(ns).replace(/\/+$/, '') },
    ]));
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
  } else if (page === 'txs') {
    const id = (tx && tx.txid) || params.txid || '';
    const short = shortId(id);
    title = t('seo.txTitle', { id: short }) + ' · ' + brand;
    description = t('seo.tx');
    extraLd.push(breadcrumb(origin, [
      { name: brand, item: origin + '/' },
      { name: t('tx.title') },
    ]));
  } else if (page === 'stats') {
    title = t('nav.stats') + ' · ' + brand;
    description = t('seo.stats');
  } else if (page === 'og') {
    title = t('og.title') + ' · ' + brand;
    description = t('seo.og');
    noindex = true;
  } else if (page === 'api') {
    title = (opts.title || t('nav.api')) + ' · ' + brand;
    description = t('seo.api');
    noindex = true;
  } else if (page === 'error') {
    title = t('error.title') + ' · ' + brand;
    description = t('error.lead');
    noindex = true;
  }

  if (pathOnly === '/health' || pathOnly.startsWith('/api/')) noindex = true;
  if (start) noindex = true;

  const canonical = origin + canonicalPath;
  const hreflang = LANGS.map((code) => ({
    lang: code,
    href: canonical + (canonical.includes('?') ? '&' : '?') + 'lang=' + code,
  }));
  hreflang.push({ lang: 'x-default', href: canonical });

  const jsonLd = safeJsonLd({
    '@context': 'https://schema.org',
    '@graph': [
      orgNode(origin, brand),
      websiteNode(origin, brand, t('seo.home')),
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
    ogType,
    lang,
    locale: lang === 'de' ? 'de_DE' : 'en_US',
    localeAlt: lang === 'de' ? 'en_US' : 'de_DE',
    jsonLd,
    themeColor: THEME_COLOR,
    hreflang,
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

function sitemapXml(origin, now) {
  const lastmod = (now || new Date()).toISOString().slice(0, 10);
  const urls = SITEMAP_PATHS.map((entry) => {
    const loc = origin + entry.path;
    const alts = LANGS.map((code) =>
      '    <xhtml:link rel="alternate" hreflang="' + code + '" href="'
      + escXml(loc + (loc.includes('?') ? '&' : '?') + 'lang=' + code) + '"/>',
    ).join('\n');
    return [
      '  <url>',
      '    <loc>' + escXml(loc) + '</loc>',
      '    <lastmod>' + lastmod + '</lastmod>',
      '    <changefreq>' + entry.changefreq + '</changefreq>',
      '    <priority>' + entry.priority + '</priority>',
      alts,
      '    <xhtml:link rel="alternate" hreflang="x-default" href="' + escXml(loc) + '"/>',
      '  </url>',
    ].join('\n');
  }).join('\n');
  return '<?xml version="1.0" encoding="UTF-8"?>\n'
    + '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"\n'
    + '        xmlns:xhtml="http://www.w3.org/1999/xhtml">\n'
    + urls + '\n</urlset>\n';
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

function registerSeoRoutes(app, publicDir) {
  const dir = publicDir || path.join(__dirname, '..', 'public');

  app.get('/robots.txt', (req, res) => {
    res.type('text/plain; charset=utf-8').send(robotsTxt(publicOrigin(req)));
  });

  app.get('/sitemap.xml', (req, res) => {
    res.type('application/xml; charset=utf-8').send(sitemapXml(publicOrigin(req)));
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
  publicOrigin,
  requestPath,
  buildSeo,
  robotsTxt,
  sitemapXml,
  attachSeo,
  registerSeoRoutes,
};
