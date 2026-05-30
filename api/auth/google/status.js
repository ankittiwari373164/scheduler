// api/auth/google/status.js
//
// GET    → returns { connected, email, name, picture, ... }
// DELETE → disconnects (revoke + remove from DB)
//

const { getStatus, disconnect } = require('../../_lib/googleOAuth');
const { withCors, jsonResponse } = require('../../_lib/helpers');

module.exports = withCors(async (req, res) => {
  if (req.method === 'GET') {
    const status = await getStatus();
    return jsonResponse(res, 200, status);
  }
  if (req.method === 'DELETE') {
    await disconnect();
    return jsonResponse(res, 200, { ok: true, connected: false });
  }
  jsonResponse(res, 405, { error: 'method not allowed' });
});
