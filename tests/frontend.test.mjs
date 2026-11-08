// Pure viewer logic, imported straight from frontend/ (no DOM needed).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isNewerThanAll } from '../frontend/sessions.js';
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
