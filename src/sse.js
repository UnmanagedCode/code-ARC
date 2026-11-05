// Server-sent events to the page (see docs/protocol.md). Keeps a small
// ring so a reconnecting EventSource gets what it missed; a fresh connection
// gets only the initial state, never old announcements. The resume id is the
// Last-Event-ID header, or the `lastEventId` query parameter for a page that
// re-created its EventSource (which cannot set a header); the header wins.
// Event ids are `<boot>-<n>`: a Last-Event-ID from an earlier backend process
// replays the whole ring, which holds what this process announced at startup.
import { randomBytes } from 'node:crypto';

export function createSseHub({ keepaliveMs = 25000, ringSize = 20, headers = {}, timers = { setInterval, clearInterval } } = {}) {
  const clients = new Set();
  const ring = [];
  const boot = randomBytes(4).toString('hex');
  let nextId = 0;

  function frame(event, data, id) {
    return `${id === undefined ? '' : `id: ${id}\n`}event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  }

  return {
    publish(event, data) {
      const n = ++nextId;
      ring.push({ n, event, data });
      if (ring.length > ringSize) ring.shift();
      const chunk = frame(event, data, `${boot}-${n}`);
      for (const res of clients) res.write(chunk);
    },

    // `initial` is a list of [event, data] pairs describing current state,
    // written id-less so they don't move the client's Last-Event-ID.
    handle(req, res, initial = []) {
      res.writeHead(200, {
        ...headers,
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-store',
        connection: 'keep-alive',
      });
      for (const [event, data] of initial) res.write(frame(event, data));
      const header = req.headers['last-event-id'];
      const last = typeof header === 'string' && header !== '' ? header : new URL(req.url, 'http://localhost').searchParams.get('lastEventId');
      if (last) {
        const m = last.match(/^([0-9a-f]+)-(\d+)$/);
        const after = m && m[1] === boot ? Number(m[2]) : 0;
        for (const e of ring) if (e.n > after) res.write(frame(e.event, e.data, `${boot}-${e.n}`));
      }
      clients.add(res);
      const ping = timers.setInterval(() => res.write(': ping\n\n'), keepaliveMs);
      ping.unref?.();
      req.on('close', () => { timers.clearInterval(ping); clients.delete(res); });
    },

    closeAll() {
      for (const res of clients) res.end();
      clients.clear();
    },
  };
}
