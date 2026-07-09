// api/_lib/helpers.js
// Small helpers shared across all routes.

// Parse JSON body from a Vercel Node serverless request.
// Vercel auto-parses `application/json` into req.body for most setups,
// but if it doesn't, we parse manually.
async function readBody(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  if (typeof req.body === 'string') {
    try { return JSON.parse(req.body); } catch (_) { return {}; }
  }
  // Fallback: read from stream
  return new Promise((resolve) => {
    let raw = '';
    req.on('data', (chunk) => { raw += chunk; });
    req.on('end', () => {
      try { resolve(raw ? JSON.parse(raw) : {}); }
      catch (_) { resolve({}); }
    });
    req.on('error', () => resolve({}));
  });
}

// Send a JSON response with status code.
function jsonResponse(res, status, data) {
  res.setHeader('Content-Type', 'application/json');
  res.status(status).send(JSON.stringify(data));
}

// CORS — allow the frontend (same origin in production, but useful for
// preview deployments and local testing).
function applyCors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-admin-token');
}

// Wrap an async handler with CORS preflight + error handling.
function withCors(handler) {
  return async (req, res) => {
    applyCors(res);
    if (req.method === 'OPTIONS') {
      res.status(204).end();
      return;
    }
    try {
      await handler(req, res);
    } catch (err) {
      console.error('[API error]', req.url, err);
      jsonResponse(res, 500, { error: err.message || 'Internal server error' });
    }
  };
}

// Optional admin-token check — used only for sensitive operations
// like cron triggers or migration.
function requireAdminToken(req) {
  const expected = process.env.ADMIN_TOKEN;
  if (!expected) return true; // no token configured = open (for local dev)
  const got = req.headers['x-admin-token'] || req.query?.token;
  if (got !== expected) {
    const err = new Error('Unauthorized — missing or invalid x-admin-token');
    err.status = 401;
    throw err;
  }
  return true;
}

// Generate a numeric ID — keeps schema same as the old localStorage one
// where every record had a `.id` integer. We use a counters collection.
async function nextId(getCollection, kind) {
  const counters = await getCollection('config');
  const res = await counters.findOneAndUpdate(
    { _id: `counter_${kind}` },
    { $inc: { value: 1 } },
    { upsert: true, returnDocument: 'after' }
  );
  // Modern driver (v5/v6): `res` IS the updated document.
  // Legacy driver (v4): the document is under `res.value`.
  const doc = (res && res.value && typeof res.value === 'object') ? res.value : res;
  if (doc && typeof doc.value === 'number') return doc.value;
  // Fallback: read it back directly.
  const d = await counters.findOne({ _id: `counter_${kind}` });
  return (d && typeof d.value === 'number') ? d.value : 1;
}

module.exports = {
  readBody,
  jsonResponse,
  applyCors,
  withCors,
  requireAdminToken,
  nextId
};
