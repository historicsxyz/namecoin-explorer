'use strict';

// Classify header-search input: height, 64-hex (tx/block), address, or name.

function looksLikeAddress(s) {
  const v = String(s || '').trim();
  if (!v) return false;
  if (/^nc1[023456789acdefghjklmnpqrstuvwxyz]{20,}$/i.test(v)) return true;
  if (/^[N6][1-9A-HJ-NP-Za-km-z]{25,34}$/.test(v)) return true;
  return false;
}

function classifyQuery(q) {
  const s = String(q == null ? '' : q).trim();
  if (!s) return { kind: null, value: '' };
  if (/^\d+$/.test(s)) {
    const n = Number(s);
    if (Number.isFinite(n) && n >= 0 && n <= 0x7fffffff) {
      return { kind: 'height', value: Math.floor(n) };
    }
  }
  const hex = s.replace(/^0x/i, '');
  if (/^[0-9a-fA-F]{64}$/.test(hex)) {
    return { kind: 'hex64', value: hex.toLowerCase() };
  }
  if (looksLikeAddress(s)) return { kind: 'address', value: s };
  return { kind: 'name', value: s };
}

async function lookupItems(q, { cache, rpc, limit = 12 } = {}) {
  const items = [];
  const c = classifyQuery(q);
  if (!c.kind) return items;
  const n = Math.min(Math.max(Number(limit) || 12, 1), 30);
  const tip = cache && cache.getTip ? (cache.getTip() || {}).height : null;

  if (c.kind === 'height') {
    const h = c.value;
    let known = false;
    try { known = !!(cache && cache.headerAt && cache.headerAt(h)); } catch { /* empty */ }
    const inRange = tip == null ? h >= 0 : (h >= 0 && h <= Number(tip));
    if (known || inRange) {
      items.push({
        kind: 'block',
        href: '/block/' + h,
        label: String(h),
        exact: true,
      });
    }
  }

  if (c.kind === 'hex64') {
    const id = c.value;
    let asTx = false;
    let asBlock = false;
    try { asTx = !!(cache && cache.txidSeen && cache.txidSeen(id)); } catch { /* empty */ }
    try { asBlock = !!(cache && cache.headerByHash && cache.headerByHash(id)); } catch { /* empty */ }
    if (!asTx && rpc) {
      try {
        await rpc.call('getrawtransaction', [id, true]);
        asTx = true;
      } catch { /* not a tx or node down */ }
    }
    if (!asBlock && rpc) {
      try {
        await rpc.call('getblockheader', [id, true]);
        asBlock = true;
      } catch { /* not a block or node down */ }
    }
    if (asTx || !asBlock) {
      items.push({ kind: 'tx', href: '/tx/' + id, label: id, exact: true });
    }
    if (asBlock) {
      items.push({ kind: 'block', href: '/block/' + id, label: id, exact: true });
    }
  }

  if (c.kind === 'address') {
    items.push({
      kind: 'address',
      href: '/address/' + encodeURIComponent(c.value),
      label: c.value,
      exact: true,
    });
  } else if (c.kind === 'name' && cache && cache.addressSeen && cache.addressSeen(c.value)) {
    items.push({
      kind: 'address',
      href: '/address/' + encodeURIComponent(c.value),
      label: c.value,
      exact: true,
    });
  }

  if (c.kind === 'name' || c.kind === 'height') {
    const term = c.kind === 'height' ? String(c.value) : c.value;
    let rows = [];
    try { rows = cache.search(term, n) || []; } catch { rows = []; }
    for (const r of rows) {
      const name = r && r.name != null ? String(r.name) : '';
      if (!name) continue;
      items.push({
        kind: 'name',
        href: '/name/' + encodeURIComponent(name),
        label: name,
        name,
        exact: name === term || name === String(q || '').trim(),
      });
    }
  }

  return items;
}

function pickEnterHref(items, q) {
  const list = items || [];
  const exact = list.filter((i) => i && i.exact && i.href);
  if (exact.length === 1) return exact[0].href;
  if (exact.length > 1) return exact[0].href;
  if (list.length === 1 && list[0].href) return list[0].href;
  const term = String(q || '').trim();
  if (!term) return null;
  const c = classifyQuery(term);
  if (c.kind === 'hex64') return '/tx/' + c.value;
  if (c.kind === 'address') return '/address/' + encodeURIComponent(c.value);
  if (c.kind === 'height') return '/block/' + c.value;
  return '/names?q=' + encodeURIComponent(term);
}

module.exports = {
  looksLikeAddress,
  classifyQuery,
  lookupItems,
  pickEnterHref,
};
