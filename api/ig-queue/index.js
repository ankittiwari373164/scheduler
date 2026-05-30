// api/ig-queue/index.js
//
// IG queue holds Instagram posts that have been uploaded to a public URL
// but not yet published. The server-side cron (`/api/cron/publish-ig`)
// scans this collection every 5 minutes and publishes anything whose
// scheduledUnix <= now.
//
// Frontend uses:
//   POST  /api/ig-queue          → add a new job (after uploading the media)
//   GET   /api/ig-queue          → list jobs (filter by status)
//   DELETE /api/ig-queue/:jobId  → cancel a pending job
//

const { getCollection } = require('../_lib/db');
const { readBody, jsonResponse, withCors, nextId } = require('../_lib/helpers');

function strip(d) { if (!d) return d; const { _id, ...r } = d; return r; }

module.exports = withCors(async (req, res) => {
  const col = await getCollection('igQueue');

  if (req.method === 'GET') {
    const filter = {};
    if (req.query.status) filter.status = req.query.status;
    if (req.query.clientId) filter.clientId = parseInt(req.query.clientId);
    // Default sort: soonest-due first
    const rows = await col.find(filter).sort({ scheduledUnix: 1 }).toArray();
    return jsonResponse(res, 200, rows.map(strip));
  }

  if (req.method === 'POST') {
    const body = await readBody(req);
    if (!body.jobId)        return jsonResponse(res, 400, { error: 'jobId required' });
    if (!body.scheduledUnix) return jsonResponse(res, 400, { error: 'scheduledUnix required' });
    if (!body.mediaUrl)      return jsonResponse(res, 400, { error: 'mediaUrl required' });

    const now = new Date().toISOString();
    const doc = {
      ...body,
      id: await nextId(getCollection, 'igQueue'),
      status: body.status || 'pending',
      attempts: 0,
      lastError: null,
      metaPostId: null,
      createdAt: now,
      updatedAt: now
    };
    delete doc._id;
    await col.insertOne(doc);
    return jsonResponse(res, 201, strip(doc));
  }

  jsonResponse(res, 405, { error: 'method not allowed' });
});
