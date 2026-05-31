// api/clients/index.js
// Handles both /api/clients and /api/clients/:id
const { indexRoute, idRoute } = require('../_lib/crud');
const { getCollection } = require('../_lib/db');

async function cascade(clientId) {
  const numId = parseInt(clientId, 10);
  const strId = String(clientId);
  // Match clientId stored as either integer or string (legacy migration compat)
  const filter = { $or: [{ clientId: numId }, { clientId: strId }] };

  const [bd, ma, sp] = await Promise.all([
    getCollection('brandDetails'),
    getCollection('metaAccounts'),
    getCollection('scheduledPosts')
  ]);
  await Promise.all([
    bd.deleteMany(filter),
    ma.deleteMany(filter),
    sp.deleteMany(filter)
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