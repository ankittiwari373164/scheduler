// api/calendar/index.js
// ONE serverless function handling the whole calendar resource (kept as a
// single file deliberately — Hobby plan has a tight Serverless Function
// count limit, so this folds what would otherwise be 3 files/functions
// into 1, same trick already used elsewhere in this codebase, e.g. migrate.js).
//
// GET    /api/calendar?program=&clientId=[&status=]  -> list items for a client
// POST   /api/calendar        { program, clientId, clientName, topic, scheduled_date, ... } -> add one manual item
// POST   /api/calendar?action=generate   { program, clientId, clientName, businessDetails, days, startDate, chatLink }
//        -> generate a fresh calendar and REPLACE the client's not-yet-produced items
// GET    /api/calendar?id=xxx     -> fetch one item
// PATCH  /api/calendar?id=xxx     { prompt?, status?, done?, ... } -> update one item
// DELETE /api/calendar?id=xxx     -> remove one item
//
// vercel.json rewrites /api/calendar/generate -> /api/calendar?action=generate
// and /api/calendar/:id -> /api/calendar?id=:id so the public URLs stay the
// same as before.

const { withCors, jsonResponse, readBody } = require('../_lib/helpers');
const { getSupabase } = require('../_lib/supabase');
const { generateCalendar } = require('../_lib/calendarGen');

function validateProgram(program) {
  if (program !== 'omni' && program !== 'chatgpt') {
    const err = new Error('program must be "omni" or "chatgpt"');
    err.status = 400;
    throw err;
  }
}

const PATCHABLE = ['scheduled_date', 'topic', 'hook', 'event', 'goal', 'prompt', 'status', 'done', 'meta'];

async function handleOneItem(req, res, supabase, id) {
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
}

async function handleGenerate(req, res, supabase) {
  if (req.method !== 'POST') return jsonResponse(res, 405, { error: 'Method not allowed' });

  const body = await readBody(req);
  const { program, clientId, clientName, businessDetails, days = 30, startDate, chatLink } = body;

  validateProgram(program);
  if (!clientId || !clientName) {
    return jsonResponse(res, 400, { error: 'clientId and clientName are required' });
  }

  const items = await generateCalendar({ program, clientName, businessDetails, days, startDate, chatLink });

  await supabase.from('calendar_items')
    .delete()
    .eq('program', program)
    .eq('client_id', String(clientId))
    .in('status', ['planned', 'prompt_ready', 'error']);

  const rows = items.map(it => ({
    ...it,
    program,
    client_id: String(clientId),
    client_name: clientName
  }));

  const { data, error } = await supabase.from('calendar_items').insert(rows).select();
  if (error) return jsonResponse(res, 500, { error: error.message });

  jsonResponse(res, 200, data);
}

async function handleListOrCreate(req, res, supabase) {
  if (req.method === 'GET') {
    const { program, clientId, status } = req.query || {};
    validateProgram(program);
    if (!clientId) return jsonResponse(res, 400, { error: 'clientId is required' });

    let q = supabase.from('calendar_items')
      .select('*')
      .eq('program', program)
      .eq('client_id', String(clientId))
      .order('scheduled_date', { ascending: true });

    if (status) q = q.eq('status', status);

    const { data, error } = await q;
    if (error) return jsonResponse(res, 500, { error: error.message });
    return jsonResponse(res, 200, data);
  }

  if (req.method === 'POST') {
    const body = await readBody(req);
    const { program, clientId, clientName, scheduled_date, topic } = body;
    validateProgram(program);
    if (!clientId || !scheduled_date || !topic) {
      return jsonResponse(res, 400, { error: 'clientId, scheduled_date and topic are required' });
    }

    const row = {
      program,
      client_id: String(clientId),
      client_name: clientName || null,
      scheduled_date,
      topic,
      hook: body.hook || null,
      event: body.event || null,
      goal: body.goal || null,
      prompt: body.prompt || null,
      status: body.status || 'planned',
      done: !!body.done,
      meta: body.meta || {}
    };

    const { data, error } = await supabase.from('calendar_items').insert(row).select().single();
    if (error) return jsonResponse(res, 500, { error: error.message });
    return jsonResponse(res, 201, data);
  }

  jsonResponse(res, 405, { error: 'Method not allowed' });
}

module.exports = withCors(async (req, res) => {
  const supabase = getSupabase();
  const { id, action } = req.query || {};

  if (id)                     return handleOneItem(req, res, supabase, id);
  if (action === 'generate')  return handleGenerate(req, res, supabase);
  return handleListOrCreate(req, res, supabase);
});
