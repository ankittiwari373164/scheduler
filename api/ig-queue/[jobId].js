// api/ig-queue/[jobId].js
//
// Cancel a pending IG job. We don't allow deleting jobs that are already
// `processing` (might cause double-publish) or `done` (use a separate
// archive endpoint for that if needed).
//

const { getCollection } = require('../_lib/db');
const { jsonResponse, withCors } = require('../_lib/helpers');

function strip(d) { if (!d) return d; const { _id, ...r } = d; return r; }

module.exports = withCors(async (req, res) => {
  const jobId = req.query.jobId;
  if (!jobId) return jsonResponse(res, 400, { error: 'jobId required' });

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
    // Allow updating status / metaPostId / lastError — used by the cron job.
    const { readBody } = require('../_lib/helpers');
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
});
