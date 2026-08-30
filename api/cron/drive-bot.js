// api/cron/drive-bot.js
//
// Vercel's own cron (see vercel.json) fires this once a day as a baseline.
// For real "check every hour" behavior — needed because Vercel Hobby caps
// each cron schedule at once/day — hit this same endpoint from an external
// scheduler (e.g. cron-job.org) every hour too, same as publish-all:
//   https://YOUR-APP.vercel.app/api/cron/drive-bot?token=YOUR_ADMIN_TOKEN
//
// This is SAFE to call as often as you like — it's fully idempotent. Every
// run only processes files that don't already have a scheduledPosts record
// (see `newFiles` filtering inside runForClient), so calling it hourly just
// means a file that failed (e.g. a transient ChatGPT-server or Drive-API
// error) gets retried within the hour instead of waiting a full day, and
// re-running when nothing's new is just a cheap no-op per client.
//
// For every client with a Drive link configured, scans their Drive folder,
// pairs videos with thumbnails, generates captions, and queues IG jobs
// (+ YouTube jobs for clients with a connected auto-YouTube channel) — no
// browser tab needed.
//
// This REPLACES manually clicking "Run Now" for automatic operation. The
// manual button in the UI still works too (e.g. to force an immediate run).

const { getCollection } = require('../_lib/db');
const { getValidAccessToken } = require('../_lib/googleOAuth');
const { runForClient, purgeDueDriveFiles } = require('../_lib/driveBot');
const { withCors, jsonResponse, requireAdminToken } = require('../_lib/helpers');

module.exports = withCors(async (req, res) => {
  const isVercelCron = !!req.headers['x-vercel-cron'];
  if (!isVercelCron && process.env.ADMIN_TOKEN) {
    try { requireAdminToken(req); } catch (e) { return jsonResponse(res, 401, { error: e.message }); }
  }

  const runsCol = await getCollection('botRuns');
  const startedAt = new Date().toISOString();

  let driveToken;
  try {
    driveToken = await getValidAccessToken();
  } catch (e) {
    const doc = { startedAt, finishedAt: new Date().toISOString(), ok: false, error: e.message, clients: [] };
    await runsCol.insertOne(doc);
    return jsonResponse(res, 200, doc);
  }

  const clientsCol        = await getCollection('clients');
  const brandDetailsCol   = await getCollection('brandDetails');
  const metaAccountsCol   = await getCollection('metaAccounts');
  const scheduledPostsCol = await getCollection('scheduledPosts');
  const igQueueCol        = await getCollection('igQueue');
  const ytQueueCol        = await getCollection('ytQueue');
  const configCol         = await getCollection('config');

  const appCfgDoc = await configCol.findOne({ _key: 'app' });
  const cfg = appCfgDoc || {};

  const ctx = { cfg, driveToken, clientsCol, brandDetailsCol, metaAccountsCol, scheduledPostsCol, igQueueCol, ytQueueCol, configCol };

  const clients = await clientsCol.find({ driveLink: { $exists: true, $ne: '' } }).toArray();

  const results = [];
  let totalScheduled = 0;
  for (const client of clients) {
    try {
      const { scheduled, log } = await runForClient(client, ctx);
      totalScheduled += scheduled;
      results.push({ clientId: client.id, clientName: client.name, scheduled, log });
    } catch (e) {
      results.push({ clientId: client.id, clientName: client.name, scheduled: 0, error: e.message });
    }
  }

  let purged = 0;
  try { purged = await purgeDueDriveFiles(ctx); } catch (e) { /* non-fatal */ }

  const doc = { startedAt, finishedAt: new Date().toISOString(), ok: true, totalScheduled, purged, clients: results };
  await runsCol.insertOne(doc);
  // Keep the log collection small.
  const count = await runsCol.countDocuments();
  if (count > 50) {
    const oldest = await runsCol.find().sort({ startedAt: 1 }).limit(count - 50).toArray();
    await runsCol.deleteMany({ _id: { $in: oldest.map(o => o._id) } });
  }

  jsonResponse(res, 200, doc);
});
