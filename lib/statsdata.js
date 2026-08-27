'use strict';

const { loadMarket, peekMarket } = require('./markets');
const { lineChart } = require('./svgchart');
const {
  hashrateFromDifficulty,
  formatHashrate,
  formatDifficulty,
  formatUsd,
  formatCompactUsd,
  sampleHeights,
  bytesOnDisk,
  formatInterval,
} = require('./chainmetrics');

const HR_META = 'hashrate_series_json';
const HR_AT = 'hashrate_series_at';
const HR_TTL_MS = 60 * 60 * 1000;
const PRICE_RANGES = {
  '7d': 7 * 86400 * 1000,
  '1m': 30 * 86400 * 1000,
  '3m': 90 * 86400 * 1000,
  '1y': 365 * 86400 * 1000,
};
const PRICE_RANGE_KEYS = Object.keys(PRICE_RANGES);

function parseChartRange(raw) {
  const k = String(raw || '1y').toLowerCase();
  return PRICE_RANGE_KEYS.includes(k) ? k : '1y';
}

function parsePriceRange(raw) {
  return parseChartRange(raw);
}

function slicePriceSeries(series, rangeKey) {
  const pts = Array.isArray(series) ? series : [];
  if (pts.length < 2) return pts;
  const ms = PRICE_RANGES[parseChartRange(rangeKey)];
  const lastT = pts[pts.length - 1].t;
  const sliced = pts.filter((p) => p.t >= lastT - ms);
  return sliced.length >= 2 ? sliced : pts.slice(-2);
}

function statsHref(ranges, kind, value) {
  const q = {
    range: parseChartRange(ranges.range),
    hr: parseChartRange(ranges.hr),
    ops: parseChartRange(ranges.ops),
  };
  if (kind === 'range' || kind === 'hr' || kind === 'ops') q[kind] = parseChartRange(value);
  const parts = [];
  if (q.range !== '1y') parts.push('range=' + q.range);
  if (q.hr !== '1y') parts.push('hr=' + q.hr);
  if (q.ops !== '1y') parts.push('ops=' + q.ops);
  return parts.length ? '/stats?' + parts.join('&') : '/stats';
}

async function rpcCall(rpc, method, params) {
  try { return await rpc.call(method, params || []); }
  catch { return null; }
}

function seriesFromDifficultyRows(rows) {
  return (rows || []).map((r) => {
    const hs = hashrateFromDifficulty(r.difficulty);
    const t = r.time != null ? Number(r.time) * 1000 : null;
    return (hs != null && t != null) ? { t, v: hs, height: r.height } : null;
  }).filter(Boolean);
}

async function hashrateHistory(rpc, cache) {
  const local = seriesFromDifficultyRows(cache.difficultySeries());
  if (local.length >= 16) return local;

  const extent = cache.headerExtent() || {};
  const minH = Number(extent.minH);
  const maxH = Number(extent.maxH);
  if (!Number.isFinite(minH) || !Number.isFinite(maxH)) return local;

  try {
    const at = Number(cache.metaGet(HR_AT) || 0);
    const raw = cache.metaGet(HR_META);
    if (raw && Date.now() - at < HR_TTL_MS) {
      const cached = JSON.parse(raw);
      if (Array.isArray(cached) && cached.length) return cached;
    }
  } catch { /* ignore */ }

  const heights = sampleHeights(minH, maxH, 36);
  await Promise.all(heights.map(async (h) => {
    const stored = cache.headerAt(h);
    if (stored && stored.difficulty > 0) return;
    const hash = stored && stored.hash;
    if (!hash) return;
    const hdr = await rpcCall(rpc, 'getblockheader', [hash, true]);
    if (!hdr || hdr.difficulty == null) return;
    cache.setHeaderDifficulty(h, Number(hdr.difficulty), hdr.time);
  }));
  const filled = seriesFromDifficultyRows(cache.difficultySeries());
  if (filled.length) {
    try {
      cache.metaSet(HR_META, JSON.stringify(filled));
      cache.metaSet(HR_AT, String(Date.now()));
    } catch { /* ignore */ }
  }
  return filled;
}

function avgBlockInterval(headers) {
  const times = (headers || [])
    .map((h) => Number(h.time))
    .filter((t) => Number.isFinite(t) && t > 0)
    .sort((a, b) => a - b);
  if (times.length < 3) return null;
  let sum = 0;
  for (let i = 1; i < times.length; i++) sum += times[i] - times[i - 1];
  return sum / (times.length - 1);
}

function compactInt(n) {
  const x = Number(n);
  if (!Number.isFinite(x)) return '—';
  return Math.round(x).toLocaleString('en-US');
}

async function gatherStats(rpc, cache, opts = {}) {
  const priceRange = parseChartRange(opts.priceRange);
  const hrRange = parseChartRange(opts.hrRange);
  const opsRange = parseChartRange(opts.opsRange);
  const byNs = cache.countByNamespace();
  const topAddresses = cache.topAddresses(25);
  const totalNames = byNs.reduce((a, r) => a + r.total, 0);
  const liveNames = byNs.reduce((a, r) => a + (r.live || 0), 0);
  const expiredNames = byNs.reduce((a, r) => a + (r.expired || 0), 0);

  const [mining, netHs, chain, mempool, market, hrSeries] = await Promise.all([
    rpcCall(rpc, 'getmininginfo'),
    rpcCall(rpc, 'getnetworkhashps', [120]),
    rpcCall(rpc, 'getblockchaininfo'),
    rpcCall(rpc, 'getmempoolinfo'),
    loadMarket(cache),
    hashrateHistory(rpc, cache),
  ]);

  const difficulty = (mining && mining.difficulty) || (chain && chain.difficulty) || null;
  let hashrate = (typeof netHs === 'number' && netHs > 0) ? netHs : null;
  if (hashrate == null && mining && mining.networkhashps) hashrate = mining.networkhashps;
  if (hashrate == null && difficulty) hashrate = hashrateFromDifficulty(difficulty);
  rememberMiningMeta(cache, difficulty, hashrate);

  const priceSeries = slicePriceSeries((market && market.series) || [], priceRange);
  const priceChart = lineChart(priceSeries, {
    height: 218,
    range: priceRange,
    formatY: (v) => formatUsd(v, v >= 1 ? 2 : 3),
  });
  const fullPrice = (market && market.series) || [];
  const priceSpark = lineChart(fullPrice.slice(-90), { height: 44, width: 280, spark: true });
  const hrChart = lineChart(slicePriceSeries(hrSeries, hrRange), {
    height: 218,
    range: hrRange,
    formatY: (v) => formatHashrate(v),
  });

  const opRows = cache.opsPerDay(366);
  const opSeries = slicePriceSeries(
    opRows.map((r) => ({ t: Number(r.day) * 86400 * 1000, v: Number(r.n) })),
    opsRange,
  );
  const opsChart = lineChart(opSeries, {
    height: 186,
    range: opsRange,
    formatY: (v) => compactInt(v),
  });

  const tip = cache.getTip();
  const tipHeader = tip ? cache.headerAt(tip.height) : null;
  const recentHeaders = cache.latestHeaders(24);
  const intervalSec = avgBlockInterval(recentHeaders);
  const lastBlockTime = (tipHeader && tipHeader.time) || (recentHeaders[0] && recentHeaders[0].time) || null;

  const chainOut = {
    ...(chain || {}),
    blocks: (chain && chain.blocks) || (tip && tip.height) || 0,
    headers: (chain && chain.headers) || Number(cache.metaGet('headers') || 0) || (tip && tip.height) || 0,
    chain: (chain && chain.chain) || cache.metaGet('chain') || 'main',
  };

  const nsMax = byNs.reduce((m, r) => Math.max(m, r.total || 0), 0) || 1;
  const addrMax = topAddresses.reduce((m, r) => Math.max(m, r.live || 0), 0) || 1;
  const source = market && (market.seriesFrom === 'coingecko' || market.source === 'coingecko')
    ? 'CoinGecko'
    : market && market.source === 'coinpaprika' ? 'CoinPaprika' : null;

  return {
    totalNames,
    liveNames,
    expiredNames,
    namespaces: byNs,
    nsMax,
    topAddresses,
    addrMax,
    chain: chainOut,
    mining: mining || {},
    mempool: mempool || {},
    difficulty,
    hashrate,
    hashrateLabel: formatHashrate(hashrate),
    difficultyLabel: formatDifficulty(difficulty),
    diskLabel: bytesOnDisk(chainOut.size_on_disk),
    lastBlockTime,
    intervalLabel: formatInterval(intervalSec),
    supplyLabel: market && market.circulating > 0 ? compactInt(market.circulating) + ' NMC' : '—',
    rankLabel: market && market.rank > 0 ? '#' + market.rank : '—',
    marketSource: source,
    market: market || {},
    priceRange,
    hrRange,
    opsRange,
    priceChart,
    priceSpark,
    hrChart,
    opsChart,
    priceLabel: formatUsd(market && market.price, (market && market.price) >= 1 ? 2 : 4),
    volumeLabel: market && market.volume24h > 0 ? formatCompactUsd(market.volume24h) : '—',
    mcapLabel: market && market.marketCap > 0 ? formatCompactUsd(market.marketCap) : '—',
    athLabel: market && market.ath > 0 ? formatUsd(market.ath) : '—',
    livePct: totalNames ? (100 * liveNames / totalNames) : 0,
  };
}

module.exports = {
  gatherStats,
  hashrateHistory,
  seriesFromDifficultyRows,
  headerTickers,
  parsePriceRange,
  parseChartRange,
  slicePriceSeries,
  statsHref,
  PRICE_RANGE_KEYS,
};

function spark(points, gid) {
  return lineChart(points, {
    height: 36, width: 72, spark: true, padT: 3, padB: 2, padL: 2, padR: 7, gid,
  });
}

function seriesIsFlat(points) {
  if (!points || points.length < 2) return true;
  const v0 = points[0].v;
  return points.every((p) => p.v === v0);
}

function peekHashrateSeries(cache) {
  const local = seriesFromDifficultyRows(cache.difficultySparkSeries(48));
  if (local.length >= 2 && !seriesIsFlat(local)) return local;
  try {
    const raw = cache.metaGet(HR_META);
    const parsed = raw ? JSON.parse(raw) : [];
    if (Array.isArray(parsed) && parsed.length >= 2 && !seriesIsFlat(parsed)) return parsed;
  } catch { /* ignore */ }
  return local;
}

function metaNumber(cache, key) {
  try {
    const n = Number(cache.metaGet(key));
    return Number.isFinite(n) && n > 0 ? n : null;
  } catch {
    return null;
  }
}

function rememberMiningMeta(cache, difficulty, hashrate) {
  try {
    if (difficulty != null && Number(difficulty) > 0) cache.metaSet('last_difficulty', String(difficulty));
    if (hashrate != null && Number(hashrate) > 0) cache.metaSet('last_networkhashps', String(hashrate));
  } catch { /* ignore */ }
}

function lastKnownHashrate(cache) {
  return metaNumber(cache, 'last_networkhashps')
    || hashrateFromDifficulty(metaNumber(cache, 'last_difficulty'));
}

function headerTickers(cache) {
  const market = peekMarket(cache) || {};
  const priceSeries = Array.isArray(market.series) ? market.series.slice(-60) : [];
  const hrSeries = peekHashrateSeries(cache);
  const lastHr = lastKnownHashrate(cache) || (hrSeries.length ? hrSeries[hrSeries.length - 1].v : null);
  return {
    priceLabel: formatUsd(market.price, (market.price) >= 1 ? 2 : 4),
    change24h: market.change24h,
    hashrateLabel: formatHashrate(lastHr),
    priceSpark: spark(priceSeries, 'tkp'),
    hrSpark: spark(hrSeries, 'tkh'),
  };
}
