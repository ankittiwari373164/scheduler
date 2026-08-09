// api/_lib/youtubeOAuth.js
//
// Each CLIENT (brand) has its own YouTube channel, so — unlike Drive, which
// uses one shared refresh token — YouTube needs one refresh token PER
// CLIENT. Stored in mf_youtubeTokens, keyed by clientId.
//
// Reuses the same Google OAuth app (GOOGLE_OAUTH_CLIENT_ID/SECRET) as Drive,
// just with youtube.upload/readonly scopes and a different redirect URI.
// That OAuth client's consent screen must have those scopes added and (per
// our earlier conversation) either be verified or have each connecting
// Google account added as a Test user.

const { getCollection } = require('./db');

const SCOPES = [
  'https://www.googleapis.com/auth/youtube.upload',
  'https://www.googleapis.com/auth/youtube.readonly',
  'https://www.googleapis.com/auth/userinfo.email'
].join(' ');

function getOAuthConfig() {
  const clientId     = process.env.GOOGLE_OAUTH_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_OAUTH_CLIENT_SECRET;
  const appBaseUrl   = process.env.APP_BASE_URL || '';
  if (!clientId || !clientSecret) {
    throw new Error('GOOGLE_OAUTH_CLIENT_ID / GOOGLE_OAUTH_CLIENT_SECRET env vars not set');
  }
  if (!appBaseUrl) {
    throw new Error('APP_BASE_URL env var not set (e.g. https://your-app.vercel.app)');
  }
  return {
    clientId,
    clientSecret,
    redirectUri: `${appBaseUrl.replace(/\/$/,'')}/api/auth/youtube/callback`
  };
}

// `state` carries the clientId so the callback knows which client this
// connection belongs to.
function buildAuthUrl(clientId) {
  const { clientId: cid, redirectUri } = getOAuthConfig();
  const params = new URLSearchParams({
    client_id: cid,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: SCOPES,
    access_type: 'offline',
    prompt: 'consent',
    include_granted_scopes: 'true',
    state: String(clientId)
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;
}

async function exchangeCodeForTokens(code) {
  const { clientId, clientSecret, redirectUri } = getOAuthConfig();
  const body = new URLSearchParams({
    code, client_id: clientId, client_secret: clientSecret,
    redirect_uri: redirectUri, grant_type: 'authorization_code'
  });
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body
  });
  const data = await res.json();
  if (!res.ok || data.error) {
    throw new Error(`YouTube token exchange failed: ${data.error_description || data.error || res.statusText}`);
  }
  return data;
}

async function fetchUserInfo(accessToken) {
  const res = await fetch('https://openidconnect.googleapis.com/v1/userinfo', {
    headers: { Authorization: `Bearer ${accessToken}` }
  });
  if (!res.ok) return null;
  return res.json();
}

async function fetchChannelInfo(accessToken) {
  const res = await fetch('https://www.googleapis.com/youtube/v3/channels?part=snippet&mine=true', {
    headers: { Authorization: `Bearer ${accessToken}` }
  });
  if (!res.ok) return null;
  const data = await res.json();
  const ch = data.items?.[0];
  return ch ? { id: ch.id, title: ch.snippet?.title } : null;
}

async function refreshAccessToken(refreshToken) {
  const { clientId, clientSecret } = getOAuthConfig();
  const body = new URLSearchParams({
    refresh_token: refreshToken, client_id: clientId,
    client_secret: clientSecret, grant_type: 'refresh_token'
  });
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body
  });
  const data = await res.json();
  if (!res.ok || data.error) {
    throw new Error(`YouTube token refresh failed: ${data.error_description || data.error}`);
  }
  return data;
}

async function saveTokens(clientId, { access_token, refresh_token, expires_in, scope }, userInfo, channelInfo) {
  const col = await getCollection('youtubeTokens');
  const expiresAt = Date.now() + (expires_in || 3600) * 1000;
  const doc = {
    _id: `client_${clientId}`,
    clientId: Number(clientId),
    accessToken: access_token,
    refreshToken: refresh_token,
    expiresAt,
    scope,
    email: userInfo?.email || null,
    channelId: channelInfo?.id || null,
    channelTitle: channelInfo?.title || null,
    updatedAt: new Date().toISOString()
  };
  await col.updateOne(
    { _id: doc._id },
    { $set: doc, $setOnInsert: { createdAt: new Date().toISOString() } },
    { upsert: true }
  );
  return doc;
}

async function getValidAccessTokenForClient(clientId) {
  const col = await getCollection('youtubeTokens');
  const doc = await col.findOne({ _id: `client_${clientId}` });
  if (!doc || !doc.refreshToken) {
    throw new Error(`YouTube not connected for client ${clientId}. Connect it in the client's card (🔁 Auto YouTube).`);
  }
  if (doc.accessToken && doc.expiresAt && doc.expiresAt > Date.now() + 60000) {
    return { accessToken: doc.accessToken, channelId: doc.channelId };
  }
  const fresh = await refreshAccessToken(doc.refreshToken);
  const expiresAt = Date.now() + (fresh.expires_in || 3600) * 1000;
  await col.updateOne({ _id: doc._id }, { $set: { accessToken: fresh.access_token, expiresAt, updatedAt: new Date().toISOString() } });
  return { accessToken: fresh.access_token, channelId: doc.channelId };
}

async function getStatusForClient(clientId) {
  const col = await getCollection('youtubeTokens');
  const doc = await col.findOne({ _id: `client_${clientId}` });
  if (!doc || !doc.refreshToken) return { connected: false };
  return { connected: true, email: doc.email, channelId: doc.channelId, channelTitle: doc.channelTitle, connectedAt: doc.createdAt };
}

async function disconnectClient(clientId) {
  const col = await getCollection('youtubeTokens');
  const doc = await col.findOne({ _id: `client_${clientId}` });
  if (doc?.refreshToken) {
    try {
      await fetch(`https://oauth2.googleapis.com/revoke?token=${doc.refreshToken}`, {
        method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
      });
    } catch (_) {}
  }
  await col.deleteOne({ _id: `client_${clientId}` });
}

module.exports = {
  buildAuthUrl, exchangeCodeForTokens, fetchUserInfo, fetchChannelInfo,
  saveTokens, getValidAccessTokenForClient, getStatusForClient, disconnectClient
};
