// api/migrate.js
//
// Multi-purpose maintenance endpoint:
//
//   POST /api/migrate                  — migrate localStorage dump to MongoDB
//   GET  /api/migrate?action=debug     — show raw IDs for all collections
//   POST /api/migrate?action=repair    — fix ALL duplicate IDs + re-link portfolioId on clients
//   GET  /api/migrate?action=repair    — dry-run (no writes)

const { getCollection } = require('./_lib/db');
const { readBody, jsonResponse, withCors } = require('./_lib/helpers');

// ─── Debug ────────────────────────────────────────────────────────────────────
async function handleDebug(req, res) {
  const portCol   = await getCollection('portfolios');
  const clientCol = await getCollection('clients');
  const brandCol  = await getCollection('brandDetails');

  const portfolios = await portCol.find({}).sort({ _id: 1 }).toArray();
  const clients    = await clientCol.find({}).sort({ _id: 1 }).toArray();
  const brands     = await brandCol.find({}).sort({ _id: 1 }).toArray();

  return jsonResponse(res, 200, {
    portfolios: portfolios.map(p => ({
      _id: p._id?.toString(), id: p.id, id_type: typeof p.id, name: p.name
    })),
    clients: clients.map(d => ({
      _id: d._id?.toString(), id: d.id, id_type: typeof d.id,
      name: d.name, portfolioId: d.portfolioId, portfolioId_type: typeof d.portfolioId,
    })),
    brandDetails: brands.map(b => ({
      _id: b._id?.toString(), id: b.id, clientId: b.clientId,
      clientId_type: typeof b.clientId, contentPreview: (b.content || '').slice(0, 80),
    })),
  });
}

// ─── Repair ───────────────────────────────────────────────────────────────────
async function handleRepair(req, res, dryRun) {
  const portCol   = await getCollection('portfolios');
  const clientCol = await getCollection('clients');
  const brandCol  = await getCollection('brandDetails');
  const configCol = await getCollection('config');

  const portfolios = await portCol.find({}).sort({ _id: 1 }).toArray();
  const clients    = await clientCol.find({}).sort({ _id: 1 }).toArray();
  const brands     = await brandCol.find({}).sort({ _id: 1 }).toArray();

  const changes = [];

  // ── Step 1: Assign unique IDs to portfolios ──────────────────────────────
  // Build map: old portfolioId values → which portfolio name they belonged to.
  // Since all portfolios had id:1, we can't match by old id.
  // Instead assign sequential IDs by insertion order and build a name→newId map.
  const portNameToNewId = new Map(); // portfolio name → new integer id
  const portIdMap = new Map();       // _id.toString() → new integer id

  for (let i = 0; i < portfolios.length; i++) {
    const p = portfolios[i];
    const newId = i + 1;
    portIdMap.set(p._id.toString(), newId);
    portNameToNewId.set(p.name, newId);
    changes.push({ type: 'portfolio', _id: p._id.toString(), name: p.name, oldId: p.id, newId });
    if (!dryRun) {
      await portCol.updateOne({ _id: p._id }, { $set: { id: newId } });
    }
  }

  // ── Step 2: Assign unique IDs to clients + fix their portfolioId ─────────
  // Each client has a portfolioId that was the old localStorage id — now broken.
  // The client grid shows which portfolio pill each client belonged to via portfolio name.
  // Since we can't recover the mapping from broken IDs, use the client's stored portfolioId
  // value to look up which portfolio it likely was (by position in portfolios array),
  // OR fall back to the first portfolio if none matches.
  //
  // Better strategy: clients store portfolioId as a number. Before the IDs broke,
  // portfolios had sequential IDs (1,2,3...). We can map old portfolioId → portfolio
  // by treating old portfolioId as a 1-based index into the portfolios array.

  const clientIdMap = new Map(); // _id.toString() → new integer id

  for (let i = 0; i < clients.length; i++) {
    const c = clients[i];
    const newClientId = i + 1;
    clientIdMap.set(c._id.toString(), newClientId);

    // Remap portfolioId: old value was a sequential number.
    // Map it to the portfolio at that position (1-indexed) in the portfolios array.
    // Clamp to valid range.
    const oldPortId = parseInt(c.portfolioId) || 1;
    // oldPortId was the original localStorage id. Use it as 1-based index into portfolios.
    const portIndex = Math.min(Math.max(oldPortId, 1), portfolios.length) - 1;
    const matchedPortfolio = portfolios[portIndex] || portfolios[0];
    const newPortfolioId = matchedPortfolio ? portIdMap.get(matchedPortfolio._id.toString()) : 1;

    changes.push({
      type: 'client', _id: c._id.toString(), name: c.name,
      oldId: c.id, newId: newClientId,
      oldPortfolioId: c.portfolioId, newPortfolioId,
      portfolioName: matchedPortfolio?.name || '(none)',
    });

    if (!dryRun) {
      await clientCol.updateOne(
        { _id: c._id },
        { $set: { id: newClientId, portfolioId: newPortfolioId } }
      );
    }
  }

  // ── Step 3: Reassign brand IDs and fix clientId ──────────────────────────
  const brandClientIds = brands.map(b => String(b.clientId));
  const allSameBrandClientId = brands.length > 0 && new Set(brandClientIds).size === 1;

  const oldClientIdToClients = new Map();
  for (const c of clients) {
    const key = String(c.id);
    if (!oldClientIdToClients.has(key)) oldClientIdToClients.set(key, []);
    oldClientIdToClients.get(key).push(c);
  }

  for (let i = 0; i < brands.length; i++) {
    const brand = brands[i];
    let matchedClient = null;

    if (!allSameBrandClientId) {
      const matches = oldClientIdToClients.get(String(brand.clientId)) || [];
      if (matches.length === 1) matchedClient = matches[0];
    }
    if (!matchedClient && i < clients.length) matchedClient = clients[i];

    const newClientId = matchedClient ? clientIdMap.get(matchedClient._id.toString()) : (i + 1);
    const newBrandId  = i + 1;

    changes.push({
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

  // ── Step 4: Reset counters ───────────────────────────────────────────────
  const maxId = Math.max(portfolios.length, clients.length, brands.length, 10) + 20;
  if (!dryRun) {
    for (const kind of ['clients','brandDetails','portfolios','metaAccounts','scheduledPosts','postHistory','igQueue']) {
      await configCol.updateOne(
        { _id: `counter_${kind}` },
        { $set: { value: maxId } },
        { upsert: true }
      );
    }
  }

  return jsonResponse(res, 200, {
    dryRun,
    portfoliosFixed: portfolios.length,
    clientsFixed: clients.length,
    brandsFixed: brands.length,
    countersSetTo: dryRun ? null : maxId,
    changes,
    message: dryRun
      ? `DRY RUN — ${portfolios.length} portfolios, ${clients.length} clients, ${brands.length} brands would be fixed. POST to apply.`
      : `REPAIRED — ${portfolios.length} portfolios, ${clients.length} clients, ${brands.length} brands fixed. Counters → ${maxId}.`,
  });
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
      const doc = { ...d }; delete doc._id;
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
    await upsertMany('portfolios',    DB.portfolios);
    await upsertMany('clients',       DB.clients);
    await upsertMany('brandDetails',  DB.brandDetails);
    await upsertMany('metaAccounts',  DB.metaAccounts);
    await upsertMany('scheduledPosts',DB.scheduledPosts);
    await upsertMany('postHistory',   DB.postHistory);

    const allIds = [
      ...(DB.portfolios||[]),...(DB.clients||[]),...(DB.brandDetails||[]),
      ...(DB.metaAccounts||[]),...(DB.scheduledPosts||[]),...(DB.postHistory||[])
    ].map(d => d.id || 0);
    const maxId = Math.max(0, ...allIds, DB._nextId || 0);

    const counters = await getCollection('config');
    for (const kind of ['portfolios','clients','brandDetails','metaAccounts','scheduledPosts','postHistory','igQueue']) {
      await counters.updateOne({ _id: `counter_${kind}` }, { $set: { value: maxId } }, { upsert: true });
    }

    const configCol = await getCollection('config');
    await configCol.updateOne(
      { _id: 'app_config' },
      { $set: { groqKey: CFG.groqKey||'', groqModel: CFG.groqModel||'llama-3.1-8b-instant',
        metaAccessToken: CFG.metaAccessToken||'', metaConnected: !!CFG.metaConnected,
        metaPages: CFG.metaPages||[], updatedAt: new Date().toISOString() },
        $setOnInsert: { createdAt: new Date().toISOString() } },
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
  if (action === 'repair') return handleRepair(req, res, req.method === 'GET');
  if (req.method === 'POST') return handleMigrate(req, res);

  return jsonResponse(res, 405, {
    error: 'method not allowed',
    hint: 'GET ?action=debug | GET ?action=repair (dry-run) | POST ?action=repair | POST (migrate)'
  });
});