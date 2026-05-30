// api/clients/index.js
// Handles both /api/clients and /api/clients/:id
const { indexRoute, idRoute } = require('../_lib/crud');
const { getCollection } = require('../_lib/db');

async function cascade(clientId) {
  const bd = await getCollection('brandDetails');
  const ma = await getCollection('metaAccounts');
  const sp = await getCollection('scheduledPosts');
  await Promise.all([
    bd.deleteMany({ clientId }),
    ma.deleteMany({ clientId }),
    sp.deleteMany({ clientId })
  ]);
}

const list = indexRoute('clients');
const byId = idRoute('clients', cascade);

function extractId(req) {
  if (req.query && req.query.id) return req.query.id;
  const path = (req.url || '').split('?')[0];
  const match = path.match(/^\/api\/clients\/([^/]+)$/);
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