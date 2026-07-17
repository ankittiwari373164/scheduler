// api/calendar/[id].js
// PATCH  /api/calendar/:id   { prompt?, status?, done?, ... } -> update one item
//        (e.g. omni_flow sets prompt+status="prompt_ready"; chatgpt-main sets done=true)
// DELETE /api/calendar/:id   -> remove one item
// GET    /api/calendar/:id   -> fetch one item

const { withCors, jsonResponse, readBody } = require('../_lib/helpers');
const { getSupabase } = require('../_lib/supabase');

function extractId(req) {
  if (req.query && req.query.id) return req.query.id;
  const path = (req.url || '').split('?')[0];
  const match = path.match(/^\/api\/calendar\/([^/]+)$/);
  return match ? match[1] : null;
}

const PATCHABLE = ['scheduled_date', 'topic', 'hook', 'event', 'goal', 'prompt', 'status', 'done', 'meta'];

module.exports = withCors(async (req, res) => {
  const id = extractId(req);
  if (!id) return jsonResponse(res, 400, { error: 'id is required' });

  const supabase = getSupabase();

  if (req.method === 'GET') {
    const { data, error } = await supabase.from('calendar_items').select('*').eq('id', id).single();
    if (error) return jsonResponse(res, 404, { error: 'item not found' });
    return jsonResponse(res, 200, data);
  }

  if (req.method === 'PATCH' || req.method === 'PUT') {
    const body = await readBody(req);
    const patch = {};
    for (const key of PATCHABLE) if (body[key] !== undefined) patch[key] = body[key];
    if (!Object.keys(patch).length) return jsonResponse(res, 400, { error: 'no updatable fields provided' });

    const { data, error } = await supabase.from('calendar_items').update(patch).eq('id', id).select().single();
    if (error) return jsonResponse(res, 500, { error: error.message });
    return jsonResponse(res, 200, data);
  }

  if (req.method === 'DELETE') {
    const { error } = await supabase.from('calendar_items').delete().eq('id', id);
    if (error) return jsonResponse(res, 500, { error: error.message });
    return jsonResponse(res, 200, { ok: true });
  }

  jsonResponse(res, 405, { error: 'Method not allowed' });
});
