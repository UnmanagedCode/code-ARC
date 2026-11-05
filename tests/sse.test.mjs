import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createSseHub } from '../src/sse.js';

const noTimers = { setInterval: () => ({ unref() {} }), clearInterval: () => {} };

// A response whose socket never drains: write() returns false and the
// unsent bytes pile up in writableLength.
function stalledRes() {
  return {
    status: null, writableLength: 0, writes: 0, destroyed: false, ended: false,
    writeHead(status) { this.status = status; },
    write(chunk) { this.writes++; this.writableLength += Buffer.byteLength(chunk); return false; },
    destroy() { this.destroyed = true; },
    end() { this.ended = true; },
  };
}
// A healthy response: everything is flushed.
function healthyRes() {
  return { ...stalledRes(), write(chunk) { this.writes++; return true; } };
}
const req = () => Object.assign(new EventEmitter(), { headers: {}, url: '/api/events' });

test('a client that stops reading is dropped once its backlog passes the cap; others keep receiving', () => {
  const hub = createSseHub({ timers: noTimers, maxBufferedBytes: 1000 });
  const slow = stalledRes();
  const fast = healthyRes();
  hub.handle(req(), slow);
  hub.handle(req(), fast);
  for (let i = 0; i < 50; i++) hub.publish('step', { n: i, pad: 'x'.repeat(100) });
  assert.equal(slow.destroyed, true);
  assert.ok(slow.writableLength <= 1000 + 200, 'stopped buffering soon after the cap');
  const writesAtDrop = slow.writes;
  hub.publish('step', { n: 99 });
  assert.equal(slow.writes, writesAtDrop, 'no writes after the drop');
  assert.equal(fast.writes, 51);
  assert.equal(hub.clientCount(), 1);
});

test('a client already over the cap during its initial state is dropped without further writes', () => {
  const hub = createSseHub({ timers: noTimers, maxBufferedBytes: 10 });
  const slow = stalledRes();
  hub.handle(req(), slow, [['status', { a: 'x'.repeat(50) }], ['sessions', []]]);
  assert.equal(slow.destroyed, true);
  assert.equal(slow.writes, 1);
  assert.equal(hub.clientCount(), 0);
});

test('connections past the client cap get 503; a closed one frees its slot', () => {
  const hub = createSseHub({ timers: noTimers, maxClients: 2, headers: { 'x-test': '1' } });
  const reqs = [req(), req()];
  hub.handle(reqs[0], healthyRes());
  hub.handle(reqs[1], healthyRes());
  const third = healthyRes();
  hub.handle(req(), third);
  assert.equal(third.status, 503);
  assert.equal(third.ended, true);
  reqs[0].emit('close');
  const fourth = healthyRes();
  hub.handle(req(), fourth);
  assert.equal(fourth.status, 200);
  assert.equal(hub.clientCount(), 2);
});
