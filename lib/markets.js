'use strict';

// NMC/USD from public CoinPaprika (no key). CoinGecko is the fallback.
// Cached in SQLite meta so a 429 does not blank the page.
const PAPRIKA_TICKER = 'https://api.coinpaprika.com/v1/tickers/nmc-namecoin';
const GECKO_CHART = 'https://api.coingecko.com/api/v3/coins/namecoin/market_chart?vs_currency=usd&days=365&interval=daily';
const GECKO_MARKETS = 'https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&ids=namecoin';
const GECKO_PRICE = 'https://api.coingecko.com/api/v3/simple/price?ids=namecoin&vs_currencies=usd&include_24hr_change=true&include_market_cap=true&include_24hr_vol=true';
const TTL_MS = 15 * 60 * 1000;
const META_JSON = 'market_json_v3';
const META_AT = 'market_at';

function ua() {
  try { return 'namecoin-explorer/' + require('../package.json').version; }
  catch { return 'namecoin-explorer'; }
}

async function fetchJson(url, timeoutMs = 8000) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: ac.signal,
      headers: { accept: 'application/json', 'user-agent': ua() },
    });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    return await res.json();
  } finally {
    clearTimeout(t);
  }
}

function paprikaStartIso() {
  const d = new Date(Date.now() - 365 * 86400 * 1000);
  return d.toISOString().slice(0, 10);
}

function deriveMarketCap(price, circulating, reported) {
  const cap = Number(reported);
  if (Number.isFinite(cap) && cap > 0) return cap;
  const p = Number(price);
  const c = Number(circulating);
  if (Number.isFinite(p) && p > 0 && Number.isFinite(c) && c > 0) return p * c;
  return Number.isFinite(cap) ? cap : null;
}

function parsePaprikaTicker(body) {
  const q = body && body.quotes && body.quotes.USD;
  if (!q || q.price == null) return null;
  const circulating = body.circulating_supply != null ? Number(body.circulating_supply)
    : (body.total_supply != null ? Number(body.total_supply) : null);
  return {
    price: Number(q.price),
    change24h: q.percent_change_24h != null ? Number(q.percent_change_24h) : null,
    volume24h: q.volume_24h != null ? Number(q.volume_24h) : null,
    marketCap: deriveMarketCap(q.price, circulating, q.market_cap),
    ath: q.ath_price != null ? Number(q.ath_price) : null,
    rank: body.rank != null ? Number(body.rank) : null,
    circulating,
    source: 'coinpaprika',
  };
}

function parsePaprikaHistory(arr) {
  if (!Array.isArray(arr)) return [];
  return arr.map((row) => {
    const t = Date.parse(row.timestamp);
    return { t: Number.isFinite(t) ? t : null, v: Number(row.price) };
  }).filter((p) => p.t != null && Number.isFinite(p.v));
}

function parseGeckoPrice(body) {
  const n = body && body.namecoin;
  if (!n || n.usd == null) return null;
  return {
    price: Number(n.usd),
    change24h: n.usd_24h_change != null ? Number(n.usd_24h_change) : null,
    volume24h: n.usd_24h_vol != null ? Number(n.usd_24h_vol) : null,
    marketCap: n.usd_market_cap != null ? Number(n.usd_market_cap) : null,
    ath: null,
    rank: null,
    circulating: null,
    source: 'coingecko',
  };
}

function parseGeckoMarkets(body) {
  const n = Array.isArray(body) ? body[0] : null;
  if (!n || n.current_price == null) return null;
  const circulating = n.circulating_supply != null ? Number(n.circulating_supply) : null;
  return {
    price: Number(n.current_price),
    change24h: n.price_change_percentage_24h != null ? Number(n.price_change_percentage_24h) : null,
    volume24h: n.total_volume != null ? Number(n.total_volume) : null,
    marketCap: deriveMarketCap(n.current_price, circulating, n.market_cap),
    ath: n.ath != null ? Number(n.ath) : null,
    rank: n.market_cap_rank != null ? Number(n.market_cap_rank) : null,
    circulating,
    source: 'coingecko',
  };
}

function parseGeckoChart(body) {
  const prices = body && body.prices;
  if (!Array.isArray(prices)) return [];
  return prices.map((p) => ({ t: Number(p[0]), v: Number(p[1]) }))
    .filter((p) => Number.isFinite(p.t) && Number.isFinite(p.v));
}

function readCache(cache) {
  try {
    const at = Number(cache.metaGet(META_AT) || 0);
    const raw = cache.metaGet(META_JSON);
    if (!raw || !at) return null;
    return { fresh: Date.now() - at < TTL_MS, data: JSON.parse(raw), at };
  } catch {
    return null;
  }
}

function writeCache(cache, data) {
  try {
    cache.metaSet(META_JSON, JSON.stringify(data));
    cache.metaSet(META_AT, String(Date.now()));
  } catch { /* read-only replica */ }
}

async function fetchPaprikaTicker() {
  const ticker = await fetchJson(PAPRIKA_TICKER);
  const snap = parsePaprikaTicker(ticker);
  if (!snap) throw new Error('paprika ticker empty');
  return snap;
}

async function fetchPaprikaSeries() {
  const histUrl = PAPRIKA_TICKER + '/historical?start=' + paprikaStartIso() + '&interval=1d';
  return parsePaprikaHistory(await fetchJson(histUrl));
}

async function fetchGecko() {
  const [markets, chart] = await Promise.all([
    fetchJson(GECKO_MARKETS),
    fetchJson(GECKO_CHART),
  ]);
  let snap = parseGeckoMarkets(markets);
  if (!snap) snap = parseGeckoPrice(await fetchJson(GECKO_PRICE));
  const series = parseGeckoChart(chart);
  if (!snap) throw new Error('gecko price empty');
  return { ...snap, series };
}

function peekMarket(cache) {
  const cached = cache ? readCache(cache) : null;
  if (!cached || !cached.data) return null;
  return { ...cached.data, stale: !cached.fresh };
}

async function loadMarket(cache, env = process.env) {
  const off = String(env.NMC_MARKET || '').toLowerCase();
  if (off === '0' || off === 'off' || off === 'false') return { disabled: true };
  const cached = cache ? readCache(cache) : null;
  if (cached && cached.fresh) return cached.data;
  try {
    let data;
    try {
      const snap = await fetchPaprikaTicker();
      let series = [];
      let seriesFrom = snap.source;
      try { series = await fetchPaprikaSeries(); }
      catch { /* free Paprika plan often blocks 1y daily history */ }
      if (series.length < 2) {
        const g = await fetchGecko();
        series = g.series || [];
        seriesFrom = g.source || 'coingecko';
        if (g.ath > 0 && (!(snap.ath > 0) || g.ath > snap.ath)) snap.ath = g.ath;
        if (!(snap.volume24h > 0) && g.volume24h > 0) snap.volume24h = g.volume24h;
      }
      data = { ...snap, series, seriesFrom };
    } catch {
      data = await fetchGecko();
    }
    if (cache) writeCache(cache, data);
    return data;
  } catch (e) {
    if (cached && cached.data) return { ...cached.data, stale: true, error: e.message };
    return { error: e.message, series: [] };
  }
}

module.exports = {
  loadMarket,
  peekMarket,
  parsePaprikaTicker,
  parsePaprikaHistory,
  parseGeckoPrice,
  parseGeckoMarkets,
  parseGeckoChart,
  deriveMarketCap,
  paprikaStartIso,
  TTL_MS,
};
