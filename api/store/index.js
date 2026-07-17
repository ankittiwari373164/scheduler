// api/store/index.js
// ONE serverless function handling BOTH the ig-queue and config resources
// (kept as a single file deliberately — Hobby plan has a tight Serverless
// Function count limit; same trick used elsewhere in this codebase).
//
// Public URLs are unchanged via vercel.json rewrites:
//   /api/ig-queue           -> /api/store?resource=ig-queue
//   /api/ig-queue/:jobId    -> /api/store?resource=ig-queue&jobId=:jobId
//   /api/config             -> /api/store?resource=config

const { getCollection } = require('../_lib/db');
const { readBody, jsonResponse, withCors, nextId } = require('../_lib/helpers');

function strip(d) { if (!d) return d; const { _id, ...r } = d; return r; }

/* ---------------- ig-queue ---------------- */

async function igList(req, res) {
  const col = await getCollection('igQueue');
  const filter = {};
  if (req.query.status)   filter.status = req.query.status;
  if (req.query.clientId) filter.clientId = parseInt(req.query.clientId);
  const rows = await col.find(filter).sort({ scheduledUnix: 1 }).toArray();
  return jsonResponse(res, 200, rows.map(strip));
}

async function igCreate(req, res) {
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

async function igOneJob(req, res, jobId) {
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

async function handleIgQueue(req, res) {
  const jobId = req.query && req.query.jobId;
  if (jobId) return igOneJob(req, res, jobId);
  if (req.method === 'GET')  return igList(req, res);
  if (req.method === 'POST') return igCreate(req, res);
  return jsonResponse(res, 405, { error: 'method not allowed' });
}

/* ---------------- config ---------------- */

const CONFIG_ID = 'app_config';
const DEFAULT_CFG = {
  aiServerUrl: '',
  aiServerToken: '',
  googleClientId: '',
  metaAccessToken: '',
  metaConnected: false,
  metaPages: []
};

async function handleConfig(req, res) {
  const col = await getCollection('config');

  if (req.method === 'GET') {
    const doc = await col.findOne({ _id: CONFIG_ID });
    return jsonResponse(res, 200, strip(doc) || DEFAULT_CFG);
  }

  if (req.method === 'PUT' || req.method === 'POST' || req.method === 'PATCH') {
    const body = await readBody(req);
    delete body._id;
    body.updatedAt = new Date().toISOString();
    await col.updateOne(
      { _id: CONFIG_ID },
      { $set: body, $setOnInsert: { createdAt: new Date().toISOString() } },
      { upsert: true }
    );
    const fresh = await col.findOne({ _id: CONFIG_ID });
    return jsonResponse(res, 200, strip(fresh));
  }

  jsonResponse(res, 405, { error: 'method not allowed' });
}

/* ---------------- dispatch ---------------- */

module.exports = withCors(async (req, res) => {
  const resource = req.query && req.query.resource;
  if (resource === 'ig-queue') return handleIgQueue(req, res);
  if (resource === 'config')   return handleConfig(req, res);
  return jsonResponse(res, 400, { error: 'unknown or missing resource' });
});
