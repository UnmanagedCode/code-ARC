// The plugin's own backend. Every path is relative: a '/'-led one would reach
// cc's API, not this plugin's.
export async function getJson(path) {
  const res = await fetch(path, { headers: { accept: 'application/json' } });
  if (!res.ok) throw new Error(`${path}: HTTP ${res.status}`);
  return res.json();
}

export async function sendJson(path, method, body) {
  const res = await fetch(path, { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body ?? {}) });
  let data = null;
  try { data = await res.json(); } catch { /* empty body */ }
  return { status: res.status, body: data };
}

// Subscribes to the live event stream; handlers keyed by event name.
export function subscribe(handlers) {
  const es = new EventSource('api/events');
  for (const [name, fn] of Object.entries(handlers)) es.addEventListener(name, (e) => fn(JSON.parse(e.data)));
  return es;
}
