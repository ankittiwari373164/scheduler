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

const GRAPH = 'https://graph.facebook.com/v19.0';

// ── Meta token upgrade (folded in here to avoid adding a new serverless
// function — same trick as the reset branch below). Upgrades a short-lived
// Meta user token into a long-lived one + permanent Page access tokens.
// Call: POST /api/migrate?action=meta-token-upgrade
//       body: { shortToken, appId, appSecret }
async function handleMetaTokenUpgrade(req, res) {
  const body = await readBody(req);
  const { shortToken, appId, appSecret } = body || {};
  if (!shortToken) return jsonResponse(res, 400, { error: 'shortToken is required' });
  if (!appId)      return jsonResponse(res, 400, { error: 'appId is required' });
  if (!appSecret)  return jsonResponse(res, 400, { error: 'appSecret is required' });

  // Step 1: short → long-lived user token
  let longUserToken, longExpiresIn;
  try {
    const url = `${GRAPH}/oauth/access_token?grant_type=fb_exchange_token`
      + `&client_id=${encodeURIComponent(appId)}`
      + `&client_secret=${encodeURIComponent(appSecret)}`
      + `&fb_exchange_token=${encodeURIComponent(shortToken)}`;
    const r = await fetch(url);
    const data = await r.json();
    if (data.error) {
      return jsonResponse(res, 400, {
        error: `Token exchange failed: ${data.error.message}`,
        code: data.error.code,
        type: data.error.type
      });
    }
    if (!data.access_token) {
      return jsonResponse(res, 400, { error: 'No access_token in response', raw: data });
    }
    longUserToken  = data.access_token;
    longExpiresIn  = data.expires_in || 5183944;
  } catch (e) {
    return jsonResponse(res, 500, { error: 'Exchange request failed: ' + e.message });
  }

  // Step 2: fetch user's Pages with permanent tokens
  let pages = [];
  try {
    const url = `${GRAPH}/me/accounts?fields=name,id,access_token,category,tasks,instagram_business_account&limit=100&access_token=${encodeURIComponent(longUserToken)}`;
    const r = await fetch(url);
    const data = await r.json();
    if (data.error) {
      return jsonResponse(res, 400, {
        error: `Fetch pages failed: ${data.error.message}`,
        longUserToken
      });
    }
    pages = data.data || [];
  } catch (e) {
    return jsonResponse(res, 500, { error: 'Pages request failed: ' + e.message, longUserToken });
  }

  // Step 3: for each Page with IG, also fetch the IG username
  for (const p of pages) {
    if (p.instagram_business_account?.id) {
      try {
        const r = await fetch(`${GRAPH}/${p.instagram_business_account.id}?fields=username,name,profile_picture_url&access_token=${encodeURIComponent(p.access_token)}`);
        const d = await r.json();
        if (!d.error) {
          p.instagram_business_account.username = d.username;
          p.instagram_business_account.name = d.name;
          p.instagram_business_account.profile_picture_url = d.profile_picture_url;
        }
      } catch (_) { /* non-fatal */ }
    }
  }

  // Step 4: persist to mf_config
  const normalizedPages = pages.map(p => ({
    pageId:        p.id,
    pageName:      p.name,
    pageToken:     p.access_token,
    category:      p.category || '',
    tasks:         p.tasks || [],
    igId:          p.instagram_business_account?.id || null,
    igName:        p.instagram_business_account?.name || null,
    igUsername:    p.instagram_business_account?.username || null,
    profilePicture: p.instagram_business_account?.profile_picture_url || null,
    businessName:  '',
    businessId:    ''
  }));

  try {
    const col = await getCollection('config');
    const now = new Date().toISOString();
    await col.updateOne(
      { _key: 'app' },
      {
        $set: {
          metaAccessToken: longUserToken,
          metaTokenExpiresAt: new Date(Date.now() + longExpiresIn * 1000).toISOString(),
          metaTokenType: 'long-lived-user',
          metaAppId: appId,
          metaPages: normalizedPages,
          metaConnected: true,
          updatedAt: now
        },
        $setOnInsert: { _key: 'app', createdAt: now }
      },
      { upsert: true }
    );
  } catch (e) {
    return jsonResponse(res, 200, {
      ok: true,
      warning: 'Tokens minted but DB save failed: ' + e.message,
      longUserToken,
      longExpiresIn,
      pages: normalizedPages
    });
  }

  jsonResponse(res, 200, {
    ok: true,
    longUserToken,
    longExpiresIn,
    expiresAt: new Date(Date.now() + longExpiresIn * 1000).toISOString(),
    pages: normalizedPages,
    pageCount: normalizedPages.length,
    igAccountCount: normalizedPages.filter(p => p.igId).length
  });
}

module.exports = withCors(async (req, res) => {
  if (req.method !== 'POST') return jsonResponse(res, 405, { error: 'POST only' });

  if ((req.query && req.query.action) === 'meta-token-upgrade') {
    return handleMetaTokenUpgrade(req, res);
  }

  const body = await readBody(req);

  // ── One-shot RESET (folded in here to avoid adding a new serverless function) ──
  // Wipes portfolios/clients and related data; keeps settings (config) + counters.
  // Call: POST /api/migrate  body: { action:'reset', confirm:'DELETE', all?:true }
  if (body && body.action === 'reset') {
    if (body.confirm !== 'DELETE') return jsonResponse(res, 400, { error: "Add confirm:'DELETE' to wipe. Nothing deleted." });
    const targets = ['portfolios','clients','brandDetails','metaAccounts','scheduledPosts','igQueue','googleTokens'];
    if (body.all) targets.push('postHistory');
    const deleted = {};
    for (const name of targets) {
      try { const col = await getCollection(name); const r = await col.deleteMany({}); deleted[name] = r.deletedCount || 0; }
      catch (e) { deleted[name] = 'error: ' + e.message; }
    }
    return jsonResponse(res, 200, { ok: true, message: 'Reset complete. Settings and ID counters preserved.', deleted });
  }

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
