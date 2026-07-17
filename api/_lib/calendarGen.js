// api/_lib/calendarGen.js
// ONE shared calendar-generation routine used for BOTH programs
// ("omni" = Flow Studio short-video calendars, "chatgpt" = the daily
// image/caption automation calendars).
//
// Uses the SAME self-hosted "PromptForge" ChatGPT server that omni_flow's
// lib/groq.js already talks to (chatgpt.com automation, no OpenAI/Groq API):
//   POST {CHATGPT_SERVER_URL}/api/generate
//   headers: { "x-gen-token": GEN_TOKEN }
//   body: { prompt, chatLink }   chatLink = optional per-client chat URL
//   -> { result: "<text>" }
// Set CHATGPT_SERVER_URL (the ngrok URL) and GEN_TOKEN in scheduler's env —
// same values already used in omni_flow's .env.

const CHATGPT_SERVER_URL = (process.env.CHATGPT_SERVER_URL || "").replace(/\/+$/, "");
const GEN_TOKEN = process.env.GEN_TOKEN || process.env.CHATGPT_GEN_TOKEN || "";

async function callChatGPT(promptText, chatLink) {
  if (!CHATGPT_SERVER_URL) throw new Error("CHATGPT_SERVER_URL not set (your ngrok URL)");
  const res = await fetch(`${CHATGPT_SERVER_URL}/api/generate`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-gen-token": GEN_TOKEN },
    body: JSON.stringify({ prompt: promptText, chatLink: chatLink || undefined })
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || `ChatGPT server HTTP ${res.status}`);
  return String(body.result || "").trim();
}

/**
 * @param {"omni"|"chatgpt"} program
 * @param {string} clientName
 * @param {string} businessDetails
 * @param {number} days
 * @param {string} [startDate] - YYYY-MM-DD, defaults to today
 * @param {string} [chatLink] - per-client ChatGPT conversation URL, if the client has one
 * @returns {Promise<Array<object>>} rows shaped for calendar_items (without client_id/program — caller adds those)
 */
async function generateCalendar({ program, clientName, businessDetails, days = 30, startDate, chatLink }) {
  const base = startDate ? new Date(startDate) : new Date();
  const endDate = new Date(base);
  endDate.setDate(base.getDate() + days - 1);
  const rangeLabel = `${base.toISOString().slice(0, 10)} to ${endDate.toISOString().slice(0, 10)}`;

  const shape = program === 'chatgpt'
    ? `{"items":[{"day":1,"topic":"...","event":"...","goal":"...","isFestive":false,"festivePrompt":""}, ...]}`
    : `{"items":[{"day":1,"topic":"...","hook":"..."}, ...]}`;

  const fieldNotes = program === 'chatgpt'
    ? `- "topic" = short concrete idea (max ~8 words). On a festive day, tie the topic to the festival.
- "event" = the actual festival/holiday name if that calendar day (${rangeLabel}) falls on one relevant to this brand's audience (e.g. Diwali, Holi, Eid, Christmas, New Year, Independence Day, Republic Day, Raksha Bandhan, etc.) — else "".
- "goal" = the marketing goal of the post (e.g. "drive engagement", "showcase product", "festive greeting").
- "isFestive" = true only if "event" names a real festival/holiday landing on that exact date, else false.
- "festivePrompt" = ONLY when isFestive is true: one ready-to-use, concise (3-5 sentence) image-generation prompt for that festival post — mention the festival, brand name, and how the brand's products/services tie in, matching the brand's tone/style. Leave "" when isFestive is false.`
    : `- "topic" = a short concrete idea for a short vertical video (max ~8 words).
- "hook" = a one-line scroll-stopping angle.`;

  const prompt = `You are a social-media content strategist${program === 'chatgpt' ? ' with up-to-date knowledge of real festivals and holidays' : ''}. Produce a JSON content calendar.

Brand: ${clientName}
Brand brief: ${businessDetails || '(none provided)'}
Date range: ${rangeLabel}

Create a ${days}-day content calendar of distinct, engaging ideas for this brand.${program === 'chatgpt' ? ' Check each date against real festivals/holidays relevant to the brand\'s likely audience and flag those days as festive with their own ready image prompt.' : ''}
Respond with RAW JSON only — no markdown, no code fences, no commentary — shaped exactly like:
${shape}
${fieldNotes}
- ${days} items, days 1..${days}, all unique.`;

  const raw = await callChatGPT(prompt, chatLink);
  const cleaned = raw.replace(/```json|```/gi, "").trim();

  let parsed;
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    parsed = { items: [] };
  }

  return (parsed.items || []).map((it, i) => {
    const d = new Date(base);
    d.setDate(base.getDate() + i); // consecutive from start date, ignore model's own day numbering

    const row = {
      scheduled_date: d.toISOString().slice(0, 10),
      topic: it.topic || `Idea ${i + 1}`,
      status: 'planned'
    };
    if (program === 'chatgpt') {
      row.event = it.event || '';
      row.goal = it.goal || '';
      row.done = false;
      const isFestive = !!it.isFestive && !!(it.festivePrompt || '').trim();
      row.prompt = isFestive ? String(it.festivePrompt).trim() : '';
      row.meta = { isFestive };
    } else {
      row.hook = it.hook || '';
    }
    return row;
  });
}

module.exports = { generateCalendar };
