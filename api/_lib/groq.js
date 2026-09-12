// api/_lib/groq.js
//
// AI fallback chain: Groq (openai/gpt-oss-120b, rotating across up to 3 of
// your own API keys) → Google Gemini free tier (a completely separate
// quota pool from Groq, so it's a real fallback, not just "try Groq
// again"). Used when the user's own ChatGPT/PromptForge server fails or
// isn't configured — see api/_lib/driveBot.js (server-side, calls this
// directly) and api/store/index.js's "ai-fallback" resource (browser calls
// this via that proxy, since raw API keys must never reach the client).
//
// ENV VARS (all optional except at least one Groq key or Gemini key):
//   GROQ_API_KEY, GROQ_API_KEY_2, GROQ_API_KEY_3   — rotated in order
//   GEMINI_API_KEY                                  — tried after all Groq keys fail
//
// Note on multiple Groq keys: this rotates across YOUR OWN keys to get
// more combined free-tier throughput. That's a gray area against a strict
// reading of most providers' rate-limit terms — low risk for a legitimate
// business tool at this scale, but worth knowing.

const GROQ_MODEL = 'openai/gpt-oss-120b';
const GEMINI_MODEL = 'gemini-2.5-flash';

function groqKeys() {
  return [process.env.GROQ_API_KEY, process.env.GROQ_API_KEY_2, process.env.GROQ_API_KEY_3]
    .filter(Boolean);
}

async function callGroqWithKey(apiKey, prompt, temperature) {
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
    const err = new Error(e?.error?.message || `Groq HTTP ${res.status}`);
    err.status = res.status;
    throw err;
  }
  const data = await res.json();
  const text = data?.choices?.[0]?.message?.content;
  if (!text) throw new Error('Groq returned no content');
  return text;
}

// Tries each configured Groq key in order, moving to the next ONLY on a
// rate-limit-shaped failure (429, or a message mentioning rate/quota) —
// a genuine content/auth error on one key would just repeat on the others,
// so those fail fast instead of burning through every key pointlessly.
async function callGroqRotating(prompt, { temperature = 0.8 } = {}) {
  const keys = groqKeys();
  if (!keys.length) throw new Error('No GROQ_API_KEY configured on the server');

  let lastErr;
  for (let i = 0; i < keys.length; i++) {
    try {
      return await callGroqWithKey(keys[i], prompt, temperature);
    } catch (e) {
      lastErr = e;
      const looksLikeRateLimit = e.status === 429 || /rate.?limit|quota/i.test(e.message || '');
      if (!looksLikeRateLimit) throw e; // real error, not a quota issue — no point trying other keys
      // else: fall through and try the next key
    }
  }
  throw lastErr;
}

async function callGemini(prompt, { temperature = 0.8 } = {}) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error('GEMINI_API_KEY not configured on the server');

  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
      body: JSON.stringify({
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
        generationConfig: { temperature }
      })
    }
  );
  if (!res.ok) {
    const e = await res.json().catch(() => ({}));
    throw new Error(e?.error?.message || `Gemini HTTP ${res.status}`);
  }
  const data = await res.json();
  const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) throw new Error('Gemini returned no content');
  return text;
}

// Full fallback chain: rotate through Groq keys, then try Gemini. Returns
// { text, provider } so callers can log/surface which one actually worked.
async function callFreeFallback(prompt, opts) {
  try {
    const text = await callGroqRotating(prompt, opts);
    return { text, provider: 'groq' };
  } catch (groqErr) {
    try {
      const text = await callGemini(prompt, opts);
      return { text, provider: 'gemini' };
    } catch (geminiErr) {
      throw new Error(`Groq failed (${groqErr.message}) and Gemini failed (${geminiErr.message})`);
    }
  }
}

// Kept for backward compatibility with existing call sites — now just the
// first step of the full chain.
async function callGroq(prompt, opts) {
  return callGroqRotating(prompt, opts);
}

module.exports = { callGroq, callGroqRotating, callGemini, callFreeFallback, GROQ_MODEL, GEMINI_MODEL };
