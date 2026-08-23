'use strict';

// Hardened JSON-RPC client for namecoind.
// Key design points:
//  - Always errors on RPC-level errors (fail loud, never silently return "none")
//  - Explicit hex <-> name encoding helpers (avoids the 2011/2012 'available?' bug)
//  - Connection reused, sequential queue to respect node limits
const http = require('http');
const crypto = require('crypto');
const fs = require('fs');

const LOG = (...a) => console.log(new Date().toISOString(), 'rpc', ...a);

class RpcError extends Error {
  constructor(code, message, data) {
    super(message);
    this.name = 'RpcError';
    this.code = code;
    this.data = data;
  }
}

class NamecoinRPC {
  constructor({ host = '127.0.0.1', port = 8336, user, pass, cookiePath = null, timeout = 20000 } = {}) {
    this.host = host;
    this.port = port;
    this.user = user;
    this.pass = pass;
    this.cookiePath = cookiePath;
    this.timeout = timeout;
    this._id = 0;
    this._credsCache = null;
    this._queue = Promise.resolve();
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
        LOGIN('Could not read cookie file', this.cookiePath, e.message);
      }
    }
    this._credsCache = { user, pass };
    return this._credsCache;
  }

  // Execute a single RPC call. Returns parsed result (throws RpcError on node error).
  call(method, params = []) {
    // serialize through the queue
    const run = () => this._rawCall(method, params);
    const p = this._queue.then(run, run);
    // keep chain alive but don't propagate to the queue
    this._queue = p.then(() => {}, () => {});
    return p;
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
          try {
            const parsed = JSON.parse(data);
            if (parsed.error) {
              const e = new RpcError(parsed.error.code, parsed.error.message, parsed.error.data);
              return reject(e);
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
}

// ---- helpers ----
const nameToHex = (name) => Buffer.from(name, 'utf8').toString('hex');
const hexToName = (hexStr) => {
  try { return Buffer.from(hexStr, 'hex').toString('utf8'); }
  catch { return hexStr; }
};

module.exports = { NamecoinRPC, RpcError, nameToHex, hexToName };