import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { ROOT } from './_helpers.mjs';
import { IMAGE_SPEC } from '../src/boardImage.js';
import { createMcp } from '../src/mcp.js';
import { checkSchema } from './_jsonSchemaSubset.mjs';
import { ACTIONS, ANIMATION_FRAMES_MAX, ANIMATION_PAGE_MAX, COORD_MAX, DEADLINES, GAME_ID_RE, NOTE_MAX_CHARS, REASONING_MAX_CHARS, SESSION_ID_RE, SESSION_STEPS_MAX } from '../src/limits.js';

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

// Invariant: every tool declares an outputSchema cc accepts (so it is served
// typed, not text-only), and the copies of the shared observation schema agree.
test('every tool has an outputSchema within the validated subset, root an object', () => {
  for (const t of manifest.mcp.tools) {
    assert.ok(t.outputSchema, `${t.name} has an outputSchema`);
    assert.equal(t.outputSchema.type, 'object', t.name);
    assert.doesNotThrow(() => checkSchema(t.outputSchema), t.name);
  }
});

test('act, reset, observe and start_session share one observation schema', () => {
  const out = Object.fromEntries(manifest.mcp.tools.map((t) => [t.name, t.outputSchema]));
  assert.deepEqual(out.reset, out.act);
  assert.deepEqual(out.observe, out.act);
  assert.deepEqual(out.start_session, out.act);
});

test('no tool description names the old meta channel', () => {
  for (const t of manifest.mcp.tools) assert.doesNotMatch(t.description, /meta\./, t.name);
});

test('list_sessions offset is a non-negative integer with no schema default', () => {
  const o = tools.list_sessions.properties.offset;
  assert.equal(o.type, 'integer');
  assert.equal(o.minimum, 0);
  assert.equal(o.default, undefined);
});

test('schema bounds equal src/limits.js', () => {
  const sessionTools = ['act', 'reset', 'observe', 'end_session', 'note'];
  for (const t of sessionTools) assert.equal(tools[t].properties.session_id.pattern, SESSION_ID_RE.source, t);
  assert.equal(tools.start_session.properties.game_id.pattern, GAME_ID_RE.source);
  for (const c of ['x', 'y']) {
    assert.equal(tools.act.properties[c].minimum, 0);
    assert.equal(tools.act.properties[c].maximum, COORD_MAX);
  }
  assert.equal(tools.act.properties.reasoning.maxLength, REASONING_MAX_CHARS);
  assert.equal(tools.reset.properties.reasoning.maxLength, REASONING_MAX_CHARS);
  assert.equal(tools.note.properties.note.maxLength, NOTE_MAX_CHARS);
  assert.deepEqual(tools.act.properties.action.enum, [...ACTIONS]);
});

test('board image options equal src/board_image.json and carry no schema default', () => {
  for (const t of ['act', 'reset', 'observe']) {
    const p = tools[t].properties;
    assert.ok(p.frame.enum.includes('image'), t);
    assert.equal(p.image_scale.type, 'integer', t);
    assert.equal(p.image_scale.minimum, IMAGE_SPEC.scale.min, t);
    assert.equal(p.image_scale.maximum, IMAGE_SPEC.scale.max, t);
    assert.equal(p.image_grid.type, 'boolean', t);
    // validate() fills schema defaults, which would hide a stray option.
    assert.equal(p.image_scale.default, undefined, t);
    assert.equal(p.image_grid.default, undefined, t);
    // The defaults agents read are the ones the backend applies.
    assert.match(p.image_scale.description, new RegExp(`default ${IMAGE_SPEC.scale.default}\\b`), t);
    assert.match(p.image_grid.description, new RegExp(`default ${IMAGE_SPEC.grid.default}\\b`), t);
    assert.match(p.image_grid.description, new RegExp(`every ${IMAGE_SPEC.grid.every} cells`), t);
  }
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

test('animation options: enum and default on act and observe; the paging options carry no schema default', () => {
  for (const t of ['act', 'observe']) {
    const a = tools[t].properties.animation;
    assert.deepEqual(a.enum, ['last', 'all'], t);
    assert.equal(a.default, 'last', t);
    assert.match(a.description, new RegExp(`at most ${ANIMATION_PAGE_MAX} per call`), t);
  }
  assert.equal(tools.reset.properties.animation, undefined);
  for (const p of ['animation_step', 'animation_from']) {
    assert.equal(tools.observe.properties[p].type, 'integer', p);
    assert.equal(tools.observe.properties[p].minimum, 0, p);
    // validate() fills schema defaults, which would hide an option given without animation:'all'.
    assert.equal(tools.observe.properties[p].default, undefined, p);
  }
  assert.equal(tools.observe.properties.animation_step.maximum, SESSION_STEPS_MAX);
  assert.equal(tools.act.properties.animation_step, undefined);
});

test('image_scale descriptions state the contact-sheet default and cap from src/board_image.json', () => {
  for (const t of ['act', 'observe']) {
    const d = tools[t].properties.image_scale.description;
    assert.match(d, new RegExp(`default ${IMAGE_SPEC.sheet.scale_default}, capped at ${IMAGE_SPEC.sheet.scale_max}\\b`), t);
    assert.match(d, new RegExp(`render at ${IMAGE_SPEC.sheet.scale_max}\\b`), t);
  }
});

test('ANIMATION_FRAMES_MAX equals the sidecar engine value', async () => {
  const py = await fs.readFile(path.join(ROOT, 'sidecar', 'engine.py'), 'utf8');
  assert.equal(Number(/^ANIMATION_FRAMES_MAX = (\d+)$/m.exec(py)?.[1]), ANIMATION_FRAMES_MAX);
});
