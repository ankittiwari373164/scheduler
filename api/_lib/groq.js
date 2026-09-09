// api/_lib/groq.js
//
// Thin wrapper around Groq's OpenAI-compatible chat completions endpoint.
// Used as an automatic fallback wherever caption/metadata generation via
// the user's own ChatGPT/PromptForge server fails or isn't configured —
// see api/_lib/driveBot.js (server-side, calls this directly) and
// api/store/index.js's "ai-fallback" resource (browser calls this via that
// proxy, since a raw GROQ_API_KEY must never reach the client).

const GROQ_MODEL = 'openai/gpt-oss-120b';

async function callGroq(prompt, { temperature = 0.8 } = {}) {
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) throw new Error('GROQ_API_KEY not configured on the server (Vercel env var)');

  const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: GROQ_MODEL,
      messages: [{ role: 'user', content: prompt }],
      temperature
    })
  });

  if (!res.ok) {
    const e = await res.json().catch(() => ({}));
    throw new Error(e?.error?.message || `Groq HTTP ${res.status}`);
  }

  const data = await res.json();
  const text = data?.choices?.[0]?.message?.content;
  if (!text) throw new Error('Groq returned no content');
  return text;
}

module.exports = { callGroq, GROQ_MODEL };
