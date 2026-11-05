import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createSseHub } from '../src/sse.js';

const noTimers = { setInterval: () => ({ unref() {} }), clearInterval: () => {} };

// A response with a socket we control: write() returns false once anything is
// buffered (as a real socket past its high-water mark does); flush() sends
// the backlog and emits 'drain'. A client that never calls flush() is stalled.
class FakeRes extends EventEmitter {
  constructor() {
    super();
    Object.assign(this, { status: null, writableLength: 0, received: '', destroyed: false, ended: false });
  }
  writeHead(status) { this.status = status; }
  write(chunk) {
    this.received += chunk;
    this.writableLength += Buffer.byteLength(chunk);
    return false;
  }
  flush() {
    this.writableLength = 0;
    this.emit('drain');
  }
  destroy() { this.destroyed = true; }
  end() { this.ended = true; }
}
const req = () => Object.assign(new EventEmitter(), { headers: {}, url: '/api/events' });

test('a large initial state is delivered whole to a client, then it keeps receiving', () => {
  const hub = createSseHub({ timers: noTimers, maxBufferedBytes: 1000 });
  const res = new FakeRes();
  const big = Array.from({ length: 400 }, (_, i) => ({ id: `s-${String(i).padStart(12, '0')}`, title: 'x'.repeat(40) }));
  hub.handle(req(), res, [['status', { ok: true }], ['sessions', { sessions: big, total: 400, next: null }]]);
  assert.ok(res.writableLength > 1000, 'the initial state alone is over the cap');
  assert.equal(res.destroyed, false);
  assert.match(res.received, /event: sessions\ndata: \{"sessions":\[/);
  res.flush();
  hub.publish('step', { n: 1 });
  assert.equal(res.destroyed, false);
  assert.match(res.received, /event: step/);
});

test('a client that stays behind across publishes is dropped; one that drains in between is not', () => {
  const hub = createSseHub({ timers: noTimers, maxBufferedBytes: 1000 });
  const stalled = new FakeRes();
  const draining = new FakeRes();
  hub.handle(req(), stalled);
  hub.handle(req(), draining);
  const event = { pad: 'x'.repeat(2000) }; // each publish alone exceeds the cap
  hub.publish('step', event);
  draining.flush();
  assert.equal(stalled.destroyed, false, 'one oversized write is not enough');
  hub.publish('step', event);
  draining.flush();
  assert.equal(stalled.destroyed, true, 'still undrained and over the cap at the next write');
  const before = stalled.received.length;
  for (let i = 0; i < 5; i++) {
    hub.publish('step', event);
    draining.flush();
  }
  assert.equal(stalled.received.length, before, 'nothing written after the drop');
  assert.equal(draining.destroyed, false);
  assert.equal(hub.clientCount(), 1);
});

test('at the client cap a newcomer evicts the oldest connection', () => {
  const hub = createSseHub({ timers: noTimers, maxClients: 2 });
  const [a, b, c] = [new FakeRes(), new FakeRes(), new FakeRes()];
  hub.handle(req(), a); // idle forever: never reads, only pings
  hub.handle(req(), b);
  hub.handle(req(), c);
  assert.equal(c.status, 200);
  assert.equal(a.destroyed, true);
  assert.equal(b.destroyed, false);
  assert.equal(hub.clientCount(), 2);
  hub.publish('step', { n: 1 });
  assert.match(c.received, /event: step/);
  assert.doesNotMatch(a.received, /event: step/);
});

test('a closed client frees its slot even when the injected timer returns undefined', () => {
  const hub = createSseHub({ timers: { setInterval: () => undefined, clearInterval: () => {} }, maxClients: 1 });
  const r = req();
  hub.handle(r, new FakeRes());
  assert.equal(hub.clientCount(), 1);
  r.emit('close');
  assert.equal(hub.clientCount(), 0);
});
