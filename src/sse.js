// Server-sent events to the page (see docs/protocol.md). Keeps a small
// ring so a reconnecting EventSource gets what it missed; a fresh connection
// gets only the initial state, never old announcements. The resume id is the
// Last-Event-ID header, or the `lastEventId` query parameter for a page that
// re-created its EventSource (which cannot set a header); the header wins.
// Event ids are `<boot>-<n>`: a Last-Event-ID from an earlier backend process
// replays the whole ring, which holds what this process announced at startup.
//
// Bounded: at most `maxClients` connections — a newcomer at the cap evicts the
// most backed-up connection, else the oldest, so stalled clients can't lock
// the viewer out (a client that keeps opening fresh, unbacked connections
// still evicts by age; only SSE_MAX_CLIENTS turnover limits it) — and
// a client that is still behind from an earlier write (no 'drain' yet) with
// more than `maxBufferedBytes` unsent is dropped rather than buffered without
// limit. One large write (a big initial state) never trips it on its own.
// A dropped EventSource reconnects and resumes from the ring.
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
  const clients = new Map(); // res -> {ping, waiting}; insertion order = age
  const ring = [];
  const boot = randomBytes(4).toString('hex');
  let nextId = 0;

  function frame(event, data, id) {
    return `${id === undefined ? '' : `id: ${id}\n`}event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  }

  function drop(res) {
    if (!clients.has(res)) return;
    timers.clearInterval(clients.get(res).ping);
    clients.delete(res);
    res.destroy();
  }

  // The connection to give up for a newcomer at the cap: the most backed-up
  // one (still undrained, largest backlog), else the oldest.
  function evictionVictim() {
    let victim = null;
    for (const [res, c] of clients) {
      if (c.waiting && (!victim || res.writableLength > victim.writableLength)) victim = res;
    }
    return victim || clients.keys().next().value;
  }

  function send(res, chunk) {
    const c = clients.get(res);
    if (!c) return;
    // Still undrained since an earlier write and over the cap: it isn't keeping up.
    if (c.waiting && res.writableLength > maxBufferedBytes) {
      drop(res);
      return;
    }
    if (!res.write(chunk) && !c.waiting) {
      c.waiting = true;
      res.once('drain', () => { c.waiting = false; });
    }
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
      if (clients.size >= maxClients) drop(evictionVictim());
      res.writeHead(200, {
        ...headers,
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-store',
        connection: 'keep-alive',
      });
      const c = { ping: null, waiting: false };
      clients.set(res, c);
      c.ping = timers.setInterval(() => send(res, ': ping\n\n'), keepaliveMs);
      c.ping?.unref?.();
      req.on('close', () => drop(res));
      // The initial state and any replay go out in one tick, as one burst:
      // the backlog cap only judges what is still unsent at later writes.
      const burst = [];
      for (const [event, data] of initial) burst.push(frame(event, data));
      const header = req.headers['last-event-id'];
      const last = typeof header === 'string' && header !== '' ? header : new URL(req.url, 'http://localhost').searchParams.get('lastEventId');
      if (last) {
        const m = last.match(/^([0-9a-f]+)-(\d+)$/);
        const after = m && m[1] === boot ? Number(m[2]) : 0;
        for (const e of ring) if (e.n > after) burst.push(frame(e.event, e.data, `${boot}-${e.n}`));
      }
      if (burst.length && !res.write(burst.join(''))) {
        c.waiting = true;
        res.once('drain', () => { c.waiting = false; });
      }
    },

    clientCount: () => clients.size,

    closeAll() {
      for (const [res, c] of clients) {
        timers.clearInterval(c.ping);
        res.end();
      }
      clients.clear();
    },
  };
}
