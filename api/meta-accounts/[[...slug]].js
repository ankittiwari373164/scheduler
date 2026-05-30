// api/meta-accounts/[[...slug]].js
const { indexRoute, idRoute } = require('../_lib/crud');

const list = indexRoute('metaAccounts');
const byId = idRoute('metaAccounts');

module.exports = async (req, res) => {
  const slug = req.query.slug;
  if (!slug || (Array.isArray(slug) && slug.length === 0)) {
    return list(req, res);
  }
  req.query.id = Array.isArray(slug) ? slug[0] : slug;
  return byId(req, res);
};