// api/repair-ids.js
// One-shot repair endpoint — fixes clients and brandDetails that have duplicate/wrong id values.
// Reassigns unique integer ids based on insertion order (_id ObjectId order).
// Also re-links brandDetails.clientId to match the correct client by name matching.
//
// POST /api/repair-ids   — runs the repair
// GET  /api/repair-ids   — dry-run (shows what would be changed, doesn't write)

const { getCollection } = require('./_lib/db');
const { jsonResponse, withCors } = require('./_lib/helpers');

module.exports = withCors(async (req, res) => {
  const dryRun = req.method === 'GET';
  if (req.method !== 'GET' && req.method !== 'POST') {
    return jsonResponse(res, 405, { error: 'GET (dry-run) or POST (repair)' });
  }

  const clientCol = await getCollection('clients');
  const brandCol  = await getCollection('brandDetails');
  const configCol = await getCollection('config');

  // 1. Load all clients sorted by _id (insertion order)
  const clients = await clientCol.find({}).sort({ _id: 1 }).toArray();
  const brands  = await brandCol.find({}).sort({ _id: 1 }).toArray();

  // 2. Check for duplicate ids
  const clientIds = clients.map(c => c.id);
  const uniqueClientIds = new Set(clientIds);
  const hasDuplicates = uniqueClientIds.size < clients.length;
  const allUndefined = clients.every(c => c.id === undefined || c.id === null);

  const report = {
    totalClients: clients.length,
    totalBrands: brands.length,
    uniqueClientIds: uniqueClientIds.size,
    hasDuplicates,
    allUndefined,
    clientsBefore: clients.map(c => ({ _id: c._id.toString(), id: c.id, name: c.name })),
    brandsBefore: brands.map(b => ({ _id: b._id.toString(), id: b.id, clientId: b.clientId, preview: (b.content||'').slice(0,40) })),
    changes: [],
    dryRun,
  };

  if (!hasDuplicates && !allUndefined) {
    report.message = 'No duplicate IDs found — data looks healthy.';
    return jsonResponse(res, 200, report);
  }

  // 3. Assign new sequential ids to clients (1, 2, 3, ...)
  let nextId = 1;
  const clientIdMap = new Map(); // old _id.toString() → new id

  for (const client of clients) {
    const newId = nextId++;
    clientIdMap.set(client._id.toString(), newId);
    report.changes.push({ type: 'client', _id: client._id.toString(), name: client.name, oldId: client.id, newId });
    if (!dryRun) {
      await clientCol.updateOne({ _id: client._id }, { $set: { id: newId } });
    }
  }

  // 4. Fix brandDetails — reassign their id and fix clientId
  //    Strategy: brand docs are already fetched. We need to match each brand to its client.
  //    Since clientId may be wrong/duplicate, try to match by clientId value first (if unique),
  //    otherwise assign sequentially (brand[i] → client[i]).
  
  // Build a map: oldClientId → which clients had that id (before repair)
  const oldIdToClients = new Map();
  for (const client of clients) {
    const key = String(client.id);
    if (!oldIdToClients.has(key)) oldIdToClients.set(key, []);
    oldIdToClients.get(key).push(client);
  }

  // Try to match brands to clients
  // If all clients had the same old id (e.g. all were id:1), we can't match by clientId.
  // In that case, match by insertion order (brand[i] → client[i]) which is how they were created.
  const allSameClientId = brands.length > 0 && new Set(brands.map(b => String(b.clientId))).size === 1;

  for (let i = 0; i < brands.length; i++) {
    const brand = brands[i];
    let matchedClient = null;

    if (!allSameClientId) {
      // Try to match by clientId value
      const clientsWithId = oldIdToClients.get(String(brand.clientId)) || [];
      if (clientsWithId.length === 1) matchedClient = clientsWithId[0];
    }

    // Fallback: match by position (brand[i] → client[i])
    if (!matchedClient && i < clients.length) {
      matchedClient = clients[i];
    }

    const newClientId = matchedClient ? clientIdMap.get(matchedClient._id.toString()) : (i + 1);
    const newBrandId  = i + 1;

    report.changes.push({
      type: 'brand',
      _id: brand._id.toString(),
      preview: (brand.content||'').slice(0,40),
      oldId: brand.id,
      newId: newBrandId,
      oldClientId: brand.clientId,
      newClientId,
      matchedClientName: matchedClient?.name,
    });

    if (!dryRun) {
      await brandCol.updateOne({ _id: brand._id }, { $set: { id: newBrandId, clientId: newClientId } });
    }
  }

  // 5. Update counters so future inserts don't collide
  const maxId = Math.max(clients.length, brands.length, 10);
  if (!dryRun) {
    for (const kind of ['clients', 'brandDetails', 'portfolios', 'metaAccounts', 'scheduledPosts', 'postHistory', 'igQueue']) {
      await configCol.updateOne(
        { _id: `counter_${kind}` },
        { $set: { value: maxId + 10 } },
        { upsert: true }
      );
    }
  }

  report.message = dryRun
    ? `DRY RUN — would reassign IDs for ${clients.length} clients and ${brands.length} brand docs. POST to /api/repair-ids to apply.`
    : `REPAIRED — reassigned IDs for ${clients.length} clients and ${brands.length} brand docs. Counters reset to ${maxId + 10}.`;

  jsonResponse(res, 200, report);
});