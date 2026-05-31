// api/cron/publish-ig.js
//
// Runs every 5 minutes (configured in vercel.json under crons).
// Scans the mf_igQueue collection for jobs whose scheduledUnix <= now
// and publishes them via the Meta Graph API.
//
// Flow per job:
//   1. Mark job as 'processing' (atomic so no other cron run picks it up)
//   2. Create IG media container (image_url for image, video_url for reel)
//   3. For reels: poll status until FINISHED (up to ~2 min)
//   4. Call media_publish with the container ID
//   5. Update job to 'done' (with metaPostId) or 'failed' (with lastError)
//   6. Add a postHistory row for accounting
//
// This is the EXACT same logic that ran in the browser (publishIgJob)
// — just moved to the server so it works without a browser tab open.
//

const { getCollection } = require('../_lib/db');
const { jsonResponse, withCors, requireAdminToken } = require('../_lib/helpers');

const GRAPH = 'https://graph.facebook.com/v19.0';

function strip(d) { if (!d) return d; const { _id, ...r } = d; return r; }

// Poll the container until it's ready (image: ~2s, reel: up to 2min)
async function pollContainer(containerId, accessToken, maxWaitMs = 120000) {
  const start = Date.now();
  while (Date.now() - start < maxWaitMs) {
    await new Promise(r => setTimeout(r, 3000));
    const res = await fetch(`${GRAPH}/${containerId}?fields=status_code,status&access_token=${accessToken}`);
    const data = await res.json();
    if (data.status_code === 'FINISHED') return true;
    if (data.status_code === 'ERROR' || data.status_code === 'EXPIRED') {
      throw new Error(`IG container failed: ${data.status || data.status_code}`);
    }
  }
  throw new Error('IG container processing timed out');
}

// Look up the current Page access token from mf_config.metaPages,
// falling back to the token stored on the job (legacy behaviour).
async function getFreshToken(job) {
  try {
    const cfg = await getCollection('config');
    const app = await cfg.findOne({ _key: 'app' });
    if (app?.metaPages?.length) {
      // Match by igId first, then by pageId
      const page = app.metaPages.find(p =>
        (p.igId && p.igId === job.igId) ||
        (p.pageId && p.pageId === job.pageId)
      );
      if (page?.pageToken) return page.pageToken;
    }
  } catch (e) {
    console.warn('Token lookup failed, using job.fbToken:', e.message);
  }
  return job.fbToken;
}

async function publishOne(job) {
  // Always use the freshest token from mf_config (handles token upgrades
  // that happened after the job was originally queued).
  const token = await getFreshToken(job);

  // 1. Create container
  let containerId;
  if (job.mediaType === 'video') {
    const params = new URLSearchParams({
      access_token: token,
      caption: job.caption,
      media_type: 'REELS',
      video_url: job.mediaUrl,
      share_to_feed: 'true'
    });
    const r = await fetch(`${GRAPH}/${job.igId}/media`, { method: 'POST', body: params });
    const d = await r.json();
    if (d.error) throw new Error(`[${d.error.code}] ${d.error.message}`);
    await pollContainer(d.id, token, 120000);
    containerId = d.id;
  } else {
    const params = new URLSearchParams({
      access_token: token,
      caption: job.caption,
      image_url: job.mediaUrl
    });
    const r = await fetch(`${GRAPH}/${job.igId}/media`, { method: 'POST', body: params });
    const d = await r.json();
    if (d.error) throw new Error(`[${d.error.code}] ${d.error.message}`);
    await new Promise(r => setTimeout(r, 2500));
    containerId = d.id;
  }

  // 2. Publish
  const pubRes = await fetch(`${GRAPH}/${job.igId}/media_publish`, {
    method: 'POST',
    body: new URLSearchParams({
      creation_id: containerId,
      access_token: token
    })
  });
  const pubData = await pubRes.json();
  if (pubData.error) throw new Error(`[${pubData.error.code}] ${pubData.error.message}`);
  return pubData.id || containerId;
}

module.exports = withCors(async (req, res) => {
  // If ADMIN_TOKEN is configured, require it for manual invocations.
  // Vercel Cron sends the request internally without our header, but with
  // a special `x-vercel-cron` header — so we allow that pathway too.
  const isVercelCron = !!req.headers['x-vercel-cron'];
  if (!isVercelCron && process.env.ADMIN_TOKEN) {
    try { requireAdminToken(req); }
    catch (e) { return jsonResponse(res, 401, { error: e.message }); }
  }

  const queue = await getCollection('igQueue');
  const history = await getCollection('postHistory');
  const now = Math.floor(Date.now() / 1000);

  // Atomically grab a small batch of due jobs and mark them 'processing'.
  // We loop one-by-one so failed jobs don't stall the rest.
  const claimed = [];
  for (let i = 0; i < 5; i++) {
    const result = await queue.findOneAndUpdate(
      {
        status: 'pending',
        scheduledUnix: { $lte: now }
      },
      {
        $set: { status: 'processing', updatedAt: new Date().toISOString() },
        $inc: { attempts: 1 }
      },
      { returnDocument: 'after', sort: { scheduledUnix: 1 } }
    );
    const job = result?.value || result;
    if (!job) break;
    claimed.push(strip(job));
  }

  if (!claimed.length) {
    return jsonResponse(res, 200, { ok: true, processed: 0, message: 'no due jobs' });
  }

  const results = [];
  for (const job of claimed) {
    try {
      const metaPostId = await publishOne(job);

      await queue.updateOne(
        { jobId: job.jobId },
        {
          $set: {
            status: 'done',
            metaPostId,
            lastError: null,
            updatedAt: new Date().toISOString(),
            completedAt: new Date().toISOString()
          }
        }
      );

      // Add a postHistory entry mirroring the browser-side behavior.
      await history.insertOne({
        scheduledPostId: job.scheduledPostId || null,
        clientId: job.clientId || null,
        metaAccountId: null,
        metaPostId,
        platform: 'instagram',
        publishedAt: new Date().toISOString(),
        engagementMetrics: {},
        createdAt: new Date().toISOString()
      });

      results.push({ jobId: job.jobId, status: 'done', metaPostId });
    } catch (e) {
      console.error(`IG publish failed for ${job.jobId}:`, e.message);
      // Mark failed if too many attempts, otherwise leave for retry
      const maxRetries = 3;
      const nextStatus = (job.attempts || 0) >= maxRetries ? 'failed' : 'pending';
      await queue.updateOne(
        { jobId: job.jobId },
        {
          $set: {
            status: nextStatus,
            lastError: e.message,
            updatedAt: new Date().toISOString()
          }
        }
      );
      results.push({ jobId: job.jobId, status: nextStatus, error: e.message });
    }
  }

  jsonResponse(res, 200, { ok: true, processed: results.length, results });
});