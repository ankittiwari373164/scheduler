// api/_lib/db.js
// MongoDB connection helper — cached across warm starts on Vercel
//
// We reuse the SAME MongoDB cluster + database as the chatgpt-automation
// project, but all scheduler collections are prefixed with `mf_` to keep
// them cleanly separated.

const { MongoClient } = require('mongodb');

let cachedClient = null;
let cachedDb = null;

async function getDb() {
  if (cachedDb) return cachedDb;

  const uri = process.env.MONGODB_URI;
  if (!uri) throw new Error('MONGODB_URI env var is not set');

  if (!cachedClient) {
    cachedClient = new MongoClient(uri, {
      // Conservative timeouts so Vercel doesn't hang on cold start
      serverSelectionTimeoutMS: 10000,
      socketTimeoutMS: 30000,
      maxPoolSize: 5
    });
    await cachedClient.connect();
  }

  // Use whatever database the URI specifies (chatgpt-automation default).
  // If the URI has no DB component, fall back to 'chatgpt'.
  cachedDb = cachedClient.db();
  return cachedDb;
}

// Convenience helpers — every scheduler collection is prefixed `mf_`
const COLLECTIONS = {
  portfolios:      'mf_portfolios',
  clients:         'mf_clients',
  brandDetails:    'mf_brandDetails',
  metaAccounts:    'mf_metaAccounts',
  scheduledPosts:  'mf_scheduledPosts',
  postHistory:     'mf_postHistory',
  igQueue:         'mf_igQueue',
  config:          'mf_config',
  googleTokens:    'mf_googleTokens'
};

async function getCollection(name) {
  if (!COLLECTIONS[name]) throw new Error(`Unknown collection: ${name}`);
  const db = await getDb();
  return db.collection(COLLECTIONS[name]);
}

// Read-only access to chatgpt-main's OWN (unprefixed) collections, which
// live in this same MongoDB database (scheduler and chatgpt-main share one
// Atlas cluster/database — scheduler's collections are just mf_-prefixed
// to avoid colliding with chatgpt-main's). Used only to list chatgpt-main's
// clients for the shared calendar view; never write through this.
async function getRawCollection(name) {
  const db = await getDb();
  return db.collection(name);
}

module.exports = { getDb, getCollection, getRawCollection, COLLECTIONS };
