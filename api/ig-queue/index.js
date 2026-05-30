// api/ig-queue/index.js
// Handles:
//   GET    /api/ig-queue              → list jobs
//   POST   /api/ig-queue              → add a new job
//   GET    /api/ig-queue/:jobId       → fetch one job
//   PATCH  /api/ig-queue/:jobId       → update status / metaPostId
//   DELETE /api/ig-queue/:jobId       → cancel a pending job
const { getCollection } = require('../_lib/db');
const { readBody, jsonResponse, withCors, nextId } = require('../_lib/helpers');

function strip(d) { if (!d) return d; const { _id, ...r } = d; return r; }

function extractJobId(req) {
  if (req.query && req.query.jobId) return req.query.jobId;
  const path = (req.url || '').split('?')[0];
  const match = path.match(/^\/api\/ig-queue\/([^/]+)$/);
  return match ? match[1] : null;
}

async function handleList(req, res) {
  const col = await getCollection('igQueue');
  const filter = {};
  if (req.query.status)   filter.status = req.query.status;
  if (req.query.clientId) filter.clientId = parseInt(req.query.clientId);
  const rows = await col.find(filter).sort({ scheduledUnix: 1 }).toArray();
  return jsonResponse(res, 200, rows.map(strip));
}

async function handleCreate(req, res) {
  const body = await readBody(req);
  if (!body.jobId)         return jsonResponse(res, 400, { error: 'jobId required' });
  if (!body.scheduledUnix) return jsonResponse(res, 400, { error: 'scheduledUnix required' });
  if (!body.mediaUrl)      return jsonResponse(res, 400, { error: 'mediaUrl required' });

  const col = await getCollection('igQueue');
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

async function handleOneJob(req, res, jobId) {
  const col = await getCollection('igQueue');

  if (req.method === 'GET') {
    const doc = await col.findOne({ jobId });
    if (!doc) return jsonResponse(res, 404, { error: 'not found' });
    return jsonResponse(res, 200, strip(doc));
  }

  if (req.method === 'DELETE') {
    const existing = await col.findOne({ jobId });
    if (!existing) return jsonResponse(res, 404, { error: 'not found' });
    if (existing.status === 'processing') {
      return jsonResponse(res, 409, { error: 'cannot delete a job that is currently processing' });
    }
    await col.deleteOne({ jobId });
    return jsonResponse(res, 200, { ok: true, deleted: strip(existing) });
  }

  if (req.method === 'PATCH' || req.method === 'PUT') {
    const body = await readBody(req);
    delete body.jobId;
    delete body._id;
    body.updatedAt = new Date().toISOString();
    const result = await col.findOneAndUpdate(
      { jobId },
      { $set: body },
      { returnDocument: 'after' }
    );
    return jsonResponse(res, 200, strip(result?.value || (await col.findOne({ jobId }))));
  }

  jsonResponse(res, 405, { error: 'method not allowed' });
}

module.exports = withCors(async (req, res) => {
  const jobId = extractJobId(req);

  if (jobId) {
    return handleOneJob(req, res, jobId);
  }

  if (req.method === 'GET')  return handleList(req, res);
  if (req.method === 'POST') return handleCreate(req, res);
  return jsonResponse(res, 405, { error: 'method not allowed' });
});