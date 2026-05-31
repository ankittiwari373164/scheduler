// api/migrate.js
//
// Multi-purpose maintenance endpoint:
//
//   POST /api/migrate              — migrate localStorage dump to MongoDB
//   GET  /api/migrate?action=debug — show raw client+brand IDs in MongoDB
//   POST /api/migrate?action=repair-dry — dry-run ID repair (no writes)
//   POST /api/migrate?action=repair     — fix duplicate IDs in MongoDB

const { getCollection } = require('./_lib/db');
const { readBody, jsonResponse, withCors } = require('./_lib/helpers');

// ─── Debug: show raw MongoDB ids ─────────────────────────────────────────────
async function handleDebug(req, res) {
  const clientCol = await getCollection('clients');
  const brandCol  = await getCollection('brandDetails');

  const clients = await clientCol.find({}).sort({ _id: 1 }).toArray();
  const brands  = await brandCol.find({}).sort({ _id: 1 }).toArray();

  const clientSummary = clients.map(d => ({
    _id: d._id?.toString(),
    id: d.id,
    id_type: typeof d.id,
    name: d.name,
    portfolioId: d.portfolioId,
    portfolioId_type: typeof d.portfolioId,
  }));
  const brandSummary = brands.map(b => ({
    _id: b._id?.toString(),
    id: b.id,
    clientId: b.clientId,
    clientId_type: typeof b.clientId,
    contentPreview: (b.content || '').slice(0, 80),
  }));

  return jsonResponse(res, 200, { clients: clientSummary, brandDetails: brandSummary });
}

// ─── Repair: fix duplicate/missing ids ───────────────────────────────────────
async function handleRepair(req, res, dryRun) {
  const clientCol = await getCollection('clients');
  const brandCol  = await getCollection('brandDetails');
  const configCol = await getCollection('config');

  const clients = await clientCol.find({}).sort({ _id: 1 }).toArray();
  const brands  = await brandCol.find({}).sort({ _id: 1 }).toArray();

  const clientIds     = clients.map(c => c.id);
  const uniqueIds     = new Set(clientIds);
  const hasDuplicates = uniqueIds.size < clients.length;
  const allSame       = clients.length > 0 && uniqueIds.size === 1;
  const hasUndefined  = clients.some(c => c.id === undefined || c.id === null);

  const report = {
    totalClients: clients.length,
    totalBrands: brands.length,
    uniqueClientIds: uniqueIds.size,
    hasDuplicates,
    allSame,
    hasUndefined,
    clientsBefore: clients.map(c => ({ _id: c._id.toString(), id: c.id, name: c.name })),
    brandsBefore: brands.map(b => ({
      _id: b._id.toString(), id: b.id, clientId: b.clientId,
      preview: (b.content || '').slice(0, 60),
    })),
    changes: [],
    dryRun,
  };

  if (!hasDuplicates && !hasUndefined) {
    report.message = 'No duplicate or missing IDs — data looks healthy. No changes made.';
    return jsonResponse(res, 200, report);
  }

  // Assign new sequential ids to clients (1, 2, 3, ...)
  let nextClientId = 1;
  const clientIdMap = new Map(); // _id.toString() → new integer id

  for (const client of clients) {
    const newId = nextClientId++;
    clientIdMap.set(client._id.toString(), newId);
    report.changes.push({
      type: 'client', _id: client._id.toString(),
      name: client.name, oldId: client.id, newId,
    });
    if (!dryRun) {
      await clientCol.updateOne({ _id: client._id }, { $set: { id: newId } });
    }
  }

  // Fix brandDetails — reassign id and re-link clientId
  // If all brands pointed to the same (wrong) clientId, match by insertion order.
  const brandClientIds = brands.map(b => String(b.clientId));
  const allSameBrandClientId = brands.length > 0 && new Set(brandClientIds).size === 1;

  const oldIdToClients = new Map();
  for (const client of clients) {
    const key = String(client.id);
    if (!oldIdToClients.has(key)) oldIdToClients.set(key, []);
    oldIdToClients.get(key).push(client);
  }

  for (let i = 0; i < brands.length; i++) {
    const brand = brands[i];
    let matchedClient = null;

    if (!allSameBrandClientId) {
      const matches = oldIdToClients.get(String(brand.clientId)) || [];
      if (matches.length === 1) matchedClient = matches[0];
    }

    // Fallback: positional match (brand[i] → client[i])
    if (!matchedClient && i < clients.length) matchedClient = clients[i];

    const newClientId = matchedClient ? clientIdMap.get(matchedClient._id.toString()) : (i + 1);
    const newBrandId  = i + 1;

    report.changes.push({
      type: 'brand', _id: brand._id.toString(),
      preview: (brand.content || '').slice(0, 40),
      oldId: brand.id, newId: newBrandId,
      oldClientId: brand.clientId, newClientId,
      matchedClientName: matchedClient?.name || '(no match)',
    });

    if (!dryRun) {
      await brandCol.updateOne({ _id: brand._id }, { $set: { id: newBrandId, clientId: newClientId } });
    }
  }

  // Reset counters so future inserts don't collide
  const maxId = Math.max(clients.length, brands.length, 10) + 20;
  if (!dryRun) {
    for (const kind of ['clients', 'brandDetails', 'portfolios', 'metaAccounts', 'scheduledPosts', 'postHistory', 'igQueue']) {
      await configCol.updateOne(
        { _id: `counter_${kind}` },
        { $set: { value: maxId } },
        { upsert: true }
      );
    }
  }

  report.message = dryRun
    ? `DRY RUN — would fix ${clients.length} clients + ${brands.length} brand docs. POST with action=repair to apply.`
    : `REPAIRED — fixed ${clients.length} clients + ${brands.length} brand docs. Counters set to ${maxId}.`;

  return jsonResponse(res, 200, report);
}

// ─── Original migrate: import localStorage dump ───────────────────────────────
async function handleMigrate(req, res) {
  const body = await readBody(req);
  const { DB = {}, CFG = {} } = body;

  const counts = {};

  const upsertMany = async (collKey, docs) => {
    if (!Array.isArray(docs) || !docs.length) { counts[collKey] = 0; return; }
    const col = await getCollection(collKey);
    const ops = docs.map(d => {
      const doc = { ...d };
      delete doc._id;
      return {
        updateOne: {
          filter: { id: d.id },
          update: { $set: doc, $setOnInsert: { createdAt: d.createdAt || new Date().toISOString() } },
          upsert: true
        }
      };
    });
    const r = await col.bulkWrite(ops);
    counts[collKey] = (r.upsertedCount || 0) + (r.modifiedCount || 0);
  };

  try {
    await upsertMany('portfolios',     DB.portfolios);
    await upsertMany('clients',        DB.clients);
    await upsertMany('brandDetails',   DB.brandDetails);
    await upsertMany('metaAccounts',   DB.metaAccounts);
    await upsertMany('scheduledPosts', DB.scheduledPosts);
    await upsertMany('postHistory',    DB.postHistory);

    const allIds = [
      ...(DB.portfolios || []), ...(DB.clients || []),
      ...(DB.brandDetails || []), ...(DB.metaAccounts || []),
      ...(DB.scheduledPosts || []), ...(DB.postHistory || [])
    ].map(d => d.id || 0);
    const maxId = Math.max(0, ...allIds, DB._nextId || 0);

    const counters = await getCollection('config');
    for (const kind of ['portfolios','clients','brandDetails','metaAccounts','scheduledPosts','postHistory','igQueue']) {
      await counters.updateOne(
        { _id: `counter_${kind}` },
        { $set: { value: maxId } },
        { upsert: true }
      );
    }

    const configCol = await getCollection('config');
    const cfgUpdate = {
      groqKey: CFG.groqKey || '', groqModel: CFG.groqModel || 'llama-3.1-8b-instant',
      metaAccessToken: CFG.metaAccessToken || '', metaConnected: !!CFG.metaConnected,
      metaPages: CFG.metaPages || [], updatedAt: new Date().toISOString()
    };
    await configCol.updateOne(
      { _id: 'app_config' },
      { $set: cfgUpdate, $setOnInsert: { createdAt: new Date().toISOString() } },
      { upsert: true }
    );

    if (Array.isArray(body.igQueue) && body.igQueue.length) {
      const col = await getCollection('igQueue');
      for (const job of body.igQueue) {
        const doc = { ...job }; delete doc._id;
        await col.updateOne({ jobId: job.jobId }, { $set: doc, $setOnInsert: { createdAt: new Date().toISOString() } }, { upsert: true });
      }
      counts.igQueue = body.igQueue.length;
    } else { counts.igQueue = 0; }

    counts.config = 1; counts.maxId = maxId;
    return jsonResponse(res, 200, { ok: true, migrated: counts, message: 'Migration complete.' });
  } catch (e) {
    console.error('Migration error:', e);
    return jsonResponse(res, 500, { error: e.message || 'migration failed' });
  }
}

// ─── Router ───────────────────────────────────────────────────────────────────
module.exports = withCors(async (req, res) => {
  const action = req.query?.action || '';

  if (action === 'debug') return handleDebug(req, res);
  if (action === 'repair-dry') return handleRepair(req, res, true);
  if (action === 'repair' && req.method === 'POST') return handleRepair(req, res, false);

  if (req.method === 'POST') return handleMigrate(req, res);

  return jsonResponse(res, 405, {
    error: 'method not allowed',
    hint: 'GET ?action=debug | POST ?action=repair-dry | POST ?action=repair | POST (migrate)'
  });
});