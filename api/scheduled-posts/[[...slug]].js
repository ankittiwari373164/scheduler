// api/scheduled-posts/[[...slug]].js
const { indexRoute, idRoute } = require('../_lib/crud');
const { getCollection } = require('../_lib/db');

async function cascade(scheduledPostId) {
  const ph = await getCollection('postHistory');
  await ph.deleteMany({ scheduledPostId });
}

const list = indexRoute('scheduledPosts');
const byId = idRoute('scheduledPosts', cascade);

module.exports = async (req, res) => {
  const slug = req.query.slug;
  if (!slug || (Array.isArray(slug) && slug.length === 0)) {
    return list(req, res);
  }
  req.query.id = Array.isArray(slug) ? slug[0] : slug;
  return byId(req, res);
};