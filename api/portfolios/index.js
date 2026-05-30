// api/portfolios/index.js
// Handles both /api/portfolios (list/create) and /api/portfolios/:id (update/delete)
// via a vercel.json rewrite that routes both paths here.
const { indexRoute, idRoute } = require('../_lib/crud');

const list = indexRoute('portfolios');
const byId = idRoute('portfolios');

function extractId(req) {
  // Vercel passes the rewrite param as req.query.id, but also fall back to URL parsing
  if (req.query && req.query.id) return req.query.id;
  // Parse path: /api/portfolios/123 → "123"
  const url = req.url || '';
  const path = url.split('?')[0];
  const match = path.match(/^\/api\/portfolios\/([^/]+)$/);
  return match ? match[1] : null;
}

module.exports = async (req, res) => {
  const id = extractId(req);
  if (id) {
    req.query.id = id;
    return byId(req, res);
  }
  return list(req, res);
};