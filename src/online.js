// arcprize.org's ONLINE-mode limits, surfaced to the agent instead of
// retried: https://docs.arcprize.org (rate limits; scorecards auto-close
// after 15 minutes without activity).
export const ONLINE_RPM_LIMIT = 600;
export const ONLINE_IDLE_CLOSE_MS = 15 * 60 * 1000;
const MINUTE_MS = 60 * 1000;

export function scorecardUrl(cardId) {
  return typeof cardId === 'string' && /^[A-Za-z0-9-]{1,64}$/.test(cardId) ? `https://arcprize.org/scorecards/${cardId}` : null;
}

export const idleCloseAt = (lastActivityMs) => lastActivityMs + ONLINE_IDLE_CLOSE_MS;

// A sliding window (60 s unless `windowMs` says otherwise) over request
// timestamps. take(n) books n requests now, or refuses with how long until n
// would fit.
export function createRateLimiter({ clock, limit = ONLINE_RPM_LIMIT, windowMs = MINUTE_MS }) {
  const stamps = [];
  return {
    take(n = 1) {
      const now = clock.now();
      while (stamps.length && stamps[0] <= now - windowMs) stamps.shift();
      if (stamps.length + n > limit) {
        const oldestNeeded = stamps[stamps.length + n - limit - 1];
        return { ok: false, retryAfterMs: Math.max(1, oldestNeeded + windowMs - now) };
      }
      for (let i = 0; i < n; i++) stamps.push(now);
      return { ok: true };
    },
  };
}
