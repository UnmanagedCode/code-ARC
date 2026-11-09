// createPlayBar driven through a small DOM stub and a fake fetch: the
// per-session state (armed End, messages) and the key claiming rules.
import { test } from 'node:test';
import assert from 'node:assert/strict';

class El {
  constructor(tag) { this.tag = tag; this.children = []; this.attrs = {}; this.listeners = {}; this.textContent = ''; this.hidden = false; this.disabled = false; }
  setAttribute(k, v) { this.attrs[k] = String(v); }
  append(...c) { this.children.push(...c); }
  addEventListener(t, f) { this.listeners[t] = f; }
  click() { return this.listeners.click(); }
  all() { return this.children.flatMap((c) => [c, ...(c.all ? c.all() : [])]); }
}
globalThis.document = { createElement: (tag) => new El(tag) };
const { createPlayBar } = await import('../frontend/playbar.js');

const meta = (id, over = {}) => ({ id, status: 'live', allow_reset: true, owner: { kind: 'human' }, last: { state: 'NOT_FINISHED', available_actions: [1, 5, 6] }, ...over });
const LIVE = { mode: 'live', behind: 0 };

function setup() {
  const container = new El('div');
  const sent = [];
  let release = null;
  globalThis.fetch = (path, init) => {
    sent.push(path);
    const done = () => ({ status: init.method === 'POST' && path.endsWith('/act') ? 409 : 200, json: async () => ({ error: 'refused', code: 'STEP_RATE_LIMITED' }) });
    return release ? new Promise((r) => { release.push(() => r(done())); }) : Promise.resolve(done());
  };
  const bar = createPlayBar(container);
  const all = container.all();
  const byText = (re) => all.find((e) => e.tag === 'button' && re.test(e.textContent));
  const text = (cls) => all.find((e) => e.attrs.class?.includes(cls));
  return { bar, sent, byText, text, hold: () => { release = []; return release; }, all };
}
const key = (k, over = {}) => { const e = { key: k, target: { closest: () => null }, prevented: false, preventDefault() { this.prevented = true; }, ...over }; return e; };
const tick = () => new Promise((r) => setImmediate(r));

// Pins: an armed End belongs to the session it was armed on.
test('End armed on one session is disarmed when another is selected', async () => {
  const { bar, byText, sent } = setup();
  bar.update(meta('s-b'), LIVE);
  byText(/^End$/).click();
  assert.equal(byText(/Confirm end/).textContent, 'Confirm end');
  bar.update(meta('s-a'), LIVE);
  assert.equal(byText(/End/).textContent, 'End');
  await byText(/^End$/).click();
  assert.deepEqual(sent, [], 'one click on the other session only arms it');
});

// Pins: leaving Live disarms End.
test('End is disarmed when the mode leaves Live', () => {
  const { bar, byText } = setup();
  bar.update(meta('s-a'), LIVE);
  byText(/^End$/).click();
  bar.update(meta('s-a'), { mode: 'replay', behind: 0 });
  bar.update(meta('s-a'), LIVE);
  assert.equal(byText(/End/).textContent, 'End');
});

// Pins: a refusal belongs to its session: it is cleared on a switch, and a slow
// reply that lands after a switch is not shown under the new session.
test('a refusal does not follow the selection, and a late reply is dropped', async () => {
  const { bar, byText, text, hold, sent } = setup();
  bar.update(meta('s-a'), LIVE);
  await byText(/Action 1/).click();
  assert.match(text('play-message').textContent, /refused \(STEP_RATE_LIMITED\)/);
  bar.update(meta('s-b'), LIVE);
  assert.equal(text('play-message').textContent, '');

  const pending = hold();
  const inflight = byText(/Action 1/).click();
  bar.update(meta('s-a'), LIVE);
  pending[0]();
  await inflight;
  assert.equal(text('play-message').textContent, '', 'the reply was for s-b');
  assert.match(sent.at(-1), /s-b\/act$/);
});

// Pins: the transient "Catching up" hint is cleared once the shown step is current.
test('Catching up clears when behind returns to 0', () => {
  const { bar, text } = setup();
  bar.update(meta('s-a'), { mode: 'live', behind: 2 });
  bar.cell({ x: 1, y: 2 });
  assert.match(text('play-message').textContent, /Catching up/);
  bar.update(meta('s-a'), LIVE);
  assert.equal(text('play-message').textContent, '');
});

// Pins: the ACTION6 hint is a Live-only hint.
test('the click hint is hidden in Replay', () => {
  const { bar, all } = setup();
  const hint = all.find((e) => e.tag === 'span');
  bar.update(meta('s-a'), LIVE);
  assert.equal(hint.hidden, false);
  bar.update(meta('s-a'), { mode: 'replay', behind: 0 });
  assert.equal(hint.hidden, true);
});

// Pins: Space on a focused control keeps its own meaning (no action, no
// preventDefault); a key that plays is claimed; arrows still play from a button.
test('keys: Space on a button is left alone, plays elsewhere, arrows play from a button', async () => {
  const { bar, sent } = setup();
  bar.update(meta('s-a'), LIVE);
  const element = (kind) => ({ closest: (sel) => (sel.split(',').some((part) => part.trim() === kind) ? {} : null) });
  const button = element('button');
  const link = element('a[href]');
  for (const target of [button, link]) {
    const space = key(' ', { target });
    bar.key(space);
    await tick();
    assert.deepEqual([space.prevented, sent.length], [false, 0], 'Space is the control\'s own');
  }

  const arrow = key('ArrowUp', { target: button });
  bar.key(arrow);
  await tick();
  assert.deepEqual([arrow.prevented, sent.length], [true, 1]);

  const space2 = key(' ');
  bar.key(space2);
  await tick();
  assert.deepEqual([space2.prevented, sent.length], [true, 2]);
  assert.match(sent[1], /s-a\/act$/);

  // ACTION3 is not offered: on a control the key is left alone, elsewhere it is claimed (no page scroll) but sends nothing.
  const unoffered = key('ArrowLeft', { target: button });
  bar.key(unoffered);
  const elsewhere = key('ArrowLeft');
  bar.key(elsewhere);
  await tick();
  assert.deepEqual([unoffered.prevented, elsewhere.prevented, sent.length], [false, true, 2]);
});

// Pins: with no session to play (Replay), keys are not claimed.
test('keys are not claimed in Replay', () => {
  const { bar } = setup();
  bar.update(meta('s-a'), { mode: 'replay', behind: 0 });
  const e = key('ArrowUp');
  bar.key(e);
  assert.equal(e.prevented, false);
});
