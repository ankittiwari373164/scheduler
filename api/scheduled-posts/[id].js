// api/scheduled-posts/[id].js
const { idRoute } = require('../_lib/crud');
const { getCollection } = require('../_lib/db');

async function cascade(scheduledPostId) {
  const ph = await getCollection('postHistory');
  await ph.deleteMany({ scheduledPostId });
}

module.exports = idRoute('scheduledPosts', cascade);
