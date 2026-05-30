// api/meta-accounts/index.js
// Handles both /api/meta-accounts and /api/meta-accounts/:id
const { indexRoute, idRoute } = require('../_lib/crud');

const list = indexRoute('metaAccounts');
const byId = idRoute('metaAccounts');

function extractId(req) {
  if (req.query && req.query.id) return req.query.id;
  const path = (req.url || '').split('?')[0];
  const match = path.match(/^\/api\/meta-accounts\/([^/]+)$/);
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