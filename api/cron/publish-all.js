// api/cron/publish-all.js
//
// Runs frequently (every 30 min, see vercel.json) and processes BOTH the
// Instagram queue and the YouTube queue in one request. Exists purely to
// keep the project at 2 total Vercel cron jobs instead of 3 — Vercel's
// Hobby plan caps you at 2. If you're on Pro and want them split apart
// again for clarity/isolation, just point vercel.json's two schedules back
// at /api/cron/publish-ig and /api/cron/publish-youtube directly — both
// still work standalone, this file just calls into the same functions.

const { withCors, jsonResponse, requireAdminToken } = require('../_lib/helpers');
const { runPublishIgQueue } = require('./publish-ig');
const { runPublishYoutubeQueue } = require('./publish-youtube');

module.exports = withCors(async (req, res) => {
  const isVercelCron = !!req.headers['x-vercel-cron'];
  if (!isVercelCron && process.env.ADMIN_TOKEN) {
    try { requireAdminToken(req); } catch (e) { return jsonResponse(res, 401, { error: e.message }); }
  }

  const [ig, yt] = await Promise.all([
    runPublishIgQueue().catch(e => ({ ok: false, error: e.message })),
    runPublishYoutubeQueue().catch(e => ({ ok: false, error: e.message }))
  ]);

  jsonResponse(res, 200, { instagram: ig, youtube: yt });
});
