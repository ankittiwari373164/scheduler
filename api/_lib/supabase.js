// api/_lib/supabase.js
// Supabase connection — used ONLY for the shared content calendar.
// Everything else in this app stays on MongoDB (see db.js).

const { createClient } = require('@supabase/supabase-js');

let cached = null;

function getSupabase() {
  if (cached) return cached;

  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_KEY;
  if (!url || !key) {
    throw new Error('SUPABASE_URL / SUPABASE_SERVICE_KEY env vars are not set');
  }

  cached = createClient(url, key, {
    auth: { persistSession: false }
  });
  return cached;
}

module.exports = { getSupabase };
