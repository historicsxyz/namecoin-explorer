'use strict';

// Rasterize public/og.svg → public/og.png for crawlers that ignore SVG.
const fs = require('fs');
const path = require('path');

async function main() {
  let playwright;
  try { playwright = require('playwright'); }
  catch (e) {
    console.error('playwright is required: npm install');
    process.exit(1);
  }

  const svg = fs.readFileSync(path.join(__dirname, '..', 'public', 'og.svg'), 'utf8');
  const out = path.join(__dirname, '..', 'public', 'og.png');
  const html = `<!DOCTYPE html><html><head><style>
    html,body{margin:0;padding:0;background:#e6ebf1;width:1200px;height:630px;overflow:hidden}
    svg{display:block}
  </style></head><body>${svg}</body></html>`;

  const browser = await playwright.chromium.launch({ channel: 'msedge' }).catch(() =>
    playwright.chromium.launch(),
  );
  const page = await browser.newPage({
    viewport: { width: 1200, height: 630 },
    deviceScaleFactor: 1,
  });
  await page.setContent(html, { waitUntil: 'load' });
  await page.screenshot({ path: out, type: 'png', omitBackground: false });
  await browser.close();
  const st = fs.statSync(out);
  console.log('wrote', out, st.size, 'bytes');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
