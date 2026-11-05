// Server-sent events to the page (see docs/protocol.md). Keeps a small
// ring so a reconnecting EventSource gets what it missed; a fresh connection
// gets only the initial state, never old announcements. The resume id is the
// Last-Event-ID header, or the `lastEventId` query parameter for a page that
// re-created its EventSource (which cannot set a header); the header wins.
// Event ids are `<boot>-<n>`: a Last-Event-ID from an earlier backend process
// replays the whole ring, which holds what this process announced at startup.
//
// Bounded: at most `maxClients` connections (more get 503), and a client that
// leaves more than `maxBufferedBytes` unsent is dropped rather than buffered
// without limit (its EventSource reconnects and resumes from the ring).
import { randomBytes } from 'node:crypto';
import { SSE_MAX_BUFFERED_BYTES, SSE_MAX_CLIENTS } from './limits.js';

export function createSseHub({
  keepaliveMs = 25000,
  ringSize = 20,
  headers = {},
  timers = { setInterval, clearInterval },
  maxClients = SSE_MAX_CLIENTS,
  maxBufferedBytes = SSE_MAX_BUFFERED_BYTES,
} = {}) {
  const clients = new Map(); // res -> ping timer
  const ring = [];
  const boot = randomBytes(4).toString('hex');
  let nextId = 0;

  function frame(event, data, id) {
    return `${id === undefined ? '' : `id: ${id}\n`}event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  }

  function drop(res) {
    const ping = clients.get(res);
    if (ping === undefined) return;
    timers.clearInterval(ping);
    clients.delete(res);
    res.destroy();
  }

  // Writes, then drops the client if it has fallen too far behind.
  function send(res, chunk) {
    if (!clients.has(res)) return;
    res.write(chunk);
    if (res.writableLength > maxBufferedBytes) drop(res);
  }

  return {
    publish(event, data) {
      const n = ++nextId;
      ring.push({ n, event, data });
      if (ring.length > ringSize) ring.shift();
      const chunk = frame(event, data, `${boot}-${n}`);
      for (const res of [...clients.keys()]) send(res, chunk);
    },

    // `initial` is a list of [event, data] pairs describing current state,
    // written id-less so they don't move the client's Last-Event-ID.
    handle(req, res, initial = []) {
      if (clients.size >= maxClients) {
        res.writeHead(503, { ...headers, 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store', 'retry-after': '5' });
        res.end('too many live viewers');
        return;
      }
      res.writeHead(200, {
        ...headers,
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-store',
        connection: 'keep-alive',
      });
      const ping = timers.setInterval(() => send(res, ': ping\n\n'), keepaliveMs);
      ping?.unref?.();
      clients.set(res, ping);
      req.on('close', () => drop(res));
      for (const [event, data] of initial) send(res, frame(event, data));
      const header = req.headers['last-event-id'];
      const last = typeof header === 'string' && header !== '' ? header : new URL(req.url, 'http://localhost').searchParams.get('lastEventId');
      if (last) {
        const m = last.match(/^([0-9a-f]+)-(\d+)$/);
        const after = m && m[1] === boot ? Number(m[2]) : 0;
        for (const e of ring) if (e.n > after) send(res, frame(e.event, e.data, `${boot}-${e.n}`));
      }
    },

    clientCount: () => clients.size,

    closeAll() {
      for (const [res, ping] of clients) {
        timers.clearInterval(ping);
        res.end();
      }
      clients.clear();
    },
  };
}
