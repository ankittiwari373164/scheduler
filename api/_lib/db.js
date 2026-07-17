// api/_lib/db.js
// MongoDB connection helper — cached across warm starts on Vercel
//
// Scheduler's OWN data (mf_-prefixed collections) lives wherever
// MONGODB_URI points. That may or may not be the SAME database as
// chatgpt-main's — depends on what you set up. Rather than assume, we
// keep a SECOND, optional connection just for reading chatgpt-main's data
// (used only to list its clients for the shared calendar view):
//   - If CHATGPT_MONGODB_URI is set, use it (point this at chatgpt-main's
//     own MONGODB_URI value from its Render env — safest, always correct).
//   - Otherwise, fall back to reusing MONGODB_URI, which only works if
//     scheduler and chatgpt-main really do share one database.

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

  cachedDb = cachedClient.db();
  return cachedDb;
}

let cachedChatgptClient = null;
let cachedChatgptDb = null;

async function getChatgptDb() {
  if (cachedChatgptDb) return cachedChatgptDb;

  // Prefer a dedicated URI; fall back to the shared one if not set.
  const uri = process.env.CHATGPT_MONGODB_URI || process.env.MONGODB_URI;
  if (!uri) throw new Error('CHATGPT_MONGODB_URI (or MONGODB_URI) env var is not set');

  if (process.env.CHATGPT_MONGODB_URI) {
    if (!cachedChatgptClient) {
      cachedChatgptClient = new MongoClient(uri, {
        serverSelectionTimeoutMS: 10000,
        socketTimeoutMS: 30000,
        maxPoolSize: 5
      });
      await cachedChatgptClient.connect();
    }
    cachedChatgptDb = cachedChatgptClient.db();
  } else {
    // No dedicated URI — reuse scheduler's own connection/database.
    cachedChatgptDb = await getDb();
  }
  return cachedChatgptDb;
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

// Read-only access to chatgpt-main's OWN (unprefixed) collections. Uses
// CHATGPT_MONGODB_URI if set, otherwise assumes it's the same database as
// MONGODB_URI. Used only to list chatgpt-main's clients for the shared
// calendar view; never write through this.
async function getRawCollection(name) {
  const db = await getChatgptDb();
  return db.collection(name);
}

module.exports = { getDb, getCollection, getRawCollection, COLLECTIONS };
