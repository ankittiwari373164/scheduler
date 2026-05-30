// api/_lib/googleOAuth.js
//
// Manages a SINGLE Google OAuth refresh token that has Drive scope and is
// used by all clients' Drive Bot operations. The refresh token never
// expires; we use it to mint short-lived access tokens on demand.
//
// Stored in mf_googleTokens with _id="primary".
//

const { getCollection } = require('./db');

const TOKEN_ID = 'primary';
const SCOPES = [
  'https://www.googleapis.com/auth/drive',
  'https://www.googleapis.com/auth/userinfo.email',
  'https://www.googleapis.com/auth/userinfo.profile'
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
    redirectUri: `${appBaseUrl.replace(/\/$/,'')}/api/auth/google/callback`
  };
}

function buildAuthUrl(state = '') {
  const { clientId, redirectUri } = getOAuthConfig();
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: SCOPES,
    access_type: 'offline',     // we want a refresh token
    prompt: 'consent',          // force refresh token even on repeat consent
    include_granted_scopes: 'true',
    state
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;
}

// Exchange a code for tokens (initial OAuth completion).
async function exchangeCodeForTokens(code) {
  const { clientId, clientSecret, redirectUri } = getOAuthConfig();
  const body = new URLSearchParams({
    code,
    client_id: clientId,
    client_secret: clientSecret,
    redirect_uri: redirectUri,
    grant_type: 'authorization_code'
  });
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body
  });
  const data = await res.json();
  if (!res.ok || data.error) {
    throw new Error(`Google token exchange failed: ${data.error_description || data.error || res.statusText}`);
  }
  return data; // { access_token, refresh_token, expires_in, ... }
}

// Fetch userinfo (just to display "Connected as foo@bar.com")
async function fetchUserInfo(accessToken) {
  const res = await fetch('https://openidconnect.googleapis.com/v1/userinfo', {
    headers: { Authorization: `Bearer ${accessToken}` }
  });
  if (!res.ok) return null;
  return res.json();
}

// Mint a fresh access token from the stored refresh token.
async function refreshAccessToken(refreshToken) {
  const { clientId, clientSecret } = getOAuthConfig();
  const body = new URLSearchParams({
    refresh_token: refreshToken,
    client_id: clientId,
    client_secret: clientSecret,
    grant_type: 'refresh_token'
  });
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body
  });
  const data = await res.json();
  if (!res.ok || data.error) {
    throw new Error(`Refresh failed: ${data.error_description || data.error}`);
  }
  return data; // { access_token, expires_in, ... }
}

// Save tokens to DB (call after initial exchange).
async function saveTokens({ access_token, refresh_token, expires_in, scope }, userInfo = null) {
  const col = await getCollection('googleTokens');
  const expiresAt = Date.now() + (expires_in || 3600) * 1000;
  const doc = {
    _id: TOKEN_ID,
    accessToken: access_token,
    refreshToken: refresh_token,  // never expires — keep forever
    expiresAt,
    scope,
    email: userInfo?.email || null,
    name: userInfo?.name || null,
    picture: userInfo?.picture || null,
    updatedAt: new Date().toISOString()
  };
  await col.updateOne(
    { _id: TOKEN_ID },
    { $set: doc, $setOnInsert: { createdAt: new Date().toISOString() } },
    { upsert: true }
  );
  return doc;
}

// Get a guaranteed-fresh access token. Refreshes if within 60s of expiry.
async function getValidAccessToken() {
  const col = await getCollection('googleTokens');
  const doc = await col.findOne({ _id: TOKEN_ID });
  if (!doc || !doc.refreshToken) {
    throw new Error('Google Drive not connected. Connect in Settings → Google Drive.');
  }
  if (doc.accessToken && doc.expiresAt && doc.expiresAt > Date.now() + 60000) {
    return doc.accessToken;
  }
  const fresh = await refreshAccessToken(doc.refreshToken);
  const expiresAt = Date.now() + (fresh.expires_in || 3600) * 1000;
  await col.updateOne(
    { _id: TOKEN_ID },
    {
      $set: {
        accessToken: fresh.access_token,
        expiresAt,
        updatedAt: new Date().toISOString()
      }
    }
  );
  return fresh.access_token;
}

// Read current connection status (for UI display).
async function getStatus() {
  const col = await getCollection('googleTokens');
  const doc = await col.findOne({ _id: TOKEN_ID });
  if (!doc || !doc.refreshToken) {
    return { connected: false };
  }
  return {
    connected: true,
    email: doc.email,
    name: doc.name,
    picture: doc.picture,
    scope: doc.scope,
    connectedAt: doc.createdAt
  };
}

// Disconnect (revoke + delete record).
async function disconnect() {
  const col = await getCollection('googleTokens');
  const doc = await col.findOne({ _id: TOKEN_ID });
  if (doc?.refreshToken) {
    // Best-effort revoke
    try {
      await fetch(`https://oauth2.googleapis.com/revoke?token=${doc.refreshToken}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
      });
    } catch (_) {}
  }
  await col.deleteOne({ _id: TOKEN_ID });
}

module.exports = {
  buildAuthUrl,
  exchangeCodeForTokens,
  fetchUserInfo,
  refreshAccessToken,
  saveTokens,
  getValidAccessToken,
  getStatus,
  disconnect
};
