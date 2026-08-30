// api/_lib/ytPublisher.js
//
// Core YouTube-queue publishing logic. Moved out of api/cron/ (and into
// _lib, which Vercel does NOT treat as routable) so it doesn't count
// against the Hobby plan's 12-Serverless-Function limit — the only public
// entry point that calls this is api/cron/publish-all.js.
//
// Scans mf_ytQueue for jobs whose scheduledUnix <= now, downloads the
// source video from Drive, and uploads it to the CLIENT's own YouTube
// channel (each client has its own OAuth refresh token — see
// api/_lib/youtubeOAuth.js) via YouTube's resumable upload protocol.
//
// Reliability: call this endpoint (via publish-all) on an hourly external
// cron (Vercel Hobby caps its own cron at once/day — see the comment in
// api/cron/drive-bot.js for the same workaround). Each step here also
// retries transient failures in-run via withRetries, and a job only gets
// permanently marked 'failed' after MAX_ATTEMPTS hourly cron passes — not
// after 3 tries within a single run — so a temporary token hiccup or a
// YouTube quota blip has hours, not seconds, to resolve itself before this
// gives up on a video for good.

const { getCollection } = require('./db');
const { getValidAccessToken } = require('./googleOAuth');
const { getValidAccessTokenForClient } = require('./youtubeOAuth');
const { withRetries } = require('./retry');

const YT_UPLOAD = 'https://www.googleapis.com/upload/youtube/v3/videos';
const MAX_ATTEMPTS = 8; // ~8 hourly cron passes before giving up for good

async function downloadFromDrive(driveToken, fileId) {
  const res = await fetch(`https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`, {
    headers: { Authorization: `Bearer ${driveToken}` }
  });
  if (!res.ok) throw new Error(`Drive download failed: HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  const contentType = res.headers.get('content-type') || 'video/mp4';
  return { buf, contentType };
}

async function uploadToYoutube(accessToken, buf, contentType, meta) {
  // Step 1: init a resumable session.
  const initRes = await fetch(`${YT_UPLOAD}?uploadType=resumable&part=snippet,status`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
      'X-Upload-Content-Type': contentType,
      'X-Upload-Content-Length': String(buf.length)
    },
    body: JSON.stringify({
      snippet: { title: meta.title.slice(0,95), description: meta.description.slice(0,4900), tags: meta.tags.slice(0,15) },
      status: { privacyStatus: 'public', selfDeclaredMadeForKids: false }
    })
  });
  if (!initRes.ok) { const t = await initRes.text().catch(()=> ''); throw new Error(`YouTube init failed: HTTP ${initRes.status} ${t.slice(0,300)}`); }
  const sessionUrl = initRes.headers.get('location');
  if (!sessionUrl) throw new Error('No upload session URL returned by YouTube');

  // Step 2: PUT the bytes.
  const putRes = await fetch(sessionUrl, {
    method: 'PUT',
    headers: { 'Content-Type': contentType, 'Content-Length': String(buf.length) },
    body: buf
  });
  const data = await putRes.json().catch(()=>({}));
  if (!putRes.ok || data.error) throw new Error(`YouTube upload failed: ${data.error?.message || putRes.status}`);
  return data.id;
}

async function runPublishYoutubeQueue() {
  const queue = await getCollection('ytQueue');
  const now = Math.floor(Date.now() / 1000);

  const claimed = [];
  for (let i = 0; i < 3; i++) {
    const result = await queue.findOneAndUpdate(
      { status: 'pending', scheduledUnix: { $lte: now } },
      { $set: { status: 'processing', updatedAt: new Date().toISOString() }, $inc: { attempts: 1 } },
      { returnDocument: 'after', sort: { scheduledUnix: 1 } }
    );
    const job = result?.value || result;
    if (!job) break;
    claimed.push(job);
  }

  const results = [];
  for (const job of claimed) {
    try {
      const driveToken = await withRetries(() => getValidAccessToken());
      const { accessToken: ytToken } = await withRetries(() => getValidAccessTokenForClient(job.clientId));
      const { buf, contentType } = await withRetries(() => downloadFromDrive(driveToken, job.driveFileId));
      const videoId = await withRetries(() => uploadToYoutube(ytToken, buf, contentType, { title: job.title, description: job.description, tags: job.tags || [] }), { attempts: 2 }); // don't re-upload a multi-hundred-MB file 3x on a partial failure
      await queue.updateOne({ id: job.id }, { $set: { status: 'done', youtubeVideoId: videoId, lastError: null, updatedAt: new Date().toISOString() } });
      results.push({ id: job.id, ok: true, videoId });
    } catch (e) {
      const stillRetrying = job.attempts < MAX_ATTEMPTS;
      await queue.updateOne({ id: job.id }, { $set: { status: stillRetrying ? 'pending' : 'failed', lastError: e.message, updatedAt: new Date().toISOString() } });
      results.push({ id: job.id, ok: false, error: e.message, willRetry: stillRetrying, attempts: job.attempts });
    }
  }

  return { processed: results.length, results };
}


module.exports = { runPublishYoutubeQueue };
