'use strict';

// Browser tabs send Accept: text/html and Chromium's JSON viewer can render
// white-on-white. curl/fetch keep application/json. ?format=json forces raw.

function wantsHtml(req) {
  const q = req.query || {};
  if (q.format === 'json' || q.raw === '1') return false;
  const accept = String(req.get ? req.get('accept') : '' || '');
  if (/\bapplication\/json\b/i.test(accept)) return false;
  return /\btext\/html\b/i.test(accept);
}

function sendApiJson(req, res, data, status = 200) {
  if (status !== 200) res.status(status);
  if (!wantsHtml(req)) return res.json(data);
  res.locals.page = 'api';
  const pathOnly = String(req.originalUrl || req.url || '').split('?')[0];
  const title = (res.locals.t && res.locals.t('api.title')) || 'JSON API';
  return res.render('api-json', {
    title,
    payload: JSON.stringify(data, null, 2),
    path: pathOnly,
  });
}

module.exports = { wantsHtml, sendApiJson };
