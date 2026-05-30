// api/auth/google/callback.js
//
// Step 2 of OAuth: Google redirected back with a one-time `code`. We
// exchange it for access + refresh tokens, save them to MongoDB, then
// return a tiny HTML page that closes the popup window.
//

const {
  exchangeCodeForTokens,
  fetchUserInfo,
  saveTokens
} = require('../../_lib/googleOAuth');

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
  // Notify the opener so it can refresh, then close
  try {
    if (window.opener) {
      window.opener.postMessage({type:'google-oauth', success:${!isError}, message:${JSON.stringify(message)}}, '*');
    }
  } catch(e){}
  setTimeout(() => { try { window.close(); } catch(e){} }, 1500);
</script>
</body></html>`;
}

module.exports = async (req, res) => {
  try {
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

    const tokens = await exchangeCodeForTokens(code);

    // Refresh token is required — if Google didn't return one, the user
    // probably already granted consent before; we forced prompt=consent
    // in start.js so this should be rare.
    if (!tokens.refresh_token) {
      res.setHeader('Content-Type', 'text/html');
      return res.status(400).send(closePage(
        'No refresh token received. Go to Google Account → Security → Third-party access → remove MetaFlow → try connecting again.',
        true
      ));
    }

    const userInfo = await fetchUserInfo(tokens.access_token).catch(() => null);
    await saveTokens(tokens, userInfo);

    res.setHeader('Content-Type', 'text/html');
    return res.status(200).send(closePage(
      `Signed in as ${userInfo?.email || 'your Google account'}. The Drive Bot can now run automatically.`,
      false
    ));
  } catch (e) {
    console.error('OAuth callback error:', e);
    res.setHeader('Content-Type', 'text/html');
    return res.status(500).send(closePage(e.message || 'Unknown error', true));
  }
};
