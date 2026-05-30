// api/portfolios/[[...slug]].js
// Catch-all route — handles both /api/portfolios and /api/portfolios/:id
const { indexRoute, idRoute } = require('../_lib/crud');

const list = indexRoute('portfolios');
const byId = idRoute('portfolios');

module.exports = async (req, res) => {
  const slug = req.query.slug;
  // /api/portfolios → list/create
  if (!slug || (Array.isArray(slug) && slug.length === 0)) {
    return list(req, res);
  }
  // /api/portfolios/:id → update/delete
  const id = Array.isArray(slug) ? slug[0] : slug;
  req.query.id = id;
  return byId(req, res);
};