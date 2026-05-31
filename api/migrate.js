// api/migrate.js
//
// Multi-purpose maintenance endpoint:
//
//   POST /api/migrate                  — migrate localStorage dump to MongoDB
//   GET  /api/migrate?action=debug     — show raw IDs for all collections
//   GET  /api/migrate?action=repair    — dry-run ID + portfolioId repair
//   POST /api/migrate?action=repair    — apply ID + portfolioId repair

const { getCollection } = require('./_lib/db');
const { readBody, jsonResponse, withCors } = require('./_lib/helpers');

// ─── Debug ────────────────────────────────────────────────────────────────────
async function handleDebug(req, res) {
  const portCol   = await getCollection('portfolios');
  const clientCol = await getCollection('clients');
  const brandCol  = await getCollection('brandDetails');
  const maCol     = await getCollection('metaAccounts');
  const cfgCol    = await getCollection('config');

  const portfolios = await portCol.find({}).sort({ _id: 1 }).toArray();
  const clients    = await clientCol.find({}).sort({ _id: 1 }).toArray();
  const brands     = await brandCol.find({}).sort({ _id: 1 }).toArray();
  const mAccounts  = await maCol.find({}).toArray();
  const cfg        = await cfgCol.findOne({ _id: 'app_config' });

  return jsonResponse(res, 200, {
    portfolios: portfolios.map(p => ({ _id: p._id?.toString(), id: p.id, name: p.name })),
    clients: clients.map(d => ({
      _id: d._id?.toString(), id: d.id, name: d.name,
      portfolioId: d.portfolioId, metaPageId: d.metaPageId,
    })),
    brandDetails: brands.map(b => ({
      _id: b._id?.toString(), id: b.id, clientId: b.clientId,
      contentPreview: (b.content || '').slice(0, 60),
    })),
    metaAccountsSample: mAccounts.slice(0, 5).map(m => ({
      _id: m._id?.toString(), id: m.id, clientId: m.clientId,
      accountId: m.accountId, accountName: m.accountName,
    })),
    metaPagesSample: (cfg?.metaPages || []).slice(0, 5).map(p => ({
      pageId: p.pageId, pageName: p.pageName,
      businessName: p.businessName, businessId: p.businessId,
    })),
  });
}

// ─── Repair ───────────────────────────────────────────────────────────────────
async function handleRepair(req, res, dryRun) {
  const portCol   = await getCollection('portfolios');
  const clientCol = await getCollection('clients');
  const brandCol  = await getCollection('brandDetails');
  const maCol     = await getCollection('metaAccounts');
  const configCol = await getCollection('config');

  const portfolios = await portCol.find({}).sort({ _id: 1 }).toArray();
  const clients    = await clientCol.find({}).sort({ _id: 1 }).toArray();
  const brands     = await brandCol.find({}).sort({ _id: 1 }).toArray();
  const mAccounts  = await maCol.find({}).toArray();
  const cfg        = await configCol.findOne({ _id: 'app_config' });
  const metaPages  = cfg?.metaPages || [];

  const changes = [];

  // ── Step 1: Fix portfolio IDs ──────────────────────────────────────────────
  // Only fix if portfolios have duplicate IDs
  const portIds = portfolios.map(p => p.id);
  const portHasDuplicates = new Set(portIds).size < portfolios.length;
  const portIdMap = new Map(); // _id.toString() → new integer id
  const portNameToNewId = new Map(); // portfolio name → new integer id

  for (let i = 0; i < portfolios.length; i++) {
    const p = portfolios[i];
    const newId = portHasDuplicates ? (i + 1) : p.id;
    portIdMap.set(p._id.toString(), newId);
    portNameToNewId.set(p.name.trim().toLowerCase(), newId);

    if (portHasDuplicates) {
      changes.push({ type: 'portfolio', name: p.name, oldId: p.id, newId });
      if (!dryRun) {
        await portCol.updateOne({ _id: p._id }, { $set: { id: newId } });
      }
    }
  }

  // ── Step 2: Fix client IDs + portfolioId ──────────────────────────────────
  // Build lookup: metaPageId → portfolio name via CFG.metaPages
  // metaPages: { pageId, pageName, businessName (=portfolio name), businessId }
  const pageIdToPortfolioName = new Map();
  for (const mp of metaPages) {
    if (mp.pageId && mp.businessName) {
      pageIdToPortfolioName.set(String(mp.pageId), mp.businessName.trim().toLowerCase());
    }
  }

  // Build lookup: clientId (old/broken) → metaAccount entries
  // After prior repairs, metaAccounts.clientId may also be broken.
  // Instead use positional: metaAccount was created alongside client — match by accountName ~ clientName
  // Best approach: for clients with metaPageId, look up their portfolio name from metaPages
  const clientIdMap = new Map(); // _id.toString() → new integer id
  const clientIds = clients.map(c => c.id);
  const clientHasDuplicates = new Set(clientIds).size < clients.length;

  for (let i = 0; i < clients.length; i++) {
    const c = clients[i];
    const newClientId = clientHasDuplicates ? (i + 1) : c.id;
    clientIdMap.set(c._id.toString(), newClientId);

    // Determine correct portfolioId:
    // Strategy 1: client has metaPageId → look up in metaPages → get businessName → find portfolio
    // Strategy 2: match client name to metaAccount.accountName → get metaAccount → find metaPage → portfolio
    // Strategy 3: keep current portfolioId if it already matches a valid portfolio

    let newPortfolioId = null;

    // Strategy 1: via metaPageId
    if (c.metaPageId) {
      const portName = pageIdToPortfolioName.get(String(c.metaPageId));
      if (portName) newPortfolioId = portNameToNewId.get(portName) || null;
    }

    // Strategy 2: via metaAccount name match
    if (!newPortfolioId) {
      const clientNameLower = (c.name || '').trim().toLowerCase();
      const matchedMa = mAccounts.find(m =>
        (m.accountName || '').trim().toLowerCase() === clientNameLower ||
        (m.accountName || '').trim().toLowerCase().startsWith(clientNameLower.slice(0, 8))
      );
      if (matchedMa) {
        const mp = metaPages.find(p => String(p.pageId) === String(matchedMa.accountId));
        if (mp?.businessName) {
          newPortfolioId = portNameToNewId.get(mp.businessName.trim().toLowerCase()) || null;
        }
      }
    }

    // Strategy 3: current portfolioId is already valid (matches a real portfolio)
    if (!newPortfolioId) {
      const currentPortfolioIdValid = portfolios.some(p =>
        parseInt(p.id) === parseInt(c.portfolioId)
      );
      if (currentPortfolioIdValid) newPortfolioId = parseInt(c.portfolioId);
    }

    // Final fallback: assign to portfolio whose name contains a keyword from the client's portfolio list
    // Use the sidebar portfolio order — clients showed "19 clients" each in the sidebar originally,
    // suggesting ~equal distribution. We keep current portfolioId if it's in valid range.
    if (!newPortfolioId) {
      // Keep existing portfolioId if it's a valid new portfolio id
      const existing = parseInt(c.portfolioId);
      if (existing >= 1 && existing <= portfolios.length) {
        newPortfolioId = existing;
      } else {
        newPortfolioId = 1; // last resort
      }
    }

    const update = { id: newClientId, portfolioId: newPortfolioId };
    const portName = portfolios.find(p => portIdMap.get(p._id.toString()) === newPortfolioId)?.name || '?';

    changes.push({
      type: 'client', name: c.name,
      oldId: c.id, newId: newClientId,
      oldPortfolioId: c.portfolioId, newPortfolioId,
      portfolioName: portName,
      method: c.metaPageId && pageIdToPortfolioName.get(String(c.metaPageId)) ? 'metaPage' :
              newPortfolioId !== 1 ? 'nameMatch' : 'fallback',
    });

    if (!dryRun && (clientHasDuplicates || c.portfolioId !== newPortfolioId)) {
      await clientCol.updateOne({ _id: c._id }, { $set: update });
    }
  }

  // ── Step 3: Fix metaAccounts clientId using name matching ─────────────────
  // metaAccounts.clientId is also broken (all id:1 before). Match by accountName ~ client name
  const newClientByName = new Map(); // client name lower → new client id
  for (let i = 0; i < clients.length; i++) {
    newClientByName.set((clients[i].name || '').trim().toLowerCase(), clientIdMap.get(clients[i]._id.toString()));
  }

  for (const ma of mAccounts) {
    const maName = (ma.accountName || '').trim().toLowerCase();
    // Try exact match, then prefix match
    let matchedClientId = newClientByName.get(maName);
    if (!matchedClientId) {
      for (const [name, cid] of newClientByName) {
        if (name.startsWith(maName.slice(0, 6)) || maName.startsWith(name.slice(0, 6))) {
          matchedClientId = cid;
          break;
        }
      }
    }
    if (matchedClientId && ma.clientId !== matchedClientId) {
      changes.push({
        type: 'metaAccount', accountName: ma.accountName,
        oldClientId: ma.clientId, newClientId: matchedClientId,
      });
      if (!dryRun) {
        await maCol.updateOne({ _id: ma._id }, { $set: { clientId: matchedClientId } });
      }
    }
  }

  // ── Step 4: Fix brand clientId ─────────────────────────────────────────────
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
      type: 'brand', preview: (brand.content || '').slice(0, 40),
      oldId: brand.id, newId: newBrandId,
      oldClientId: brand.clientId, newClientId,
    });
    if (!dryRun) {
      await brandCol.updateOne({ _id: brand._id }, { $set: { id: newBrandId, clientId: newClientId } });
    }
  }

  // ── Step 5: Reset counters ─────────────────────────────────────────────────
  const maxId = Math.max(portfolios.length, clients.length, brands.length, mAccounts.length, 10) + 20;
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
      ? `DRY RUN — review changes[] then POST to apply.`
      : `REPAIRED — portfolios, clients, brands, metaAccounts all fixed.`,
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
    const cfgUpdate = {
      groqKey: CFG.groqKey||'', groqModel: CFG.groqModel||'llama-3.1-8b-instant',
      metaAccessToken: CFG.metaAccessToken||'', metaConnected: !!CFG.metaConnected,
      metaPages: CFG.metaPages||[], updatedAt: new Date().toISOString()
    };
    await counters.updateOne(
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
  if (action === 'debug')  return handleDebug(req, res);
  if (action === 'repair') return handleRepair(req, res, req.method === 'GET');
  if (req.method === 'POST') return handleMigrate(req, res);
  return jsonResponse(res, 405, {
    error: 'method not allowed',
    hint: 'GET ?action=debug | GET ?action=repair (dry-run) | POST ?action=repair | POST (migrate)'
  });
});