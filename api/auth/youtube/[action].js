// api/auth/youtube/[action].js
//   GET    /api/auth/youtube/start?clientId=5     → redirect to Google consent
//   GET    /api/auth/youtube/callback             → handle code, save tokens (HTML response)
//   GET    /api/auth/youtube/status?clientId=5    → JSON {connected, channelTitle, ...}
//   DELETE /api/auth/youtube/status?clientId=5    → disconnect

const {
  buildAuthUrl, exchangeCodeForTokens, fetchUserInfo, fetchChannelInfo,
  saveTokens, getStatusForClient, disconnectClient
} = require('../../_lib/youtubeOAuth');
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
  <h2>${isError ? 'Connection Failed' : 'YouTube Channel Connected'}</h2>
  <p>${message}</p>
  <div class="hint">You can close this window.</div>
</div>
<script>
  try {
    if (window.opener) {
      window.opener.postMessage({type:'youtube-oauth', success:${!isError}, message:${JSON.stringify(message)}}, '*');
    }
  } catch(e){}
  setTimeout(() => { try { window.close(); } catch(e){} }, 1500);
</script>
</body></html>`;
}

async function handleStart(req, res) {
  const clientId = req.query.clientId;
  if (!clientId) return jsonResponse(res, 400, { error: 'clientId query param required' });
  const url = buildAuthUrl(clientId);
  res.writeHead(302, { Location: url });
  res.end();
}

async function handleCallback(req, res) {
  const code = req.query.code;
  const error = req.query.error;
  const clientId = req.query.state;

  res.setHeader('Content-Type', 'text/html');
  if (error) return res.status(400).send(closePage(`Google returned: ${error}`, true));
  if (!code || !clientId) return res.status(400).send(closePage('Missing authorization code or client', true));

  try {
    const tokens = await exchangeCodeForTokens(code);
    if (!tokens.refresh_token) {
      return res.status(400).send(closePage(
        'No refresh token received. Go to Google Account → Security → Third-party access → remove this app → try connecting again.',
        true
      ));
    }
    const [userInfo, channelInfo] = await Promise.all([
      fetchUserInfo(tokens.access_token).catch(() => null),
      fetchChannelInfo(tokens.access_token).catch(() => null)
    ]);
    await saveTokens(clientId, tokens, userInfo, channelInfo);
    return res.status(200).send(closePage(
      `Connected "${channelInfo?.title || 'your channel'}" (${userInfo?.email || 'unknown account'}). Auto YouTube uploads can now run.`,
      false
    ));
  } catch (e) {
    console.error('YouTube OAuth callback error:', e);
    return res.status(500).send(closePage(e.message || 'Unknown error', true));
  }
}

async function handleStatus(req, res) {
  const clientId = req.query.clientId;
  if (!clientId) return jsonResponse(res, 400, { error: 'clientId query param required' });
  if (req.method === 'GET') return jsonResponse(res, 200, await getStatusForClient(clientId));
  if (req.method === 'DELETE') { await disconnectClient(clientId); return jsonResponse(res, 200, { ok: true, connected: false }); }
  jsonResponse(res, 405, { error: 'method not allowed' });
}

module.exports = withCors(async (req, res) => {
  const action = req.query.action;
  switch (action) {
    case 'start':    return handleStart(req, res);
    case 'callback': return handleCallback(req, res);
    case 'status':   return handleStatus(req, res);
    default: return jsonResponse(res, 404, { error: `Unknown action "${action}". Valid: start, callback, status` });
  }
});
