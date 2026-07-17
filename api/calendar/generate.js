// api/calendar/generate.js
// POST /api/calendar/generate
// body: { program: "omni"|"chatgpt", clientId, clientName, businessDetails, days, startDate }
//
// Generates a fresh calendar via Groq and REPLACES this client's
// not-yet-produced items (planned | prompt_ready | error). Items already
// done/generating/uploaded are kept so we never wipe finished work or an
// in-progress job — same rule omni_flow used locally.

const { withCors, jsonResponse, readBody } = require('../_lib/helpers');
const { getSupabase } = require('../_lib/supabase');
const { generateCalendar } = require('../_lib/calendarGen');

module.exports = withCors(async (req, res) => {
  if (req.method !== 'POST') return jsonResponse(res, 405, { error: 'Method not allowed' });

  const body = await readBody(req);
  const { program, clientId, clientName, businessDetails, days = 30, startDate, chatLink } = body;

  if (program !== 'omni' && program !== 'chatgpt') {
    return jsonResponse(res, 400, { error: 'program must be "omni" or "chatgpt"' });
  }
  if (!clientId || !clientName) {
    return jsonResponse(res, 400, { error: 'clientId and clientName are required' });
  }

  const supabase = getSupabase();

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
});
