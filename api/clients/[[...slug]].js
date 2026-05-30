// api/clients/[[...slug]].js
const { indexRoute, idRoute } = require('../_lib/crud');
const { getCollection } = require('../_lib/db');

// Cascade: deleting a client also removes their brand details, meta
// accounts, and scheduled posts.
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

module.exports = async (req, res) => {
  const slug = req.query.slug;
  if (!slug || (Array.isArray(slug) && slug.length === 0)) {
    return list(req, res);
  }
  req.query.id = Array.isArray(slug) ? slug[0] : slug;
  return byId(req, res);
};