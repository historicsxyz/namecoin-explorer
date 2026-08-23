'use strict';

// Tiny catalog helper. Name values and txids are never translated.
const fs = require('fs');
const path = require('path');

const DIR = path.join(__dirname, '..', 'locales');
const catalogs = {};

function load() {
  if (!fs.existsSync(DIR)) return;
  for (const f of fs.readdirSync(DIR)) {
    if (!f.endsWith('.json')) continue;
    const code = f.slice(0, -5).toLowerCase();
    catalogs[code] = JSON.parse(fs.readFileSync(path.join(DIR, f), 'utf8'));
  }
}
load();

function lookup(obj, key) {
  if (!obj) return undefined;
  const parts = String(key).split('.');
  let cur = obj;
  for (const p of parts) {
    if (cur == null || typeof cur !== 'object') return undefined;
    cur = cur[p];
  }
  return typeof cur === 'string' ? cur : undefined;
}

function interpolate(s, vars) {
  if (!vars) return s;
  return s.replace(/\{(\w+)\}/g, (_, k) => (vars[k] != null ? String(vars[k]) : ''));
}

function t(lang, key, vars) {
  const s = lookup(catalogs[lang], key) || lookup(catalogs.en, key) || key;
  return interpolate(s, vars);
}

function pickLang(queryLang, acceptLanguage) {
  const q = queryLang ? String(queryLang).toLowerCase().split(/[^a-z-]/)[0] : '';
  if (q && catalogs[q]) return q;
  if (q) {
    const base = q.split('-')[0];
    if (catalogs[base]) return base;
  }
  if (acceptLanguage) {
    const tags = String(acceptLanguage).split(',').map((part) => {
      const [tag, qv] = part.trim().split(';q=');
      return { tag: (tag || '').toLowerCase(), q: qv != null ? Number(qv) : 1 };
    }).sort((a, b) => b.q - a.q);
    for (const { tag } of tags) {
      if (!tag) continue;
      if (catalogs[tag]) return tag;
      const base = tag.split('-')[0];
      if (catalogs[base]) return base;
    }
  }
  return 'en';
}

module.exports = { t, pickLang, catalogs, load };
