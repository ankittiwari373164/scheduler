// api/config/index.js
//
// Application-level config: ChatGPT server URL + token, Meta access token,
// Meta connected flag, list of imported Meta pages.
//
// We store everything as ONE document with _id="app_config" so the frontend
// can fetch+save in one round trip — same shape as the old CFG localStorage
// object (minus the Google access token, which is handled separately by
// the OAuth flow).
//

const { getCollection } = require('../_lib/db');
const { readBody, jsonResponse, withCors } = require('../_lib/helpers');

const CONFIG_ID = 'app_config';

function strip(d) { if (!d) return d; const { _id, ...r } = d; return r; }

// Default config shape so the frontend has something sensible on first load.
const DEFAULT_CFG = {
  aiServerUrl: '',
  aiServerToken: '',
  googleClientId: '',
  metaAccessToken: '',
  metaConnected: false,
  metaPages: []
};

module.exports = withCors(async (req, res) => {
  const col = await getCollection('config');

  if (req.method === 'GET') {
    const doc = await col.findOne({ _id: CONFIG_ID });
    return jsonResponse(res, 200, strip(doc) || DEFAULT_CFG);
  }

  if (req.method === 'PUT' || req.method === 'POST' || req.method === 'PATCH') {
    const body = await readBody(req);
    delete body._id;
    body.updatedAt = new Date().toISOString();
    await col.updateOne(
      { _id: CONFIG_ID },
      { $set: body, $setOnInsert: { createdAt: new Date().toISOString() } },
      { upsert: true }
    );
    const fresh = await col.findOne({ _id: CONFIG_ID });
    return jsonResponse(res, 200, strip(fresh));
  }

  jsonResponse(res, 405, { error: 'method not allowed' });
});
