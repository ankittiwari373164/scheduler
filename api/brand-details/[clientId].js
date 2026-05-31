// api/brand-details/[clientId].js
//
// Brand details have a 1:1 relationship with clients, so we expose them as:
//   GET    /api/brand-details/:clientId  → returns the brand doc or null
//   PUT    /api/brand-details/:clientId  → upserts (no separate POST needed)
//   DELETE /api/brand-details/:clientId
//

const { getCollection } = require('../_lib/db');
const { readBody, jsonResponse, withCors, nextId } = require('../_lib/helpers');
const { strip } = require('../_lib/crud');

// Build a filter that matches clientId stored as EITHER integer or string.
function clientIdFilter(clientId) {
  const n = parseInt(clientId, 10);
  const s = String(clientId);
  if (Number.isNaN(n)) return { clientId: s };
  return { $or: [{ clientId: n }, { clientId: s }] };
}

module.exports = withCors(async (req, res) => {
  const clientId = req.query.clientId;
  if (!clientId) return jsonResponse(res, 400, { error: 'clientId required' });

  const numClientId = parseInt(clientId, 10);
  const col = await getCollection('brandDetails');
  const filter = clientIdFilter(clientId);

  if (req.method === 'GET') {
    const doc = await col.findOne(filter);
    return jsonResponse(res, 200, strip(doc));
  }

  if (req.method === 'PUT' || req.method === 'PATCH') {
    const body = await readBody(req);
    const now = new Date().toISOString();
    const existing = await col.findOne(filter);
    if (existing) {
      const result = await col.findOneAndUpdate(
        filter,
        { $set: { ...body, clientId: numClientId, updatedAt: now } },
        { returnDocument: 'after' }
      );
      return jsonResponse(res, 200, strip(result?.value || (await col.findOne(filter))));
    }
    const doc = {
      ...body,
      id: await nextId(getCollection, 'brandDetails'),
      clientId: numClientId,
      createdAt: now,
      updatedAt: now
    };
    delete doc._id;
    await col.insertOne(doc);
    return jsonResponse(res, 201, strip(doc));
  }

  if (req.method === 'DELETE') {
    const deleted = await col.findOneAndDelete(filter);
    return jsonResponse(res, 200, { ok: true, deleted: strip(deleted?.value || deleted) });
  }

  jsonResponse(res, 405, { error: 'method not allowed' });
});