'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  hashrateFromDifficulty,
  formatHashrate,
  sampleHeights,
  bytesOnDisk,
} = require('../lib/chainmetrics');
const { TARGET_BLOCK_SEC } = require('../lib/expiry');
const { lineChart } = require('../lib/svgchart');
const { headerTickers, parsePriceRange, slicePriceSeries, statsHref } = require('../lib/statsdata');
const {
  parsePaprikaTicker,
  parsePaprikaHistory,
  parseGeckoPrice,
  parseGeckoMarkets,
  parseGeckoChart,
} = require('../lib/markets');
const { NameCache } = require('../lib/cache');

describe('chainmetrics', () => {
  it('converts difficulty to H/s at the 10-minute target', () => {
    const hs = hashrateFromDifficulty(1);
    assert.equal(hs, (2 ** 32) / TARGET_BLOCK_SEC);
    assert.match(formatHashrate(1e18), /EH\/s/);
    assert.equal(bytesOnDisk(2.5e9), '2.50 GB');
  });

  it('samples inclusive heights without duplicates', () => {
    const h = sampleHeights(100, 200, 5);
    assert.equal(h[0], 100);
    assert.equal(h[h.length - 1], 200);
    assert.equal(new Set(h).size, h.length);
  });
});

describe('svgchart', () => {
  it('draws an area path from two points', () => {
    const c = lineChart([{ t: 1, v: 1 }, { t: 2, v: 3 }], { width: 100, height: 50 });
    assert.match(c.svg, /chart-area/);
    assert.match(c.svg, /chart-line/);
    assert.match(c.svg, /chart-grid/);
    assert.equal(c.last.v, 3);
  });

  it('draws y-axis ticks when formatY is set', () => {
    const c = lineChart([{ t: 1, v: 1 }, { t: 2, v: 3 }], { formatY: (v) => String(v) });
    assert.match(c.svg, /chart-tick/);
  });

  it('returns empty svg for a single point', () => {
    const c = lineChart([{ t: 1, v: 1 }]);
    assert.equal(c.svg, '');
  });

  it('insets spark line and end-dot from the viewBox edge', () => {
    const c = lineChart(
      [{ t: 1, v: 1 }, { t: 2, v: 3 }],
      { width: 72, height: 28, spark: true, padT: 5, padB: 5, padL: 4, padR: 8 },
    );
    assert.match(c.svg, /viewBox="0 0 72 28"/);
    const m = c.svg.match(/class="chart-dot" cx="([\d.]+)" cy="([\d.]+)" r="([\d.]+)"/);
    assert.ok(m);
    const cx = Number(m[1]);
    const cy = Number(m[2]);
    const r = Number(m[3]);
    assert.ok(cx - r > 0);
    assert.ok(cx + r < 72);
    assert.ok(cy - r > 0);
    assert.ok(cy + r < 28);
  });
});

describe('markets parsers', () => {
  it('reads CoinPaprika ticker and daily history', () => {
    const snap = parsePaprikaTicker({
      rank: 400,
      total_supply: 1e7,
      quotes: { USD: { price: 0.91, percent_change_24h: -1.2, volume_24h: 5000, market_cap: 0, ath_price: 5 } },
    });
    assert.equal(snap.price, 0.91);
    assert.equal(snap.change24h, -1.2);
    assert.equal(snap.marketCap, 9.1e6);
    assert.equal(snap.circulating, 1e7);
    const series = parsePaprikaHistory([
      { timestamp: '2024-01-01T00:00:00Z', price: 0.5 },
      { timestamp: '2024-01-02T00:00:00Z', price: 0.6 },
    ]);
    assert.equal(series.length, 2);
    assert.equal(series[1].v, 0.6);
  });

  it('reads CoinGecko simple price and chart pairs', () => {
    const snap = parseGeckoPrice({ namecoin: { usd: 1.1, usd_24h_change: 2, usd_24h_vol: 9, usd_market_cap: 8 } });
    assert.equal(snap.price, 1.1);
    const series = parseGeckoChart({ prices: [[1e12, 1], [1e12 + 1, 2]] });
    assert.equal(series.length, 2);
  });

  it('reads CoinGecko markets rows', () => {
    const snap = parseGeckoMarkets([{
      current_price: 1.2, price_change_percentage_24h: 3, total_volume: 9,
      market_cap: 0, circulating_supply: 1e7, ath: 50, market_cap_rank: 400,
    }]);
    assert.equal(snap.price, 1.2);
    assert.equal(snap.marketCap, 1.2e7);
    assert.equal(snap.ath, 50);
  });
});

describe('NameCache stats series', () => {
  it('stores header difficulty and groups ops by day', () => {
    const cache = new NameCache(':memory:');
    cache.insertBlock({
      header: {
        height: 10, hash: 'h1', time: 86400 * 10, prev: '00', ntx: 1, merkle: 'mm', difficulty: 100,
      },
      ops: [{
        txid: 'tt', vout: 0, op: 'NAME_FIRSTUPDATE', name: 'd/x',
        nameHex: Buffer.from('d/x').toString('hex'), value: '{}', address: 'N1',
      }],
      tipHeight: 10,
    });
    const row = cache.headerAt(10);
    assert.equal(row.difficulty, 100);
    const days = cache.opsPerDay(30);
    assert.equal(days.length, 1);
    assert.equal(days[0].n, 1);
    cache.close();
  });
});

describe('header tickers', () => {
  it('uses last_networkhashps when headers have no difficulty', () => {
    const cache = new NameCache(':memory:');
    cache.metaSet('last_networkhashps', '1500000000000');
    const tk = headerTickers(cache);
    assert.notEqual(tk.hashrateLabel, '—');
    assert.match(tk.hashrateLabel, /H\/s/);
    cache.close();
  });

  it('sparks hashrate from recent header difficulty', () => {
    const cache = new NameCache(':memory:');
    cache.insertBlock({
      header: { height: 10, hash: 'h1', time: 1000, prev: '00', ntx: 1, merkle: 'mm', difficulty: 100 },
      ops: [],
      tipHeight: 10,
    });
    cache.insertBlock({
      header: { height: 11, hash: 'h2', time: 1600, prev: 'h1', ntx: 1, merkle: 'mm', difficulty: 120 },
      ops: [],
      tipHeight: 11,
    });
    const tk = headerTickers(cache);
    assert.equal(tk.priceLabel, '—');
    assert.notEqual(tk.hashrateLabel, '—');
    assert.match(tk.hrSpark.svg, /chart-line/);
    cache.close();
  });
});

describe('price range', () => {
  it('defaults unknown keys to 1y', () => {
    assert.equal(parsePriceRange(), '1y');
    assert.equal(parsePriceRange('nope'), '1y');
    assert.equal(parsePriceRange('7d'), '7d');
  });

  it('slices a daily series to the selected window', () => {
    const day = 86400 * 1000;
    const series = [];
    for (let i = 0; i < 365; i++) series.push({ t: i * day, v: i });
    const week = slicePriceSeries(series, '7d');
    const month = slicePriceSeries(series, '1m');
    const year = slicePriceSeries(series, '1y');
    assert.ok(week.length <= 8);
    assert.ok(week.length >= 2);
    assert.ok(month.length > week.length);
    assert.equal(year.length, 365);
    assert.equal(week[week.length - 1].v, 364);
  });

  it('keeps other chart ranges when one changes', () => {
    const href = statsHref({ range: '7d', hr: '1m', ops: '3m' }, 'ops', '1y');
    assert.equal(href, '/stats?range=7d&hr=1m');
  });

  it('omits 1y from stats URLs as the default', () => {
    assert.equal(statsHref({ range: '1y', hr: '1y', ops: '1y' }, 'range', '1y'), '/stats');
    assert.equal(statsHref({ range: '7d', hr: '1y', ops: '1y' }, 'range', '1y'), '/stats');
    assert.equal(statsHref({ range: '1y', hr: '1y', ops: '1y' }, 'hr', '7d'), '/stats?hr=7d');
  });
});
