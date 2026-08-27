'use strict';

// JSON-RPC client for namecoind.
// Fail-loud on RPC errors. Bounded concurrency (not a global mutex).
// Always-hex name/value encodings on name RPCs (Core issue #246).
const http = require('http');
const fs = require('fs');

const HEX_OPTS = { nameEncoding: 'hex', valueEncoding: 'hex' };
const SHOW_OPTS = { ...HEX_OPTS, allowExpired: true };

class RpcError extends Error {
  constructor(code, message, data) {
    super(message);
    this.name = 'RpcError';
    this.code = code;
    this.data = data;
  }
}

function nameToHex(name) {
  return Buffer.from(String(name), 'utf8').toString('hex');
}

function hexToName(hexStr) {
  try { return Buffer.from(String(hexStr), 'hex').toString('utf8'); }
  catch { return hexStr; }
}

function decodeRecord(obj) {
  if (!obj || typeof obj !== 'object') return obj;
  const o = { ...obj };
  delete o.ismine;
  if ((o.name_encoding === 'hex' || o.nameEncoding === 'hex') && typeof o.name === 'string') {
    o.name_hex = o.name;
    o.name = hexToName(o.name);
  }
  if ((o.value_encoding === 'hex' || o.valueEncoding === 'hex') && o.value != null) {
    o.value_hex = o.value;
    o.value = hexToName(String(o.value));
  }
  return o;
}

function decodeList(arr) {
  return Array.isArray(arr) ? arr.map(decodeRecord) : arr;
}

class NamecoinRPC {
  constructor({
    host = '127.0.0.1',
    port = 8336,
    user,
    pass,
    cookiePath = null,
    timeout = 30000,
    concurrency = 4,
    maxWait = 64,
  } = {}) {
    this.host = host;
    this.port = port;
    this.user = user;
    this.pass = pass;
    this.cookiePath = cookiePath;
    this.timeout = timeout;
    this.concurrency = Math.max(1, concurrency);
    this.maxWait = Math.max(0, Number(maxWait) || 0);
    this._id = 0;
    this._credsCache = null;
    this._active = 0;
    this._wait = [];
  }

  _credentials() {
    if (this._credsCache) return this._credsCache;
    let user = this.user;
    let pass = this.pass;
    if (!pass && this.cookiePath) {
      try {
        const line = fs.readFileSync(this.cookiePath, 'utf8').trim();
        const idx = line.indexOf(':');
        user = line.slice(0, idx);
        pass = line.slice(idx + 1);
      } catch (e) {
        console.error(new Date().toISOString(), 'rpc', 'Could not read cookie file', this.cookiePath, e.message);
      }
    }
    this._credsCache = { user, pass };
    return this._credsCache;
  }

  _invalidateCreds() {
    this._credsCache = null;
  }

  _acquire() {
    if (this._active < this.concurrency) {
      this._active++;
      return Promise.resolve();
    }
    if (this._wait.length >= this.maxWait) {
      const err = new Error('RPC busy');
      err.code = 'RPC_BUSY';
      return Promise.reject(err);
    }
    return new Promise((resolve) => this._wait.push(resolve)).then(() => {
      this._active++;
    });
  }

  _release() {
    this._active--;
    const next = this._wait.shift();
    if (next) next();
  }

  async call(method, params = []) {
    await this._acquire();
    try {
      try {
        return await this._rawCall(method, params);
      } catch (e) {
        if (e && e.code === 'HTTP_401') {
          this._invalidateCreds();
          return await this._rawCall(method, params);
        }
        throw e;
      }
    } finally {
      this._release();
    }
  }

  _rawCall(method, params) {
    return new Promise((resolve, reject) => {
      if (typeof params === 'string') params = [params];
      if (params === undefined) params = [];
      if (!Array.isArray(params)) params = [params];
      const id = ++this._id;
      const body = Buffer.from(JSON.stringify({ jsonrpc: '2.0', id, method, params }));
      const { user, pass } = this._credentials();
      const req = http.request({
        host: this.host,
        port: this.port,
        path: '/',
        method: 'POST',
        auth: `${user}:${pass}`,
        headers: {
          'content-type': 'application/json',
          'content-length': body.length,
        },
        timeout: this.timeout,
      }, (res) => {
        let data = '';
        res.on('data', (c) => (data += c));
        res.on('end', () => {
          if (res.statusCode === 401) {
            const err = new Error(`RPC HTTP 401 on ${method}`);
            err.code = 'HTTP_401';
            return reject(err);
          }
          try {
            const parsed = JSON.parse(data);
            if (parsed.error) {
              return reject(new RpcError(parsed.error.code, parsed.error.message, parsed.error.data));
            }
            resolve(parsed.result);
          } catch (e) {
            reject(new Error(`Invalid RPC response for ${method}: ${data.slice(0, 200)}`));
          }
        });
      });
      req.on('error', reject);
      req.on('timeout', () => req.destroy(new Error(`RPC timeout on ${method}`)));
      req.write(body);
      req.end();
    });
  }

  nameShow(name) {
    return this.call('name_show', [nameToHex(name), SHOW_OPTS]).then(decodeRecord);
  }

  nameHistory(name) {
    return this.call('name_history', [nameToHex(name), HEX_OPTS]).then(decodeList);
  }

  nameScan(start = '', count = 500) {
    const startArg = start ? nameToHex(start) : '';
    return this.call('name_scan', [startArg, count, HEX_OPTS]).then(decodeList);
  }

  namePending(name) {
    const p = name
      ? this.call('name_pending', [nameToHex(name), HEX_OPTS])
      : this.call('name_pending', ['', HEX_OPTS]);
    return p.then(decodeList);
  }
}

module.exports = {
  NamecoinRPC,
  RpcError,
  nameToHex,
  hexToName,
  HEX_OPTS,
  SHOW_OPTS,
};
