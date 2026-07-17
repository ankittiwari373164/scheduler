// api/calendar/index.js
// GET  /api/calendar?program=omni&clientId=xxx           -> list items for a client
// POST /api/calendar  { program, clientId, clientName, topic, scheduled_date, ... } -> add one manual item
//
// Generation lives in /api/calendar/generate.js (separate route, since it's
// a heavier Groq call and REPLACEs the client's pending items).

const { withCors, jsonResponse, readBody } = require('../_lib/helpers');
const { getSupabase } = require('../_lib/supabase');

function validateProgram(program) {
  if (program !== 'omni' && program !== 'chatgpt') {
    const err = new Error('program must be "omni" or "chatgpt"');
    err.status = 400;
    throw err;
  }
}

module.exports = withCors(async (req, res) => {
  const supabase = getSupabase();

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
});
