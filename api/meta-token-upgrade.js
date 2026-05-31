// api/meta-token-upgrade.js
// Upgrades a short-lived Meta user token into:
//   1. A long-lived user token (60 days)
//   2. Permanent Page access tokens (never expire)
//
// Body:
//   { shortToken: "EAA...", appId: "123", appSecret: "abc" }
//
// Returns:
//   {
//     longUserToken: "...",
//     longExpiresIn: 5183944,
//     pages: [
//       { id, name, access_token (permanent), instagram_business_account, ... }
//     ]
//   }
//
// Stores the result in mf_config (overwrites metaAccessToken with the
// long-lived one and metaPages with the permanent-page-token list).

const { getCollection } = require('./_lib/db');
const { readBody, jsonResponse, withCors } = require('./_lib/helpers');

const GRAPH = 'https://graph.facebook.com/v19.0';

module.exports = withCors(async (req, res) => {
  if (req.method !== 'POST') {
    return jsonResponse(res, 405, { error: 'POST only' });
  }

  let body;
  try {
    body = await readBody(req);
  } catch (e) {
    return jsonResponse(res, 400, { error: 'invalid JSON body' });
  }

  const { shortToken, appId, appSecret } = body || {};
  if (!shortToken) return jsonResponse(res, 400, { error: 'shortToken is required' });
  if (!appId)      return jsonResponse(res, 400, { error: 'appId is required' });
  if (!appSecret)  return jsonResponse(res, 400, { error: 'appSecret is required' });

  // ─── Step 1: short → long-lived user token ────────────────
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

  // ─── Step 2: fetch user's Pages with permanent tokens ─────
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

  // ─── Step 3: for each Page with IG, also fetch the IG username ──
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

  // ─── Step 4: persist to mf_config ─────────────────────────
  // Normalize to the schema the frontend expects:
  //   { pageId, pageName, pageToken, igId, igName, igUsername,
  //     businessName, businessId, category, tasks, profilePicture }
  const normalizedPages = pages.map(p => ({
    pageId:        p.id,
    pageName:      p.name,
    pageToken:     p.access_token,                   // permanent
    category:      p.category || '',
    tasks:         p.tasks || [],
    igId:          p.instagram_business_account?.id || null,
    igName:        p.instagram_business_account?.name || null,
    igUsername:    p.instagram_business_account?.username || null,
    profilePicture: p.instagram_business_account?.profile_picture_url || null,
    businessName:  '',    // user assigns in UI
    businessId:    ''     // user assigns in UI
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
          // NOTE: we intentionally do NOT store appSecret in the DB.
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
});