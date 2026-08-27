'use strict';

// Flat SVG area/line charts. No shadows. Accent stroke, muted fill.
let chartSeq = 0;

const MS_DAY = 86400 * 1000;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const RANGE_KEYS = { '7d': 1, '1m': 1, '3m': 1, '1y': 1 };

function seriesExtent(points) {
  const vals = points.map((p) => p.v).filter((v) => Number.isFinite(v));
  if (!vals.length) return { min: 0, max: 1 };
  let min = Math.min(...vals);
  let max = Math.max(...vals);
  if (min === max) {
    min = min * 0.9;
    max = max * 1.1 || 1;
  }
  const pad = (max - min) * 0.08;
  return { min: min - pad, max: max + pad };
}

function esc(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function utcParts(ms) {
  const d = new Date(ms);
  return { y: d.getUTCFullYear(), m: d.getUTCMonth(), d: d.getUTCDate() };
}

function startOfUtcDay(ms) {
  const p = utcParts(ms);
  return Date.UTC(p.y, p.m, p.d);
}

function startOfUtcMonth(ms) {
  const p = utcParts(ms);
  return Date.UTC(p.y, p.m, 1);
}

function addUtcDays(ms, n) {
  const p = utcParts(ms);
  return Date.UTC(p.y, p.m, p.d + n);
}

function addUtcMonths(ms, n) {
  const p = utcParts(ms);
  return Date.UTC(p.y, p.m + n, 1);
}

function fmtDay(ms, withMonth) {
  const p = utcParts(ms);
  return withMonth ? p.d + ' ' + MONTHS[p.m] : String(p.d);
}

function fmtMonth(ms, withYear) {
  const p = utcParts(ms);
  return withYear ? MONTHS[p.m] + ' \'' + String(p.y).slice(2) : MONTHS[p.m];
}

function inferRangeKey(span, rangeKey) {
  if (RANGE_KEYS[rangeKey]) {
    const order = { '7d': 0, '1m': 1, '3m': 2, '1y': 3 };
    let inferred = '1y';
    if (span <= 10 * MS_DAY) inferred = '7d';
    else if (span <= 40 * MS_DAY) inferred = '1m';
    else if (span <= 110 * MS_DAY) inferred = '3m';
    return order[inferred] < order[rangeKey] ? inferred : rangeKey;
  }
  if (span <= 10 * MS_DAY) return '7d';
  if (span <= 40 * MS_DAY) return '1m';
  if (span <= 110 * MS_DAY) return '3m';
  return '1y';
}

function pushTick(out, t, label) {
  const last = out[out.length - 1];
  if (last && Math.abs(t - last.t) < 12 * 3600 * 1000) return;
  out.push({ t, label });
}

function evenTimeTicks(t0, t1, n, kind) {
  const out = [];
  const steps = Math.max(2, n) - 1;
  for (let i = 0; i <= steps; i++) {
    const t = t0 + (i / steps) * (t1 - t0);
    const label = kind === 'day' ? fmtDay(t, i === 0 || utcParts(t).m !== utcParts(t0).m)
      : fmtMonth(t, i === 0 || utcParts(t).y !== utcParts(t0).y);
    out.push({ t, label });
  }
  return out;
}

function timeTicks(t0, t1, rangeKey) {
  if (!(t1 > t0)) return [];
  const key = inferRangeKey(t1 - t0, rangeKey);
  const out = [];

  if (key === '7d') {
    pushTick(out, t0, fmtDay(t0, true));
    let t = addUtcDays(startOfUtcDay(t0), 1);
    while (t < t1 - 6 * 3600 * 1000) {
      const prev = out[out.length - 1];
      const showMon = !prev || utcParts(prev.t).m !== utcParts(t).m;
      pushTick(out, t, fmtDay(t, showMon));
      t = addUtcDays(t, 1);
    }
    const last = out[out.length - 1];
    if (!last || t1 - last.t > 10 * 3600 * 1000) {
      const showMon = !last || utcParts(last.t).m !== utcParts(t1).m;
      pushTick(out, t1, fmtDay(t1, showMon));
    }
  } else if (key === '1m') {
    pushTick(out, t0, fmtDay(t0, true));
    let t = addUtcDays(startOfUtcDay(t0), 7);
    while (t < t1 - MS_DAY) {
      pushTick(out, t, fmtDay(t, true));
      t = addUtcDays(t, 7);
    }
    const last = out[out.length - 1];
    if (!last || t1 - last.t > 3 * MS_DAY) pushTick(out, t1, fmtDay(t1, true));
  } else if (key === '3m') {
    pushTick(out, t0, fmtDay(t0, true));
    let t = addUtcDays(startOfUtcDay(t0), 14);
    while (t < t1 - MS_DAY) {
      pushTick(out, t, fmtDay(t, true));
      t = addUtcDays(t, 14);
    }
    const last = out[out.length - 1];
    if (!last || t1 - last.t > 6 * MS_DAY) pushTick(out, t1, fmtDay(t1, true));
  } else {
    const monthStep = (t1 - t0) > 240 * MS_DAY ? 2 : 1;
    let t = startOfUtcMonth(t0);
    if (t < t0) t = addUtcMonths(t, 1);
    while (t <= t1) {
      const prev = out[out.length - 1];
      const showY = !prev || utcParts(prev.t).y !== utcParts(t).y;
      pushTick(out, t, fmtMonth(t, showY || out.length === 0));
      t = addUtcMonths(t, monthStep);
    }
    if (out[0]) out[0].label = fmtMonth(out[0].t, true);
  }

  if (out.length < 2) {
    const kind = (t1 - t0) <= 40 * MS_DAY ? 'day' : 'month';
    return evenTimeTicks(t0, t1, 4, kind);
  }
  return out;
}

function spaceTimeTicks(ticks, xOf, minDx) {
  if (!ticks.length) return [];
  const placed = [];
  let lastX = -Infinity;
  for (const tick of ticks) {
    const x = xOf(tick.t);
    if (placed.length && x - lastX < minDx) continue;
    placed.push({ ...tick, x });
    lastX = x;
  }
  const last = ticks[ticks.length - 1];
  const lastXWanted = xOf(last.t);
  if (!placed.length || placed[placed.length - 1].t !== last.t) {
    while (placed.length && lastXWanted - placed[placed.length - 1].x < minDx) placed.pop();
    placed.push({ ...last, x: lastXWanted });
  }
  return placed;
}

function xAnchor(x, padL, iw) {
  const rel = (x - padL) / (iw || 1);
  if (rel < 0.06) return 'start';
  if (rel > 0.94) return 'end';
  return 'middle';
}

function lineChart(points, {
  width = 640,
  height = 200,
  padL,
  padR,
  padT = 14,
  padB,
  formatY,
  range,
  spark = false,
  gid: gidOpt,
} = {}) {
  const pts = (points || []).filter((p) => Number.isFinite(p.t) && Number.isFinite(p.v));
  const empty = {
    svg: '', min: null, max: null, dataMin: null, dataMax: null, first: null, last: null,
  };
  if (!pts.length) return empty;
  const dataMin = Math.min(...pts.map((p) => p.v));
  const dataMax = Math.max(...pts.map((p) => p.v));
  if (pts.length < 2) {
    return { ...empty, dataMin, dataMax, first: pts[0], last: pts[0] };
  }
  const t0 = pts[0].t;
  const t1 = pts[pts.length - 1].t;
  const drawX = !spark && (Boolean(range) || t0 > 1e12);
  if (padL == null) padL = (!spark && formatY) ? 62 : (spark ? 2 : 8);
  if (padR == null) padR = spark ? 10 : (drawX ? 16 : 10);
  if (padB == null) padB = spark ? 10 : (drawX ? 28 : 10);
  const { min, max } = seriesExtent(pts);
  const spanT = t1 - t0 || 1;
  const spanV = max - min || 1;
  const iw = width - padL - padR;
  const ih = height - padT - padB;
  const xy = pts.map((p) => {
    const x = padL + ((p.t - t0) / spanT) * iw;
    const y = padT + (1 - (p.v - min) / spanV) * ih;
    return [x, y];
  });
  const line = xy.map((p, i) => (i ? 'L' : 'M') + p[0].toFixed(1) + ' ' + p[1].toFixed(1)).join(' ');
  const baseY = (padT + ih).toFixed(1);
  const area = line
    + ' L' + xy[xy.length - 1][0].toFixed(1) + ' ' + baseY
    + ' L' + xy[0][0].toFixed(1) + ' ' + baseY + ' Z';
  const gid = gidOpt || ('cg' + (++chartSeq));
  const last = xy[xy.length - 1];

  let grid = '';
  let ticks = '';
  if (!spark) {
    for (let i = 0; i <= 3; i++) {
      const y = padT + (i / 3) * ih;
      grid += `<line class="chart-grid" x1="${padL}" y1="${y.toFixed(1)}" x2="${(padL + iw).toFixed(1)}" y2="${y.toFixed(1)}"/>`;
    }
    if (drawX) {
      const xOf = (t) => padL + ((t - t0) / spanT) * iw;
      const xt = spaceTimeTicks(timeTicks(t0, t1, range), xOf, 52);
      for (const tick of xt) {
        if (tick.x > padL + 1 && tick.x < padL + iw - 1) {
          grid += `<line class="chart-grid chart-grid-x" x1="${tick.x.toFixed(1)}" y1="${padT}" x2="${tick.x.toFixed(1)}" y2="${baseY}"/>`;
        }
        const anchor = xAnchor(tick.x, padL, iw);
        ticks += `<text class="chart-tick chart-tick-x" x="${tick.x.toFixed(1)}" y="${(padT + ih + 16).toFixed(1)}" text-anchor="${anchor}">${esc(tick.label)}</text>`;
      }
    }
    if (formatY) {
      const vals = [dataMax, (dataMin + dataMax) / 2, dataMin];
      for (const v of vals) {
        const y = padT + (1 - (v - min) / spanV) * ih;
        ticks += `<text class="chart-tick" x="${(padL - 6).toFixed(1)}" y="${(y + 3).toFixed(1)}" text-anchor="end">${esc(formatY(v))}</text>`;
      }
    }
  }

  const svg = `<svg class="chart-svg${spark ? ' chart-spark-svg' : ''}" viewBox="0 0 ${width} ${height}" width="100%" height="${height}" preserveAspectRatio="none" overflow="visible" role="img">
  <defs>
    <linearGradient id="${gid}" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="currentColor" stop-opacity="0.32"/>
      <stop offset="100%" stop-color="currentColor" stop-opacity="0.02"/>
    </linearGradient>
  </defs>
  ${grid}
  <path class="chart-area" fill="url(#${gid})" d="${area}"/>
  <path class="chart-line" d="${line}"/>
  <circle class="chart-dot" cx="${last[0].toFixed(1)}" cy="${last[1].toFixed(1)}" r="${spark ? 1.8 : 3.5}"/>
  ${ticks}
</svg>`;
  return {
    svg,
    min,
    max,
    dataMin,
    dataMax,
    first: pts[0],
    last: pts[pts.length - 1],
  };
}

module.exports = { lineChart, seriesExtent, timeTicks };
