// api/auth/google/start.js
//
// Step 1 of OAuth: redirect the user's browser to Google's consent page.
// After they approve, Google redirects to /api/auth/google/callback with
// a `code` query param.
//

const { buildAuthUrl } = require('../../_lib/googleOAuth');
const { withCors, jsonResponse } = require('../../_lib/helpers');

module.exports = withCors(async (req, res) => {
  try {
    const url = buildAuthUrl(req.query.state || '');
    res.writeHead(302, { Location: url });
    res.end();
  } catch (e) {
    jsonResponse(res, 500, { error: e.message });
  }
});
