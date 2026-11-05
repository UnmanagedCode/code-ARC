// Pure viewer logic, imported straight from frontend/ (no DOM needed).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isNewerThanAll } from '../frontend/sessions.js';

const s = (id, minute) => ({ id, created_at: `2026-01-01T00:${String(minute).padStart(2, '0')}:00.000Z` });

test('only a session newer than every loaded one adds to the server total', () => {
  const loaded = [s('s-00000000000b', 30), s('s-00000000000a', 20)];
  assert.equal(isNewerThanAll(s('s-00000000000c', 40), loaded), true, 'created after the count');
  assert.equal(isNewerThanAll(s('s-000000000001', 5), loaded), false, 'an older live session beyond the loaded pages');
  assert.equal(isNewerThanAll(s('s-00000000000b', 30), loaded), false, 'already loaded');
  assert.equal(isNewerThanAll(s('s-00000000000c', 30), loaded), true, 'same time, later id: newer in list order');
  assert.equal(isNewerThanAll(s('s-00000000000c', 1), []), true, 'nothing loaded yet');
});
