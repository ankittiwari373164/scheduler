// api/_lib/crud.js
// Generic CRUD route factory. Used by portfolios, clients, meta-accounts,
// scheduled-posts, etc.
//
// We keep the schema almost identical to the localStorage version so the
// frontend changes stay minimal. Every record has:
//   - id           (integer, generated server-side via counters collection)
//   - createdAt    (ISO string)
//   - updatedAt    (ISO string)
// MongoDB also adds _id (ObjectId) automatically — we keep both.

const { getCollection } = require('./db');
const { readBody, jsonResponse, withCors, nextId } = require('./helpers');

// Strip the Mongo internal _id from outgoing payloads so the frontend only
// sees the integer `id` field it already knows about.
function strip(doc) {
  if (!doc) return doc;
  const { _id, ...rest } = doc;
  // Always normalise id fields to integers so the frontend never sees
  // strings vs numbers mismatches (legacy localStorage data may have stored
  // them as strings).
  if (rest.id           !== undefined) rest.id           = parseInt(rest.id, 10)           || rest.id;
  if (rest.portfolioId  !== undefined) rest.portfolioId  = parseInt(rest.portfolioId, 10)  || rest.portfolioId;
  if (rest.clientId     !== undefined) rest.clientId     = parseInt(rest.clientId, 10)     || rest.clientId;
  if (rest.metaAccountId !== undefined) rest.metaAccountId = parseInt(rest.metaAccountId, 10) || rest.metaAccountId;
  return rest;
}

// Build a MongoDB filter that matches a numeric id stored as EITHER an
// integer or a string — handles legacy localStorage-migrated data.
function idFilter(id) {
  const n = parseInt(id, 10);
  const s = String(id);
  if (Number.isNaN(n)) return { id: s };
  return { $or: [{ id: n }, { id: s }] };
}

// Same for any foreign-key field (clientId, portfolioId …)
function fkFilter(field, value) {
  const n = parseInt(value, 10);
  const s = String(value);
  if (Number.isNaN(n)) return { [field]: s };
  return { $or: [{ [field]: n }, { [field]: s }] };
}

// List handler — supports basic filtering via query string.
// e.g. /api/clients?portfolioId=4
function makeListHandler(collectionKey) {
  return async (req, res) => {
    const col = await getCollection(collectionKey);
    const filter = {};

    // Whitelist filter keys per collection.
    const allowedFilters = {
      clients:        ['portfolioId'],
      brandDetails:   ['clientId'],
      metaAccounts:   ['clientId', 'accountType', 'accountId', 'isActive'],
      scheduledPosts: ['clientId', 'status', 'metaAccountId'],
      postHistory:    ['clientId', 'scheduledPostId', 'platform'],
      igQueue:        ['status'],
      portfolios:     [],
      config:         []
    };

    const allowed = allowedFilters[collectionKey] || [];
    for (const key of allowed) {
      if (req.query[key] !== undefined && req.query[key] !== '') {
        let v = req.query[key];
        if (key === 'isActive') {
          filter[key] = v === 'true' || v === '1';
        } else if (key.endsWith('Id') && !Number.isNaN(parseInt(v, 10))) {
          // Match both integer and string forms for legacy compatibility
          const fk = fkFilter(key, v);
          Object.assign(filter, fk);
        } else {
          filter[key] = v;
        }
      }
    }

    const rows = await col.find(filter).sort({ createdAt: -1 }).toArray();
    jsonResponse(res, 200, rows.map(strip));
  };
}

// Create handler — body is the new record. We assign id + timestamps.
function makeCreateHandler(collectionKey) {
  return async (req, res) => {
    const body = await readBody(req);
    const col = await getCollection(collectionKey);
    const now = new Date().toISOString();
    const doc = {
      ...body,
      id: await nextId(getCollection, collectionKey),
      createdAt: now,
      updatedAt: now
    };
    // Normalise all id fields to integers on write
    if (doc.portfolioId  !== undefined) doc.portfolioId  = parseInt(doc.portfolioId, 10)  || doc.portfolioId;
    if (doc.clientId     !== undefined) doc.clientId     = parseInt(doc.clientId, 10)     || doc.clientId;
    if (doc.metaAccountId !== undefined) doc.metaAccountId = parseInt(doc.metaAccountId, 10) || doc.metaAccountId;
    // Don't let the client overwrite the _id Mongo will assign.
    delete doc._id;
    await col.insertOne(doc);
    jsonResponse(res, 201, strip(doc));
  };
}

// Get-by-id handler — returns a single document by integer id.
// Matches against both integer and string stored values for legacy compat.
function makeGetByIdHandler(collectionKey) {
  return async (req, res) => {
    const rawId = req.query.id;
    if (!rawId) return jsonResponse(res, 400, { error: 'id required' });
    const col = await getCollection(collectionKey);
    const doc = await col.findOne(idFilter(rawId));
    if (!doc) return jsonResponse(res, 404, { error: 'not found' });
    jsonResponse(res, 200, strip(doc));
  };
}

// Update handler — accepts partial body, updates by integer id.
function makeUpdateHandler(collectionKey) {
  return async (req, res) => {
    const rawId = req.query.id;
    if (!rawId) return jsonResponse(res, 400, { error: 'id required' });
    const body = await readBody(req);
    delete body.id;
    delete body._id;
    delete body.createdAt;
    body.updatedAt = new Date().toISOString();
    // Normalise foreign key fields to integers on write
    if (body.portfolioId  !== undefined) body.portfolioId  = parseInt(body.portfolioId, 10)  || body.portfolioId;
    if (body.clientId     !== undefined) body.clientId     = parseInt(body.clientId, 10)     || body.clientId;
    if (body.metaAccountId !== undefined) body.metaAccountId = parseInt(body.metaAccountId, 10) || body.metaAccountId;

    const col = await getCollection(collectionKey);
    const result = await col.findOneAndUpdate(
      idFilter(rawId),
      { $set: body },
      { returnDocument: 'after' }
    );
    const doc = result?.value || result;
    if (!doc) return jsonResponse(res, 404, { error: 'not found' });
    jsonResponse(res, 200, strip(doc));
  };
}

// Delete handler — by integer id.
function makeDeleteHandler(collectionKey, cascadeFn = null) {
  return async (req, res) => {
    const rawId = req.query.id;
    if (!rawId) return jsonResponse(res, 400, { error: 'id required' });

    const col = await getCollection(collectionKey);
    const deleted = await col.findOneAndDelete(idFilter(rawId));
    const doc = deleted?.value || deleted;
    if (!doc) return jsonResponse(res, 404, { error: 'not found' });

    // Optional cascade (e.g. deleting a client also removes its brand details)
    const numId = parseInt(rawId, 10);
    if (cascadeFn) await cascadeFn(numId);

    jsonResponse(res, 200, { ok: true, deleted: strip(doc) });
  };
}

// Convenience builders so each route file is 2 lines.
function indexRoute(collectionKey) {
  const list = makeListHandler(collectionKey);
  const create = makeCreateHandler(collectionKey);
  return withCors(async (req, res) => {
    if (req.method === 'GET')  return list(req, res);
    if (req.method === 'POST') return create(req, res);
    jsonResponse(res, 405, { error: 'method not allowed' });
  });
}

function idRoute(collectionKey, cascadeFn = null) {
  const getById = makeGetByIdHandler(collectionKey);
  const update  = makeUpdateHandler(collectionKey);
  const remove  = makeDeleteHandler(collectionKey, cascadeFn);
  return withCors(async (req, res) => {
    if (req.method === 'GET')                            return getById(req, res);
    if (req.method === 'PUT' || req.method === 'PATCH')  return update(req, res);
    if (req.method === 'DELETE')                         return remove(req, res);
    jsonResponse(res, 405, { error: 'method not allowed' });
  });
}

module.exports = { indexRoute, idRoute, strip };