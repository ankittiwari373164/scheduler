// api/_lib/retry.js
//
// Shared retry-with-backoff helper. Used by driveBot.js (caption gen, Drive
// "make public") and ytPublisher.js (Drive download, YouTube token refresh,
// YouTube upload) to absorb momentary blips in third-party APIs without
// waiting for the next full cron run to retry.

async function withRetries(fn, { attempts = 3, baseDelayMs = 1500 } = {}) {
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try { return await fn(); }
    catch (e) {
      lastErr = e;
      if (i < attempts - 1) await new Promise(r => setTimeout(r, baseDelayMs * (i + 1)));
    }
  }
  throw lastErr;
}

module.exports = { withRetries };
