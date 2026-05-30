// api/auth/google/access-token.js
//
// Returns a freshly-minted Google access token to the frontend.
// The frontend uses this when it needs to call the Google Drive API
// directly (listing folder files, downloading files, deleting files,
// granting public-read permission, etc.) — the SAME calls the old
// front-end made when it had a service-account JSON pasted in.
//
// Now those calls work through our OAuth refresh token instead.
//
// Tokens expire in ~1hr; the frontend can call this again whenever it
// needs a fresh one. The token reuses Google's caching.
//

const { getValidAccessToken, getStatus } = require('../../_lib/googleOAuth');
const { withCors, jsonResponse } = require('../../_lib/helpers');

module.exports = withCors(async (req, res) => {
  if (req.method !== 'GET') return jsonResponse(res, 405, { error: 'GET only' });

  try {
    const status = await getStatus();
    if (!status.connected) {
      return jsonResponse(res, 400, {
        error: 'Google Drive not connected. Connect in Settings → Google Drive.'
      });
    }
    const accessToken = await getValidAccessToken();
    // Return the token with a generous-but-honest expiry hint.
    // Google access tokens are ~3600s; we say 3300 to be safe.
    jsonResponse(res, 200, { accessToken, expiresIn: 3300 });
  } catch (e) {
    jsonResponse(res, 500, { error: e.message });
  }
});
