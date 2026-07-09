// api/admin/reset.js
// DANGER: wipes all portfolios, clients and their related data so you can start fresh.
// Keeps your settings (config collection: ChatGPT server, Meta token, Google Client ID)
// and the ID counters. Does NOT touch post history unless ?all=1 is passed.
//
// Guarded two ways:
//   1) requires ?confirm=DELETE  (so an accidental request can't wipe anything)
//   2) if ADMIN_TOKEN env is set, also requires header x-admin-token or ?token=
//
// Usage (POST):
//   fetch('/api/admin/reset?confirm=DELETE', {
//     method:'POST', headers:{ 'x-admin-token':'YOUR_ADMIN_TOKEN' }
//   }).then(r=>r.json()).then(console.log)
//
const { getCollection } = require('../_lib/db');
const { withCors, requireAdminToken, jsonResponse } = require('../_lib/helpers');

// Collections cleared on a normal reset (everything tied to clients/portfolios).
const RESET = ['portfolios', 'clients', 'brandDetails', 'metaAccounts', 'scheduledPosts', 'igQueue', 'googleTokens'];
// Additionally cleared only with ?all=1
const RESET_ALL_EXTRA = ['postHistory'];

module.exports = withCors(async (req, res) => {
  if (req.method !== 'POST') return jsonResponse(res, 405, { error: 'Use POST' });
  requireAdminToken(req); // throws 401 if ADMIN_TOKEN set and token missing/wrong

  const confirm = (req.query && req.query.confirm) || '';
  if (confirm !== 'DELETE') {
    return jsonResponse(res, 400, { error: "Add ?confirm=DELETE to actually wipe. Nothing was deleted." });
  }

  const includeAll = req.query && (req.query.all === '1' || req.query.all === 'true');
  const targets = includeAll ? [...RESET, ...RESET_ALL_EXTRA] : RESET;

  const deleted = {};
  for (const name of targets) {
    try {
      const col = await getCollection(name);
      const r = await col.deleteMany({});
      deleted[name] = r.deletedCount || 0;
    } catch (e) {
      deleted[name] = `error: ${e.message}`;
    }
  }

  return jsonResponse(res, 200, {
    ok: true,
    message: 'Reset complete. Settings and ID counters were preserved.',
    deleted,
    keptPostHistory: !includeAll
  });
});
