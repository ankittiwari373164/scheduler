// api/brand-details/[clientId].js
//
// Brand details have a 1:1 relationship with clients, so we expose them as:
//   GET    /api/brand-details/:clientId  → returns the brand doc or null
//   PUT    /api/brand-details/:clientId  → upserts (no separate POST needed)
//   DELETE /api/brand-details/:clientId
//

const { getCollection } = require('../_lib/db');
const { readBody, jsonResponse, withCors, nextId } = require('../_lib/helpers');

function strip(d) { if (!d) return d; const { _id, ...r } = d; return r; }

module.exports = withCors(async (req, res) => {
  const clientId = parseInt(req.query.clientId);
  if (!clientId) return jsonResponse(res, 400, { error: 'clientId required' });

  const col = await getCollection('brandDetails');

  if (req.method === 'GET') {
    const doc = await col.findOne({ clientId });
    return jsonResponse(res, 200, strip(doc));
  }

  if (req.method === 'PUT' || req.method === 'PATCH') {
    const body = await readBody(req);
    const now = new Date().toISOString();
    const existing = await col.findOne({ clientId });
    if (existing) {
      const result = await col.findOneAndUpdate(
        { clientId },
        { $set: { ...body, clientId, updatedAt: now } },
        { returnDocument: 'after' }
      );
      return jsonResponse(res, 200, strip(result?.value || (await col.findOne({ clientId }))));
    }
    const doc = {
      ...body,
      id: await nextId(getCollection, 'brandDetails'),
      clientId,
      createdAt: now,
      updatedAt: now
    };
    delete doc._id;
    await col.insertOne(doc);
    return jsonResponse(res, 201, strip(doc));
  }

  if (req.method === 'DELETE') {
    const deleted = await col.findOneAndDelete({ clientId });
    return jsonResponse(res, 200, { ok: true, deleted: strip(deleted?.value || deleted) });
  }

  jsonResponse(res, 405, { error: 'method not allowed' });
});
