'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

let ejs;
try { ejs = require('ejs'); } catch { ejs = null; }

describe('EJS templates', { skip: !ejs && 'ejs not installed (npm install)' }, () => {
  it('compile', () => {
    const dir = path.join(__dirname, '..', 'views');
    const files = fs.readdirSync(dir).filter((f) => f.endsWith('.ejs'));
    assert.ok(files.length > 0);
    for (const f of files) {
      const filename = path.join(dir, f);
      ejs.compile(fs.readFileSync(filename, 'utf8'), { filename });
    }
  });
});
