// api/cron/publish-all.js
//
// Runs once a day (see vercel.json — Vercel Hobby caps you at 2 total cron
// jobs, each at most once/day). Processes BOTH the Instagram queue and the
// YouTube queue in one request. For closer-to-on-time publishing than
// once/day, hit this endpoint from a free external scheduler too (e.g.
// cron-job.org every 15-30 min) — it's a normal HTTP endpoint, only
// Vercel's own cron trigger is rate-limited on Hobby.
//
// The actual publishing logic lives in api/_lib/igPublisher.js and
// api/_lib/ytPublisher.js (NOT api/cron/) specifically so those don't each
// count as their own Serverless Function against Hobby's 12-function cap —
// this file is the only public route for both.

const { withCors, jsonResponse, requireAdminToken } = require('../_lib/helpers');
const { runPublishIgQueue } = require('../_lib/igPublisher');
const { runPublishYoutubeQueue } = require('../_lib/ytPublisher');

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
