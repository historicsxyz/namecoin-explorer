'use strict';

// Per-IP token bucket. Bounded map so it cannot grow without limit.

function tokenBucket({
  windowMs = 60 * 1000,
  max = 60,
  maxKeys = 20000,
  skip,
} = {}) {
  const buckets = new Map();
  const window = Math.max(1000, Number(windowMs) || 60000);
  const cap = Math.max(1, Number(max) || 60);
  const keyCap = Math.max(16, Number(maxKeys) || 20000);

  return function rateLimit(req, res, next) {
    if (typeof skip === 'function' && skip(req)) return next();
    const ip = req.ip || (req.socket && req.socket.remoteAddress) || '0.0.0.0';
    const now = Date.now();
    let b = buckets.get(ip);
    if (!b) {
      if (buckets.size >= keyCap) buckets.delete(buckets.keys().next().value);
      b = { tokens: cap, at: now };
      buckets.set(ip, b);
    } else {
      buckets.delete(ip);
      buckets.set(ip, b);
    }
    const refill = ((now - b.at) / window) * cap;
    b.tokens = Math.min(cap, b.tokens + refill);
    b.at = now;
    if (b.tokens < 1) {
      const retry = Math.max(1, Math.ceil(((1 - b.tokens) / cap) * window / 1000));
      res.set('Retry-After', String(retry));
      res.set('Cache-Control', 'no-store');
      if (res.headersSent) return;
      res.status(429).type('text/plain').send('Too many requests');
      return;
    }
    b.tokens -= 1;
    next();
  };
}

function rateLimitEnabled(env = process.env) {
  const raw = String(env.NMC_RATE_LIMIT || '').toLowerCase();
  if (raw === '0' || raw === 'off' || raw === 'false') return false;
  if (env.NODE_ENV === 'test' && raw === '') return false;
  return true;
}

module.exports = { tokenBucket, rateLimitEnabled };
