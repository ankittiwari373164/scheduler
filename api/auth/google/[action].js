// api/auth/google/[action].js
// Merged Google OAuth route. Sub-actions:
//   GET   /api/auth/google/start          → redirect to Google consent
//   GET   /api/auth/google/callback       → handle code, save tokens (HTML response)
//   GET   /api/auth/google/status         → JSON {connected, email, name, picture}
//   DELETE /api/auth/google/status        → disconnect
//   GET   /api/auth/google/access-token   → mint fresh access token for frontend

const {
  buildAuthUrl,
  exchangeCodeForTokens,
  fetchUserInfo,
  saveTokens,
  getValidAccessToken,
  getStatus,
  disconnect
} = require('../../_lib/googleOAuth');
const { withCors, jsonResponse } = require('../../_lib/helpers');

function closePage(message, isError = false) {
  const color = isError ? '#ef4444' : '#22c55e';
  const icon  = isError ? '✕' : '✓';
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
  <h2>${isError ? 'Connection Failed' : 'Google Drive Connected'}</h2>
  <p>${message}</p>
  <div class="hint">You can close this window.</div>
</div>
<script>
  try {
    if (window.opener) {
      window.opener.postMessage({type:'google-oauth', success:${!isError}, message:${JSON.stringify(message)}}, '*');
    }
  } catch(e){}
  setTimeout(() => { try { window.close(); } catch(e){} }, 1500);
</script>
</body></html>`;
}

// ─── Action handlers ──────────────────────────────────────────

async function handleStart(req, res) {
  const url = buildAuthUrl(req.query.state || '');
  res.writeHead(302, { Location: url });
  res.end();
}

async function handleCallback(req, res) {
  const code = req.query.code;
  const error = req.query.error;

  if (error) {
    res.setHeader('Content-Type', 'text/html');
    return res.status(400).send(closePage(`Google returned: ${error}`, true));
  }
  if (!code) {
    res.setHeader('Content-Type', 'text/html');
    return res.status(400).send(closePage('Missing authorization code', true));
  }

  try {
    const tokens = await exchangeCodeForTokens(code);
    if (!tokens.refresh_token) {
      res.setHeader('Content-Type', 'text/html');
      return res.status(400).send(closePage(
        'No refresh token received. Go to Google Account → Security → Third-party access → remove this app → try connecting again.',
        true
      ));
    }
    const userInfo = await fetchUserInfo(tokens.access_token).catch(() => null);
    await saveTokens(tokens, userInfo);
    res.setHeader('Content-Type', 'text/html');
    return res.status(200).send(closePage(
      `Signed in as ${userInfo?.email || 'your Google account'}. Drive Bot can now run automatically.`,
      false
    ));
  } catch (e) {
    console.error('OAuth callback error:', e);
    res.setHeader('Content-Type', 'text/html');
    return res.status(500).send(closePage(e.message || 'Unknown error', true));
  }
}

async function handleStatus(req, res) {
  if (req.method === 'GET') {
    const status = await getStatus();
    return jsonResponse(res, 200, status);
  }
  if (req.method === 'DELETE') {
    await disconnect();
    return jsonResponse(res, 200, { ok: true, connected: false });
  }
  jsonResponse(res, 405, { error: 'method not allowed' });
}

async function handleAccessToken(req, res) {
  if (req.method !== 'GET') return jsonResponse(res, 405, { error: 'GET only' });
  const status = await getStatus();
  if (!status.connected) {
    return jsonResponse(res, 400, {
      error: 'Google Drive not connected. Connect in Settings → Google Drive.'
    });
  }
  const accessToken = await getValidAccessToken();
  jsonResponse(res, 200, { accessToken, expiresIn: 3300 });
}

// ─── Router ───────────────────────────────────────────────────

module.exports = withCors(async (req, res) => {
  const action = req.query.action;
  switch (action) {
    case 'start':         return handleStart(req, res);
    case 'callback':      return handleCallback(req, res);
    case 'status':        return handleStatus(req, res);
    case 'access-token':  return handleAccessToken(req, res);
    default:
      return jsonResponse(res, 404, {
        error: `Unknown action "${action}". Valid: start, callback, status, access-token`
      });
  }
});