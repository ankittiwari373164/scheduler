// api/migrate.js
//
// One-shot migration endpoint. Frontend sends its entire localStorage
// payload (DB + CFG objects) and we insert it into the corresponding
// MongoDB collections.
//
// Idempotent in the sense that running it twice with the same data
// won't create duplicates — we upsert by `id`.
//

const { getCollection } = require('./_lib/db');
const { readBody, jsonResponse, withCors } = require('./_lib/helpers');

module.exports = withCors(async (req, res) => {
  if (req.method !== 'POST') return jsonResponse(res, 405, { error: 'POST only' });

  const body = await readBody(req);
  const { DB = {}, CFG = {} } = body;

  const counts = {};

  // Helper: upsert an array of docs by their integer id
  const upsertMany = async (collKey, docs) => {
    if (!Array.isArray(docs) || !docs.length) {
      counts[collKey] = 0;
      return;
    }
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

    // Counter — make sure next id won't collide with imported records
    const allIds = [
      ...(DB.portfolios || []),
      ...(DB.clients || []),
      ...(DB.brandDetails || []),
      ...(DB.metaAccounts || []),
      ...(DB.scheduledPosts || []),
      ...(DB.postHistory || [])
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

    // Save the app config (ChatGPT server URL/token, Meta token, metaPages, etc).
    // We DO NOT migrate googleServiceAccount / googleAccessToken — those
    // are replaced by the new OAuth flow.
    const configCol = await getCollection('config');
    const cfgUpdate = {
      aiServerUrl:     CFG.aiServerUrl || '',
      aiServerToken:   CFG.aiServerToken || '',
      metaAccessToken: CFG.metaAccessToken || '',
      metaConnected:   !!CFG.metaConnected,
      metaPages:       CFG.metaPages || [],
      updatedAt:       new Date().toISOString()
    };
    await configCol.updateOne(
      { _id: 'app_config' },
      { $set: cfgUpdate, $setOnInsert: { createdAt: new Date().toISOString() } },
      { upsert: true }
    );

    // Migrate IG queue from localStorage (mf_ig_queue) if provided
    if (Array.isArray(body.igQueue) && body.igQueue.length) {
      const col = await getCollection('igQueue');
      for (const job of body.igQueue) {
        const doc = { ...job };
        delete doc._id;
        await col.updateOne(
          { jobId: job.jobId },
          { $set: doc, $setOnInsert: { createdAt: new Date().toISOString() } },
          { upsert: true }
        );
      }
      counts.igQueue = body.igQueue.length;
    } else {
      counts.igQueue = 0;
    }

    counts.config = 1;
    counts.maxId = maxId;

    jsonResponse(res, 200, {
      ok: true,
      migrated: counts,
      message: 'Migration complete — you can safely clear localStorage now.'
    });
  } catch (e) {
    console.error('Migration error:', e);
    jsonResponse(res, 500, { error: e.message || 'migration failed' });
  }
});
