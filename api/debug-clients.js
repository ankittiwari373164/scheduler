// api/debug-clients.js
// Temporary debug endpoint — shows raw MongoDB client documents with their id fields.
// Visit /api/debug-clients in the browser to inspect.
// DELETE THIS FILE after the bug is confirmed and fixed.

const { getCollection } = require('./_lib/db');
const { jsonResponse, withCors } = require('./_lib/helpers');

module.exports = withCors(async (req, res) => {
  if (req.method !== 'GET') return jsonResponse(res, 405, { error: 'GET only' });

  const col = await getCollection('clients');
  // Fetch all clients — show _id, id, name so we can see exactly what's in MongoDB
  const docs = await col.find({}).toArray();
  const summary = docs.map(d => ({
    _id: d._id?.toString(),
    id: d.id,
    id_type: typeof d.id,
    name: d.name,
    portfolioId: d.portfolioId,
    portfolioId_type: typeof d.portfolioId,
  }));

  const brandCol = await getCollection('brandDetails');
  const brands = await brandCol.find({}).toArray();
  const brandSummary = brands.map(b => ({
    _id: b._id?.toString(),
    id: b.id,
    clientId: b.clientId,
    clientId_type: typeof b.clientId,
    contentPreview: (b.content || '').slice(0, 60),
  }));

  jsonResponse(res, 200, { clients: summary, brandDetails: brandSummary });
});