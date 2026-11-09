// Pure viewer logic, imported straight from frontend/ (no DOM needed).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isNewerThanAll } from '../frontend/sessions.js';
import { cellAt } from '../frontend/grid.js';
import { actionForKey, isHumanSession, playable } from '../frontend/play.js';
import { hasRun, mergeNotes, needsRunHeader, noteFor, sourceOf } from '../frontend/runs.js';

const s = (id, minute) => ({ id, created_at: `2026-01-01T00:${String(minute).padStart(2, '0')}:00.000Z` });

test('only a session newer than every loaded one adds to the server total', () => {
  const loaded = [s('s-00000000000b', 30), s('s-00000000000a', 20)];
  assert.equal(isNewerThanAll(s('s-00000000000c', 40), loaded), true, 'created after the count');
  assert.equal(isNewerThanAll(s('s-000000000001', 5), loaded), false, 'an older live session beyond the loaded pages');
  assert.equal(isNewerThanAll(s('s-00000000000b', 30), loaded), false, 'already loaded');
  assert.equal(isNewerThanAll(s('s-00000000000c', 30), loaded), true, 'same time, later id: newer in list order');
  assert.equal(isNewerThanAll(s('s-00000000000c', 1), []), true, 'nothing loaded yet');
});

const tool = (n) => ({ n, action: 'ACTION1' });
const legacy = (n) => ({ n, action: 'ACTION1', source: undefined });
const script = (n, run) => ({ n, action: 'ACTION1', source: 'script', run });

test('sourceOf: a step without source came from a tool', () => {
  assert.equal(sourceOf(legacy(1)), 'tool');
  assert.equal(sourceOf({ n: 0, action: 'START' }), 'tool');
  assert.equal(sourceOf({ ...tool(1), source: 'tool' }), 'tool');
  assert.equal(sourceOf(script(2, 1)), 'script');
});

test('needsRunHeader: the first loaded step of each run segment, across tool interleaving and trimming', () => {
  const steps = [tool(0), script(1, 1), script(2, 1), tool(3), script(4, 1), script(5, 2), script(6, 2)];
  assert.deepEqual(steps.map((_, i) => needsRunHeader(steps, i)), [false, true, false, false, true, true, false]);
  // Trimmed so a run's first loaded step is mid-run: it still gets the header.
  const trimmed = steps.slice(2);
  assert.equal(needsRunHeader(trimmed, 0), true);
  assert.equal(needsRunHeader(steps.slice(3), 0), false, 'a tool step never does');
});

test('a script step taken before the first note has no run: no header, no note, and it does not hide the next run\'s header', () => {
  const early = { n: 1, action: 'ACTION1', source: 'script' };
  assert.equal(hasRun(early), false);
  assert.equal(hasRun(script(2, 1)), true);
  assert.equal(hasRun(tool(3)), false);
  const steps = [tool(0), early, script(2, 1), script(3, 1)];
  assert.deepEqual(steps.map((_, i) => needsRunHeader(steps, i)), [false, false, true, false]);
  assert.equal(noteFor([{ run: 1, text: 'a' }], early), null);
});

test("noteFor: the note of a script step's run; none for tool steps or an unloaded run", () => {
  const notes = [{ run: 1, text: 'sweep' }, { run: 2, text: 'replay' }];
  assert.equal(noteFor(notes, script(5, 2)).text, 'replay');
  assert.equal(noteFor(notes, script(5, 3)), null);
  assert.equal(noteFor(notes, { ...tool(5), run: 1 }), null);
});

test('mergeNotes: keeps loaded notes, adds live ones it lacks, in run order', () => {
  const loaded = [{ run: 1, text: 'a' }, { run: 2, text: 'b' }];
  assert.deepEqual(mergeNotes(loaded, [{ run: 3, text: 'c' }, { run: 2, text: 'dup' }]).map((n) => n.text), ['a', 'b', 'c']);
  assert.deepEqual(mergeNotes([], [{ run: 2, text: 'b' }, { run: 1, text: 'a' }]).map((n) => n.run), [1, 2]);
});

// Pins: a human step is its own source (log badge), distinct from script and tool.
test('sourceOf: a human step', () => {
  assert.equal(sourceOf({ n: 1, action: 'ACTION1', source: 'human' }), 'human');
  assert.equal(hasRun({ n: 1, source: 'human', run: 1 }), false, 'runs are script-only');
});

const human = (over = {}) => ({
  id: 's-1', status: 'live', allow_reset: true, owner: { kind: 'human', sessionId: null, project: null },
  last: { state: 'NOT_FINISHED', available_actions: [1, 2, 6], ...over },
});

// Pins: only an owner.kind 'human' session is a person's; a meta without kind is an agent's.
test('isHumanSession: legacy metas without owner.kind are agent sessions', () => {
  assert.equal(isHumanSession(human()), true);
  assert.equal(isHumanSession({ owner: { sessionId: 'a', project: 'p' } }), false);
  assert.equal(isHumanSession({ owner: { kind: 'agent', sessionId: null, project: null } }), false);
  assert.equal(isHumanSession({}), false);
});

// Pins: the controls offer exactly the live human session's available actions.
test('playable: controls follow ownership, status, finish state and the resets flag', () => {
  assert.deepEqual(playable(human()), { actions: ['ACTION1', 'ACTION2', 'ACTION6'], reset: true });
  assert.equal(playable({ ...human(), owner: { kind: 'agent', sessionId: 'a', project: 'p' } }), null);
  assert.equal(playable({ ...human(), status: 'ended' }), null);
  assert.deepEqual(playable(human({ state: 'GAME_OVER' })).actions, []);
  assert.deepEqual(playable(human({ state: 'WIN' })).actions, []);
  assert.equal(playable({ ...human(), allow_reset: false }).reset, false);
  const legacyResets = human();
  delete legacyResets.allow_reset;
  assert.equal(playable(legacyResets).reset, true, 'a missing allow_reset is a legacy session: resets allowed');
  assert.deepEqual(playable(human({ available_actions: [0, 1, 8] })).actions, ['ACTION1'], 'RESET and out-of-range ids are never actions');
  assert.equal(playable(undefined), null);
});

const key = (k, extra = {}) => ({ key: k, target: { closest: () => null }, ...extra });

// Pins: the documented key map; one press is one action; modified keys,
// auto-repeat and typing into form controls are never play.
test('actionForKey: mapping, modifiers, repeat and form targets', () => {
  const map = { ArrowUp: 'ACTION1', w: 'ACTION1', W: 'ACTION1', ArrowDown: 'ACTION2', s: 'ACTION2', ArrowLeft: 'ACTION3', a: 'ACTION3', ArrowRight: 'ACTION4', d: 'ACTION4', ' ': 'ACTION5', z: 'ACTION7', r: 'RESET' };
  for (const [k, a] of Object.entries(map)) assert.equal(actionForKey(key(k)), a, k);
  assert.equal(actionForKey(key('x')), null);
  for (const mod of ['ctrlKey', 'metaKey', 'altKey', 'repeat']) assert.equal(actionForKey(key('ArrowUp', { [mod]: true })), null, mod);
  assert.equal(actionForKey({ key: 'a', target: { closest: (sel) => (sel.includes('input') ? {} : null) } }), null);
});

// Pins: a click maps to the cell under it for any frame shape stretched over the rect.
test('cellAt: position over rect times grid size, clamped, offset-aware', () => {
  const rect = { left: 0, top: 0, width: 400, height: 400 };
  assert.deepEqual(cellAt(rect, 100, 50, 64, 64), { x: 16, y: 8 });
  assert.deepEqual(cellAt(rect, 100, 50, 64, 32), { x: 16, y: 4 }, 'a 64×32 frame stretched into a square maps y by 32');
  assert.deepEqual(cellAt(rect, 400, 400, 64, 64), { x: 63, y: 63 });
  assert.deepEqual(cellAt(rect, -5, -5, 64, 64), { x: 0, y: 0 });
  assert.deepEqual(cellAt({ left: 50, top: 20, width: 400, height: 400 }, 150, 70, 64, 64), { x: 16, y: 8 });
});
