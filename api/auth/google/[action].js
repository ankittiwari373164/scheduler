// api/auth/google/[action].js
//
// Handles BOTH Google OAuth flows in one Serverless Function (kept merged
// deliberately — Vercel Hobby caps you at 12 functions total):
//
//   GOOGLE DRIVE (one shared token for the whole app):
//     GET    /api/auth/google/start                    → redirect to consent
//     GET    /api/auth/google/callback                 → handle code, save token
//     GET    /api/auth/google/status                    → JSON {connected,...}
//     DELETE /api/auth/google/status                    → disconnect
//     GET    /api/auth/google/access-token               → mint fresh token
//
//   YOUTUBE (one token PER CLIENT — routed here via vercel.json rewrites
//   that turn /api/auth/youtube/:action into ?service=youtube&action=:action):
//     GET    /api/auth/youtube/start?clientId=5          → redirect to consent
//     GET    /api/auth/youtube/callback                  → handle code, save token
//     GET    /api/auth/youtube/status?clientId=5         → JSON {connected,...}
//     DELETE /api/auth/youtube/status?clientId=5         → disconnect

const googleOAuth = require('../../_lib/googleOAuth');
const youtubeOAuth = require('../../_lib/youtubeOAuth');
const { withCors, jsonResponse } = require('../../_lib/helpers');

function closePage(message, isError = false, kind = 'google') {
  const color = isError ? '#ef4444' : '#22c55e';
  const icon  = isError ? '✕' : '✓';
  const title = isError ? 'Connection Failed' : (kind === 'youtube' ? 'YouTube Channel Connected' : 'Google Drive Connected');
  const eventType = kind === 'youtube' ? 'youtube-oauth' : 'google-oauth';
  return `<!DOCTYPE html>
<html><head><title>${isError ? 'Error' : 'Connected'}</title>
<style>
  body{margin:0;font-family:-apple-system,system-ui,sans-serif;background:#07070d;color:#f8fafc;
       display:flex;align-items:center;justify-content:center;height:100vh}
  .card{text-align:center;padding:40px;background:#0f0f1a;border:1px solid rgba(255,255,255,0.1);
        border-radius:18px;max-width:380px}
  .icon{font-size:48px;color:${color};margin-bottom:14px}
  h2{margin:0 0 8px;font-size:18px}
  p{margin:0;color:#94a3b8;font-size:13px;line-height:1.6}
  .hint{margin-top:18px;font-size:11px;color:#475569}
</style></head>
<body>
<div class="card">
  <div class="icon">${icon}</div>
  <h2>${title}</h2>
  <p>${message}</p>
  <div class="hint">You can close this window.</div>
</div>
<script>
  try {
    if (window.opener) {
      window.opener.postMessage({type:'${eventType}', success:${!isError}, message:${JSON.stringify(message)}}, '*');
    }
  } catch(e){}
  setTimeout(() => { try { window.close(); } catch(e){} }, 1500);
</script>
</body></html>`;
}

// ─── Google Drive handlers ──────────────────────────────────────

async function handleGoogleStart(req, res) {
  const url = googleOAuth.buildAuthUrl(req.query.state || '');
  res.writeHead(302, { Location: url });
  res.end();
}

async function handleGoogleCallback(req, res) {
  const { code, error } = req.query;
  res.setHeader('Content-Type', 'text/html');
  if (error) return res.status(400).send(closePage(`Google returned: ${error}`, true));
  if (!code) return res.status(400).send(closePage('Missing authorization code', true));
  try {
    const tokens = await googleOAuth.exchangeCodeForTokens(code);
    if (!tokens.refresh_token) {
      return res.status(400).send(closePage(
        'No refresh token received. Go to Google Account → Security → Third-party access → remove this app → try connecting again.', true
      ));
    }
    const userInfo = await googleOAuth.fetchUserInfo(tokens.access_token).catch(() => null);
    await googleOAuth.saveTokens(tokens, userInfo);
    return res.status(200).send(closePage(`Signed in as ${userInfo?.email || 'your Google account'}. Drive Bot can now run automatically.`, false));
  } catch (e) {
    console.error('Google OAuth callback error:', e);
    return res.status(500).send(closePage(e.message || 'Unknown error', true));
  }
}

async function handleGoogleStatus(req, res) {
  if (req.method === 'GET') return jsonResponse(res, 200, await googleOAuth.getStatus());
  if (req.method === 'DELETE') { await googleOAuth.disconnect(); return jsonResponse(res, 200, { ok: true, connected: false }); }
  jsonResponse(res, 405, { error: 'method not allowed' });
}

async function handleGoogleAccessToken(req, res) {
  if (req.method !== 'GET') return jsonResponse(res, 405, { error: 'GET only' });
  const status = await googleOAuth.getStatus();
  if (!status.connected) return jsonResponse(res, 400, { error: 'Google Drive not connected. Connect in Settings → Google Drive.' });
  const accessToken = await googleOAuth.getValidAccessToken();
  jsonResponse(res, 200, { accessToken, expiresIn: 3300 });
}

// ─── YouTube (per-client) handlers ───────────────────────────────

async function handleYoutubeStart(req, res) {
  const clientId = req.query.clientId;
  if (!clientId) return jsonResponse(res, 400, { error: 'clientId query param required' });
  const url = youtubeOAuth.buildAuthUrl(clientId);
  res.writeHead(302, { Location: url });
  res.end();
}

async function handleYoutubeCallback(req, res) {
  const { code, error, state: clientId } = req.query;
  res.setHeader('Content-Type', 'text/html');
  if (error) return res.status(400).send(closePage(`Google returned: ${error}`, true, 'youtube'));
  if (!code || !clientId) return res.status(400).send(closePage('Missing authorization code or client', true, 'youtube'));
  try {
    const tokens = await youtubeOAuth.exchangeCodeForTokens(code);
    if (!tokens.refresh_token) {
      return res.status(400).send(closePage(
        'No refresh token received. Go to Google Account → Security → Third-party access → remove this app → try connecting again.', true, 'youtube'
      ));
    }
    const [userInfo, channelInfo] = await Promise.all([
      youtubeOAuth.fetchUserInfo(tokens.access_token).catch(() => null),
      youtubeOAuth.fetchChannelInfo(tokens.access_token).catch(() => null)
    ]);
    await youtubeOAuth.saveTokens(clientId, tokens, userInfo, channelInfo);
    return res.status(200).send(closePage(
      `Connected "${channelInfo?.title || 'your channel'}" (${userInfo?.email || 'unknown account'}). Auto YouTube uploads can now run.`, false, 'youtube'
    ));
  } catch (e) {
    console.error('YouTube OAuth callback error:', e);
    return res.status(500).send(closePage(e.message || 'Unknown error', true, 'youtube'));
  }
}

async function handleYoutubeStatus(req, res) {
  const clientId = req.query.clientId;
  if (!clientId) return jsonResponse(res, 400, { error: 'clientId query param required' });
  if (req.method === 'GET') return jsonResponse(res, 200, await youtubeOAuth.getStatusForClient(clientId));
  if (req.method === 'DELETE') { await youtubeOAuth.disconnectClient(clientId); return jsonResponse(res, 200, { ok: true, connected: false }); }
  jsonResponse(res, 405, { error: 'method not allowed' });
}

// ─── Router ───────────────────────────────────────────────────

module.exports = withCors(async (req, res) => {
  const action = req.query.action;
  // vercel.json rewrites /api/auth/youtube/:action here with ?service=youtube.
  // The callback URL registered with Google is fixed at OAuth-setup time and
  // has no query string of our choosing, so it disambiguates by `state`
  // instead (youtubeOAuth.buildAuthUrl puts the clientId in `state`, so a
  // present-and-numeric `state` on the callback means "this is a YouTube flow").
  const isYoutube = req.query.service === 'youtube' || (action === 'callback' && /^\d+$/.test(req.query.state || ''));

  if (isYoutube) {
    switch (action) {
      case 'start':    return handleYoutubeStart(req, res);
      case 'callback': return handleYoutubeCallback(req, res);
      case 'status':   return handleYoutubeStatus(req, res);
      default: return jsonResponse(res, 404, { error: `Unknown YouTube action "${action}". Valid: start, callback, status` });
    }
  }

  switch (action) {
    case 'start':         return handleGoogleStart(req, res);
    case 'callback':      return handleGoogleCallback(req, res);
    case 'status':         return handleGoogleStatus(req, res);
    case 'access-token':  return handleGoogleAccessToken(req, res);
    default: return jsonResponse(res, 404, { error: `Unknown action "${action}". Valid: start, callback, status, access-token` });
  }
});
