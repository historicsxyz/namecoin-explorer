'use strict';

// Consensus expiry: 36_000 blocks after last update (Namecoin Core).
// FAQ semi-expire: names stop resolving 4_032 blocks before consensus expiry.
const NAME_EXPIRY_DEPTH = 36000;
const SEMI_EXPIRE_WINDOW = 4032;

function expiresIn(updateHeight, tipHeight) {
  if (updateHeight == null || tipHeight == null) return null;
  return (Number(updateHeight) + NAME_EXPIRY_DEPTH) - Number(tipHeight);
}

function isExpired(updateHeight, tipHeight) {
  const e = expiresIn(updateHeight, tipHeight);
  return e != null && e <= 0;
}

function isSemiExpired(updateHeight, tipHeight) {
  const e = expiresIn(updateHeight, tipHeight);
  return e != null && e > 0 && e <= SEMI_EXPIRE_WINDOW;
}

function expiryStatus(updateHeight, tipHeight) {
  const e = expiresIn(updateHeight, tipHeight);
  if (e == null) return 'unknown';
  if (e <= 0) return 'expired';
  if (e <= SEMI_EXPIRE_WINDOW) return 'expiring';
  return 'live';
}

function parseNamespace(name) {
  if (typeof name !== 'string') return { prefix: '', namespace: '(root)', full: name || '(empty)' };
  const slash = name.indexOf('/');
  if (slash === -1) return { prefix: '', namespace: '(root)', full: name };
  return { prefix: name.slice(0, slash), namespace: name.slice(0, slash) + '/', full: name };
}

module.exports = {
  NAME_EXPIRY_DEPTH,
  NAME_EXPIRY_DEPTH: NAME_EXPIRY_DEPTH,
  SEMI_EXPIRE_WINDOW,
  SEMI_EXPIRE_WINDOW: SEMI_EXPIRE_WINDOW,
  expiresIn,
  isExpired,
  isSemiExpired,
  expiryStatus,
  expiryStatus,
  parseNamespace,
};
