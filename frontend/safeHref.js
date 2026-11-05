const ALLOWED = new Set(['http:', 'https:']);

// `u` as an href when it is an absolute http(s) URL; null otherwise (render
// it as text). No base: a relative `u` throws.
export function safeHref(u) {
  try {
    const url = new URL(u);
    return ALLOWED.has(url.protocol) ? url.href : null;
  } catch {
    return null;
  }
}
