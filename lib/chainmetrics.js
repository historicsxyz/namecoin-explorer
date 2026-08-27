'use strict';

// SHA-256d hashrate from Namecoin difficulty (same 10-minute target as Bitcoin).
// Merge-mined with Bitcoin, so getnetworkhashps is SHA-256d work on this chain.
const { TARGET_BLOCK_SEC } = require('./expiry');

const TWO32 = 2 ** 32;

function hashrateFromDifficulty(difficulty, blockSec = TARGET_BLOCK_SEC) {
  const d = Number(difficulty);
  const t = Number(blockSec);
  if (!Number.isFinite(d) || d <= 0 || !Number.isFinite(t) || t <= 0) return null;
  return d * TWO32 / t;
}

function formatHashrate(hs) {
  const n = Number(hs);
  if (!Number.isFinite(n) || n <= 0) return '—';
  const units = [
    [1e18, 'EH/s'],
    [1e15, 'PH/s'],
    [1e12, 'TH/s'],
    [1e9, 'GH/s'],
    [1e6, 'MH/s'],
    [1e3, 'kH/s'],
  ];
  for (const [div, unit] of units) {
    if (n >= div) return (n / div).toFixed(n / div >= 100 ? 1 : 2) + ' ' + unit;
  }
  return n.toFixed(0) + ' H/s';
}

function formatDifficulty(d) {
  const n = Number(d);
  if (!Number.isFinite(n) || n <= 0) return '—';
  const units = [
    [1e12, 'T'],
    [1e9, 'B'],
    [1e6, 'M'],
    [1e3, 'k'],
  ];
  for (const [div, unit] of units) {
    if (n >= div) return (n / div).toFixed(n / div >= 100 ? 1 : 2) + ' ' + unit;
  }
  return n.toFixed(2);
}

function formatUsd(n, digits) {
  const x = Number(n);
  if (!Number.isFinite(x)) return '—';
  const d = digits != null ? digits : (Math.abs(x) >= 1 ? 2 : 4);
  return '$' + x.toLocaleString('en-US', {
    minimumFractionDigits: d,
    maximumFractionDigits: d,
  });
}

function formatCompactUsd(n) {
  const x = Number(n);
  if (!Number.isFinite(x)) return '—';
  const abs = Math.abs(x);
  if (abs >= 1e9) return '$' + (x / 1e9).toFixed(2) + 'B';
  if (abs >= 1e6) return '$' + (x / 1e6).toFixed(2) + 'M';
  if (abs >= 1e3) return '$' + (x / 1e3).toFixed(2) + 'k';
  return formatUsd(x);
}

function sampleHeights(minH, maxH, n = 48) {
  const a = Number(minH);
  const b = Number(maxH);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return [];
  if (b <= a) return [b];
  const count = Math.max(2, Math.min(n, b - a + 1));
  const out = [];
  for (let i = 0; i < count; i++) {
    out.push(Math.round(a + (b - a) * i / (count - 1)));
  }
  return [...new Set(out)];
}

function formatInterval(sec) {
  const n = Number(sec);
  if (!Number.isFinite(n) || n <= 0) return '—';
  if (n >= 3600) return (n / 3600).toFixed(1) + ' h';
  if (n >= 90) return (n / 60).toFixed(1) + ' min';
  return Math.round(n) + ' s';
}

function bytesOnDisk(n) {
  const x = Number(n);
  if (!Number.isFinite(x) || x < 0) return '—';
  if (x >= 1e12) return (x / 1e12).toFixed(2) + ' TB';
  if (x >= 1e9) return (x / 1e9).toFixed(2) + ' GB';
  if (x >= 1e6) return (x / 1e6).toFixed(1) + ' MB';
  return Math.round(x / 1024) + ' KB';
}

function fmtNmc(n) {
  if (n == null || n === '') return '—';
  const x = Number(n);
  if (!Number.isFinite(x)) return String(n) + ' NMC';
  const whole = Math.round(x * 1e8) / 1e8;
  let s = whole.toFixed(8).replace(/(\.\d*?)0+$/, '$1').replace(/\.$/, '');
  if (s === '-0') s = '0';
  return s + ' NMC';
}

module.exports = {
  hashrateFromDifficulty,
  formatHashrate,
  formatDifficulty,
  formatUsd,
  formatCompactUsd,
  sampleHeights,
  bytesOnDisk,
  fmtNmc,
  formatInterval,
};
