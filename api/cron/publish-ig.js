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

// Meta's error 2207082 ("Media upload has failed") almost always means IG's
// fetcher couldn't successfully download/process the file at mediaUrl —
// unreachable URL, redirect chain, wrong/missing Content-Type, or the file
// exceeds IG's limits. Check this BEFORE creating a container so we fail
// fast with a clear reason instead of burning a ~2min poll + a retry on a
// media problem that will never fix itself.
const IMAGE_MAX_BYTES = 8   * 1024 * 1024;   // Meta: images up to ~8MB
const VIDEO_MAX_BYTES = 1024 * 1024 * 1024;  // Meta: video up to ~1GB (reels recommended << 100MB)

// A very common producer of the "text/html, not video/*" failure: a Google
// Drive SHARE/VIEW link (e.g. .../file/d/<ID>/view or ?id=<ID>) got stored
// as mediaUrl instead of a direct-content link. Drive's viewer page returns
// HTML, not the file. Rewrite it to Drive's direct-download endpoint, which
// serves the raw bytes for files under Drive's virus-scan threshold.
function driveDirectUrl(url) {
  let u;
  try { u = new URL(url); } catch { return null; }
  if (!/(^|\.)drive\.google\.com$/.test(u.hostname) && !/(^|\.)docs\.google\.com$/.test(u.hostname)) return null;

  let id = u.searchParams.get('id');
  if (!id) {
    const m = u.pathname.match(/\/file\/d\/([^/]+)/);
    if (m) id = m[1];
  }
  if (!id) return null;
  return `https://drive.google.com/uc?export=download&id=${id}`;
}

// Returns the mediaUrl to actually publish with (possibly rewritten).
// Throws with a clear, actionable message if the media truly isn't usable.
async function preflightMedia(job) {
  let url = job.mediaUrl;

  const check = async (u) => {
    let head;
    try {
      head = await fetch(u, { method: 'HEAD', redirect: 'follow' });
    } catch (e) {
      return { ok: false, reason: `unreachable (${e.message})` };
    }
    if (!head.ok) return { ok: false, reason: `HTTP ${head.status}` };
    return {
      ok: true,
      contentType: (head.headers.get('content-type') || '').toLowerCase(),
      length: parseInt(head.headers.get('content-length') || '0', 10)
    };
  };

  let result = await check(url);
  const wantPrefix = job.mediaType === 'video' ? 'video/' : 'image/';

  // Self-heal: if it looks like an HTML page from a Drive link, try Drive's
  // direct-download URL instead before giving up.
  if ((!result.ok || (result.contentType && !result.contentType.startsWith(wantPrefix))) ) {
    const direct = driveDirectUrl(url);
    if (direct && direct !== url) {
      const retry = await check(direct);
      if (retry.ok && (!retry.contentType || retry.contentType.startsWith(wantPrefix))) {
        url = direct;
        result = retry;
      }
    }
  }

  if (!result.ok) {
    throw new Error(`Media URL ${result.reason} — the file is gone or not public. Re-upload/re-host and re-queue.`);
  }
  if (result.contentType && !result.contentType.startsWith(wantPrefix)) {
    const driveHint = driveDirectUrl(job.mediaUrl)
      ? ' This is a Google Drive link — Drive\'s virus-scan interstitial can still return HTML for larger/flagged files even via the direct-download URL. For reliable video hosting, upload to Cloudinary/S3 instead of Drive.'
      : '';
    throw new Error(`Media URL Content-Type is "${result.contentType}", not ${wantPrefix}*. IG needs a direct file URL, not a viewer/share page.${driveHint}`);
  }
  const maxBytes = job.mediaType === 'video' ? VIDEO_MAX_BYTES : IMAGE_MAX_BYTES;
  if (result.length && result.length > maxBytes) {
    throw new Error(`File is ${(result.length / 1024 / 1024).toFixed(1)}MB, over Meta's limit for ${job.mediaType}. Compress before queuing.`);
  }

  return url; // possibly rewritten from the original job.mediaUrl
}

// Best-effort check of a custom Reel cover/thumbnail URL. Unlike
// preflightMedia() this NEVER throws — a bad thumbnail should not sink an
// otherwise-good video post. Returns a usable image URL (possibly rewritten
// from a Drive share link) or null if the thumbnail isn't usable, in which
// case the caller falls back to IG's automatic frame selection.
async function preflightThumbnail(url) {
  if (!url) return null;
  const check = async (u) => {
    try {
      const head = await fetch(u, { method: 'HEAD', redirect: 'follow' });
      if (!head.ok) return null;
      const ct = (head.headers.get('content-type') || '').toLowerCase();
      if (ct && !ct.startsWith('image/')) return null;
      return u;
    } catch { return null; }
  };
  let ok = await check(url);
  if (!ok) {
    const direct = driveDirectUrl(url);
    if (direct && direct !== url) ok = await check(direct);
  }
  return ok;
}

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
  // Fail fast on obviously-broken media instead of burning a 2min poll +
  // retry. May return a REWRITTEN url (e.g. a Drive share link normalized
  // to Drive's direct-download endpoint) — persist that back onto the job
  // so the fix sticks and future retries/logs use the working URL.
  const fixedUrl = await preflightMedia(job);
  if (fixedUrl !== job.mediaUrl) {
    const queue = await getCollection('igQueue');
    await queue.updateOne({ jobId: job.jobId }, { $set: { mediaUrl: fixedUrl, updatedAt: new Date().toISOString() } });
    job = { ...job, mediaUrl: fixedUrl };
  }

  // Always use the freshest token from mf_config (handles token upgrades
  // that happened after the job was originally queued).
  const token = await getFreshToken(job);

  const isStory = job.publishAs === 'story';

  // 1. Create container
  let containerId;
  if (job.mediaType === 'video') {
    const params = new URLSearchParams({
      access_token: token,
      video_url: job.mediaUrl,
      // Stories use media_type=STORIES; normal videos are REELS.
      media_type: isStory ? 'STORIES' : 'REELS'
    });
    // Captions and share_to_feed only apply to feed Reels, not Stories.
    if (!isStory) {
      params.set('caption', job.caption || '');
      params.set('share_to_feed', 'true');
    }
    // Custom thumbnail/cover image, if one was attached when the job was
    // queued (Drive-paired thumbnail or a manual upload). cover_url is only
    // honored by Meta for REELS, not STORIES — Meta takes cover_url over
    // thumb_offset whenever both are present.
    if (!isStory && job.thumbnailUrl) {
      const coverUrl = await preflightThumbnail(job.thumbnailUrl);
      if (coverUrl) params.set('cover_url', coverUrl);
      else console.warn(`Thumbnail unusable for ${job.jobId}, falling back to auto frame:`, job.thumbnailUrl);
    }
    const r = await fetch(`${GRAPH}/${job.igId}/media`, { method: 'POST', body: params });
    const d = await r.json();
    if (d.error) throw new Error(`[${d.error.code}] ${d.error.message}`);
    await pollContainer(d.id, token, 120000);
    containerId = d.id;
  } else {
    const params = new URLSearchParams({
      access_token: token,
      image_url: job.mediaUrl
    });
    // Image Stories set media_type=STORIES and carry no caption.
    if (isStory) params.set('media_type', 'STORIES');
    else params.set('caption', job.caption || '');
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
      // Mark failed if too many attempts, otherwise leave for retry with
      // exponential backoff (5min, 20min, 60min) so a broken-media job
      // doesn't just hammer the same failure every 5 minutes.
      const maxRetries = 3;
      const attempts = job.attempts || 0;
      const nextStatus = attempts >= maxRetries ? 'failed' : 'pending';
      const backoffMin = [5, 20, 60][Math.min(attempts, 2)];
      const patch = {
        status: nextStatus,
        lastError: e.message,
        updatedAt: new Date().toISOString()
      };
      if (nextStatus === 'pending') {
        patch.scheduledUnix = now + backoffMin * 60;
      }
      await queue.updateOne(
        { jobId: job.jobId },
        { $set: patch }
      );
      results.push({ jobId: job.jobId, status: nextStatus, error: e.message });
    }
  }

  jsonResponse(res, 200, { ok: true, processed: results.length, results });
});
