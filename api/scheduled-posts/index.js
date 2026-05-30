// api/scheduled-posts/index.js
// Handles both /api/scheduled-posts and /api/scheduled-posts/:id
const { indexRoute, idRoute } = require('../_lib/crud');
const { getCollection } = require('../_lib/db');

async function cascade(scheduledPostId) {
  const ph = await getCollection('postHistory');
  await ph.deleteMany({ scheduledPostId });
}

const list = indexRoute('scheduledPosts');
const byId = idRoute('scheduledPosts', cascade);

function extractId(req) {
  if (req.query && req.query.id) return req.query.id;
  const path = (req.url || '').split('?')[0];
  const match = path.match(/^\/api\/scheduled-posts\/([^/]+)$/);
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