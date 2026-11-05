import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { ROOT } from './_helpers.mjs';
import { createMcp } from '../src/mcp.js';
import { ACTIONS, COORD_MAX, DEADLINES, GAME_ID_RE, REASONING_MAX_CHARS, SESSION_ID_RE } from '../src/limits.js';

const manifest = JSON.parse(await fs.readFile(path.join(ROOT, 'conductor.plugin.json'), 'utf8'));
const tools = Object.fromEntries(manifest.mcp.tools.map((t) => [t.name, t.inputSchema]));
// cc's allowed schema subset (code-conductor manifest validator).
const TOP_KEYS = new Set(['type', 'properties', 'required', 'description', 'additionalProperties']);
const PROP_KEYS = new Set(['type', 'enum', 'minLength', 'maxLength', 'pattern', 'minimum', 'maximum', 'items', 'description', 'default']);

test('identity: id, name and nav label', () => {
  assert.equal(manifest.id, 'code-arc');
  assert.equal(manifest.name, 'Code ARC');
  assert.equal(manifest.frontend.navLabel, 'Code ARC');
  assert.equal(manifest.backend.healthPath, '/api/health');
});

test('tool names equal the MCP handler keys', () => {
  const names = createMcp({ sessions: {} })._toolNames();
  assert.deepEqual(Object.keys(tools).sort(), [...names].sort());
});

test('schemas stay within the subset cc accepts', () => {
  for (const [name, s] of Object.entries(tools)) {
    assert.equal(s.type, 'object', name);
    for (const k of Object.keys(s)) assert.ok(TOP_KEYS.has(k), `${name}: top-level key ${k}`);
    for (const [prop, spec] of Object.entries(s.properties || {})) {
      for (const k of Object.keys(spec)) assert.ok(PROP_KEYS.has(k), `${name}.${prop}: key ${k}`);
    }
  }
});

test('schema bounds equal src/limits.js', () => {
  const sessionTools = ['act', 'reset', 'observe', 'end_session'];
  for (const t of sessionTools) assert.equal(tools[t].properties.session_id.pattern, SESSION_ID_RE.source, t);
  assert.equal(tools.start_session.properties.game_id.pattern, GAME_ID_RE.source);
  for (const c of ['x', 'y']) {
    assert.equal(tools.act.properties[c].minimum, 0);
    assert.equal(tools.act.properties[c].maximum, COORD_MAX);
  }
  assert.equal(tools.act.properties.reasoning.maxLength, REASONING_MAX_CHARS);
  assert.equal(tools.reset.properties.reasoning.maxLength, REASONING_MAX_CHARS);
  assert.deepEqual(tools.act.properties.action.enum, [...ACTIONS]);
});

test('every sidecar deadline fits inside the MCP timeout, which cc caps at 120 s', () => {
  assert.ok(manifest.mcp.timeoutMs <= 120000);
  for (const [op, ms] of Object.entries(DEADLINES)) assert.ok(ms < manifest.mcp.timeoutMs, op);
});

test('claudePlugin points at a Claude Code plugin with the play-arc skill', async () => {
  const dir = path.join(ROOT, manifest.claudePlugin);
  const plugin = JSON.parse(await fs.readFile(path.join(dir, '.claude-plugin', 'plugin.json'), 'utf8'));
  assert.equal(plugin.name, 'code-arc');
  const skill = await fs.readFile(path.join(dir, 'skills', 'play-arc', 'SKILL.md'), 'utf8');
  assert.match(skill, /^---\nname: play-arc\ndescription: .+\n---\n/);
});
