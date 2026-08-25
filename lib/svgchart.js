'use strict';

// Flat SVG area/line charts. No shadows. Accent stroke, muted fill.
let chartSeq = 0;

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

function lineChart(points, {
  width = 640,
  height = 200,
  padL,
  padR = 10,
  padT = 14,
  padB = 10,
  formatY,
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
  if (padL == null) padL = (!spark && formatY) ? 62 : (spark ? 2 : 8);
  const { min, max } = seriesExtent(pts);
  const t0 = pts[0].t;
  const t1 = pts[pts.length - 1].t;
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
    if (formatY) {
      const vals = [dataMax, (dataMin + dataMax) / 2, dataMin];
      for (const v of vals) {
        const y = padT + (1 - (v - min) / spanV) * ih;
        ticks += `<text class="chart-tick" x="${(padL - 6).toFixed(1)}" y="${(y + 3).toFixed(1)}" text-anchor="end">${esc(formatY(v))}</text>`;
      }
    }
  }

  const svg = `<svg class="chart-svg${spark ? ' chart-spark-svg' : ''}" viewBox="0 0 ${width} ${height}" width="100%" height="${height}" preserveAspectRatio="${spark ? 'xMidYMid meet' : 'none'}" overflow="visible" role="img">
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

module.exports = { lineChart, seriesExtent };
