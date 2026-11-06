// Drives the viewer's golden path and writes screenshots to ./out/:
//   viewer.png         a seeded session, frame drawn, reasoning shown
//   scrub.png          step 1 selected in the log
//   settings-409.png   key change refused while sessions are live
//   settings.png       key saved, shown masked
//   evil.png           a hostile game title rendered as text
//   closed.png         an online session whose scorecard was closed
//   no-reset.png       a one-run session after GAME_OVER: list badge and header fact
//   deeplink.png       ?session=&step= routing
//   dark.png           OS dark theme (standalone fallback tokens)
//   banner.png         toolkit banner for a diverged venv, with its fix
//   many.png           250 stored sessions: first page plus Load older
//   script.png         scripted runs: run headers with notes, script badges
//   script-burst.png   after a live 300-step script burst, caught up with Jump to latest
//   paced-behind.png   mid-burst in Live: the shown step lags, "N steps behind" and Jump to latest
//   replay.png         Replay playing through the maze session
// Fails on any page error, CSP violation or dialog (an XSS alert).
// Run: node harness/playwright/screenshot.mjs
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { BROWSER } from './resolve.mjs';
import { bootArc, bootDiverged, bootSeeded, mcp } from './boot.mjs';
import { SSE_MAX_CLIENTS } from '../../src/limits.js';

const { withPage } = await import(BROWSER);
const OUT = path.join(path.dirname(fileURLToPath(import.meta.url)), 'out');
await mkdir(OUT, { recursive: true });
const shot = (page, name) => page.screenshot({ path: path.join(OUT, name), fullPage: true });

const srv = await bootArc();
const problems = [];
try {
  const maze = (await mcp(srv.url, 'start_session', { game_id: 'fake-maze' })).meta.session_id;
  const moves = [
    ['ACTION4', 'Probing: ACTION4 probably moves the blue player right.'],
    ['ACTION4', 'Confirmed ACTION4 = right. The green cell at x=5 looks like a goal.'],
    ['ACTION6', 'Testing the click action on (10,20) to see what it paints.', 10, 20],
    ['ACTION2', 'ACTION2 should be down; checking before heading to the goal.'],
  ];
  for (const [action, reasoning, x, y] of moves) {
    await mcp(srv.url, 'act', { session_id: maze, action, reasoning, ...(x !== undefined ? { x, y } : {}) });
  }
  const evil = (await mcp(srv.url, 'start_session', { game_id: 'fake-evil' }, { sessionId: null, project: null })).meta.session_id;
  await mcp(srv.url, 'act', { session_id: evil, action: 'ACTION6', x: 3, y: 3, reasoning: '<img src=x onerror=alert(2)> literal text' }, { sessionId: null, project: null });
  const closed = (await mcp(srv.url, 'start_session', { game_id: 'fake-closed', online: true })).meta.session_id;
  const closedAct = await mcp(srv.url, 'act', { session_id: closed, action: 'ACTION1' });
  if (closedAct.result?.code !== 'SCORECARD_CLOSED') throw new Error(`expected SCORECARD_CLOSED, got ${JSON.stringify(closedAct)}`);
  const lose = (await mcp(srv.url, 'start_session', { game_id: 'fake-lose', allow_reset: false })).meta.session_id;
  const over = await mcp(srv.url, 'act', { session_id: lose, action: 'ACTION3', reasoning: 'One run: trying left.' });
  if (over.meta?.state !== 'GAME_OVER') throw new Error(`expected GAME_OVER, got ${JSON.stringify(over)}`);

  await withPage(async (page) => {
    page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
    page.on('dialog', (d) => { problems.push(`dialog: ${d.message()}`); d.dismiss(); });
    page.on('console', (m) => {
      const t = m.text();
      // Standalone, the host URLs 404 as text/plain by design; nosniff refuses them.
      if (/pluginBridge\.js|pluginTheme\.css/.test(t)) return;
      if (/Content Security Policy|Refused to/i.test(t)) problems.push(`csp: ${t}`);
    });
    page.on('response', (r) => {
      const u = new URL(r.url());
      // 409 is the expected settings refusal below.
      if (r.status() >= 400 && r.status() !== 409 && !['/pluginBridge.js', '/pluginTheme.css'].includes(u.pathname)) problems.push(`${r.status()} ${u.pathname}`);
    });

    await page.goto(srv.url);
    await page.getByRole('heading', { name: 'Code ARC', level: 1 }).waitFor();
    await page.getByRole('button', { name: /Fake Maze/ }).click();
    await page.locator('#grid[data-drawn="true"]').waitFor();
    await page.locator('#steplog li').nth(4).waitFor();
    const reasoning = await page.locator('#reasoning').textContent();
    if (!reasoning.includes('ACTION2 should be down')) problems.push(`latest reasoning not shown: ${reasoning}`);
    await shot(page, 'viewer.png');

    // Live update while the page is open.
    const before = await page.locator('#steplog li').count();
    await mcp(srv.url, 'act', { session_id: maze, action: 'ACTION4', reasoning: 'Live: heading right toward the goal.' });
    await page.locator('#steplog li').nth(before).waitFor({ timeout: 5000 });
    await page.waitForFunction(() => document.getElementById('reasoning').textContent.includes('Live: heading right'));

    // Scrub to step 1: the frame must change.
    const latest = await page.evaluate(() => document.getElementById('grid').toDataURL());
    await page.getByRole('button', { name: /^#1 ACTION4/ }).click();
    await page.waitForFunction((l) => document.getElementById('grid').toDataURL() !== l, latest);
    if ((await page.locator('#mode-replay').getAttribute('aria-pressed')) !== 'true') problems.push('not in Replay after picking a log row');
    if (!new URL(page.url()).search.includes('step=1')) problems.push(`route not written: ${page.url()}`);
    await shot(page, 'scrub.png');

    // Replay: from the first step, Play shows every step once, in order, then stops.
    await page.locator('#steplog button').first().click();
    await page.waitForFunction(() => /^step 0 of/.test(document.getElementById('scrub-label').textContent));
    await page.locator('#play').click();
    const seen = [];
    let shotTaken = false;
    for (let k = 0; k < 400; k++) {
      const label = await page.locator('#scrub-label').textContent();
      const n = Number(label.match(/^step (\d+) of (\d+)/)[1]);
      const last = Number(label.match(/of (\d+)$/)[1]);
      if (seen.at(-1) !== n) seen.push(n);
      if (!shotTaken && n >= 2) { await shot(page, 'replay.png'); shotTaken = true; }
      if (n === last && (await page.locator('#play').getAttribute('aria-label')) === 'Play') break;
      await page.waitForTimeout(50);
    }
    if (seen.length < 3 || seen.some((n, i) => n !== i)) problems.push(`replay did not step 0,1,2,... once each: ${JSON.stringify(seen)}`);
    if ((await page.locator('#play').getAttribute('aria-label')) !== 'Play') problems.push('Play did not return at the end of the replay');
    await page.locator('#mode-live').click();
    await page.waitForFunction(() => document.getElementById('mode-live').getAttribute('aria-pressed') === 'true');
    await page.waitForFunction((n) => document.getElementById('scrub-label').textContent === `step ${n} of ${n}`, seen.at(-1));
    if (new URL(page.url()).search.includes('step=')) problems.push(`step still in the route after going Live: ${page.url()}`);

    // Settings: refused while sessions are live, then saved and masked.
    await page.getByRole('button', { name: 'Settings' }).click();
    await page.getByLabel('ARC API key').fill('harness-key-0123456789abcd');
    await page.getByRole('button', { name: 'Save' }).click();
    await page.getByText('end the live game sessions before changing the API key').waitFor();
    await shot(page, 'settings-409.png');
    await mcp(srv.url, 'end_session', { session_id: maze });
    await mcp(srv.url, 'end_session', { session_id: evil }, { sessionId: null, project: null });
    await mcp(srv.url, 'end_session', { session_id: lose });
    await page.getByLabel('ARC API key').fill('harness-key-0123456789abcd');
    await page.getByRole('button', { name: 'Save' }).click();
    await page.getByText('Key set: ••••abcd').waitFor();
    if ((await page.content()).includes('harness-key-0123456789abcd')) problems.push('full key present in the DOM');
    await shot(page, 'settings.png');
    await page.getByRole('button', { name: 'Settings' }).click();

    // Hostile title and reasoning render as text.
    await page.getByRole('button', { name: /Evil/ }).click();
    await page.locator('.game-title', { hasText: 'Evil <img src=x onerror=alert(1)>' }).waitFor();
    await page.waitForFunction(() => document.getElementById('reasoning').textContent.includes('<img src=x onerror=alert(2)>'));
    if (await page.locator('img').count()) problems.push('an <img> element was injected');
    await shot(page, 'evil.png');

    // Online session whose scorecard closed.
    await page.getByRole('button', { name: /Fake Closed/ }).click();
    await page.getByText('Scorecard auto-closed by arcprize.org (15 min idle)').waitFor();
    const link = page.getByRole('link', { name: 'Scorecard on arcprize.org' });
    if ((await link.getAttribute('rel')) !== 'noopener noreferrer') problems.push('scorecard link rel');
    if (!(await link.getAttribute('href')).startsWith('https://arcprize.org/scorecards/')) problems.push('scorecard link href');
    await shot(page, 'closed.png');

    // One-run session: badge in the list, fact in the header.
    await page.getByRole('button', { name: /Fake Lose/ }).click();
    await page.locator('.fact', { hasText: 'Resets: off (one run)' }).waitFor();
    await page.locator('.badge.no-reset', { hasText: 'No reset' }).first().waitFor();
    await page.locator('#steplog button', { hasText: 'ACTION3' }).waitFor();
    await shot(page, 'no-reset.png');

    // Deep link to a step.
    await page.goto(`${srv.url}/?session=${maze}&step=3`);
    await page.locator('#steplog button[aria-current="true"]', { hasText: '#3 ACTION6 (10,20)' }).waitFor();
    await shot(page, 'deeplink.png');

    await page.emulateMedia({ colorScheme: 'dark' });
    await page.goto(`${srv.url}/?session=${maze}`);
    await page.locator('#grid[data-drawn="true"]').waitFor();
    await shot(page, 'dark.png');
  }, { viewport: { width: 1280, height: 900 } });
} finally {
  await srv.close();
}

// Scripted play: attach over HTTP with a hostile note, two runs, then a live
// 300-step burst (raised step rate) while the viewer follows.
const fast = await bootArc({ entry: 'harness/playwright/server.mjs' });
try {
  const start = await mcp(fast.url, 'start_session', { game_id: 'fake-maze' });
  const sid = start.meta.session_id;
  const { base_url: base, token } = start.meta.script;
  const play = async (op, body) => {
    const res = await fetch(`${base}${op}`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: JSON.stringify(body) });
    const out = await res.json();
    if (!out.ok) throw new Error(`script ${op} refused: ${JSON.stringify(out)}`);
    return out;
  };
  await mcp(fast.url, 'act', { session_id: sid, action: 'ACTION4', reasoning: 'Tool move before scripting.' });
  let { run } = await play('attach', { note: '<img src=x onerror=alert(3)> Sweep: try each direction and watch which cells move.' });
  for (const [i, action] of ['ACTION1', 'ACTION2', 'ACTION3', 'ACTION4', 'ACTION1'].entries()) await play('act', { run, action, reasoning: `sweep ${i + 1} of 5` });
  ({ run } = await play('note', { run, note: 'Phase two: ACTION2 moves down; head toward the lower goal.' }));
  for (let i = 0; i < 3; i++) await play('act', { run, action: 'ACTION2' });

  await withPage(async (page) => {
    page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
    page.on('dialog', (d) => { problems.push(`dialog: ${d.message()}`); d.dismiss(); });
    await page.goto(`${fast.url}/?session=${sid}`);
    await page.locator('#steplog li').nth(9).waitFor();
    const headers = await page.locator('.run-header').allTextContents();
    if (headers.length !== 2) problems.push(`expected 2 run headers, got ${JSON.stringify(headers)}`);
    if (!headers[0]?.startsWith('Script run 1 — <img src=x onerror=alert(3)> Sweep')) problems.push(`run 1 header: ${headers[0]}`);
    if (!headers[1]?.startsWith('Script run 2 — Phase two')) problems.push(`run 2 header: ${headers[1]}`);
    if (await page.locator('img').count()) problems.push('an <img> element was injected');
    const badges = await page.locator('#steplog .badge.source-script').count();
    if (badges !== 8) problems.push(`expected 8 script badges, got ${badges}`);
    await page.waitForFunction(() => document.getElementById('reasoning').textContent.startsWith('Run 2 note: Phase two'));
    if (!(await page.locator('#step-summary').textContent()).includes('· script ·')) problems.push('step summary lacks the script source');
    await page.locator('#steplog').evaluate((e) => { e.scrollTop = 0; });
    await shot(page, 'script.png');

    // A tool step shows as such.
    await page.getByRole('button', { name: /^#1 ACTION4/ }).click();
    await page.waitForFunction(() => document.getElementById('step-summary').textContent.includes('· tool ·'));
    if ((await page.locator('#reasoning').textContent()) !== 'Tool move before scripting.') problems.push('tool step reasoning');
    await page.locator('#mode-live').click();

    ({ run } = await play('note', { run, note: 'Burst: paint 300 cells to check the viewer keeps up.' }));
    for (let i = 0; i < 300; i++) await play('act', { run, action: 'ACTION6', x: i % 64, y: 30 + Math.floor(i / 64), reasoning: `paint ${i + 1}` });
    await page.locator('#steplog li').nth(309).waitFor({ timeout: 10000 });
    // Paced: the shown step lags the newest, and advances one step per interval.
    await page.locator('#behind').waitFor();
    const behind = Number((await page.locator('#behind').textContent()).match(/^(\d+)/)[1]);
    if (!(behind > 0)) problems.push('no steps behind after the burst');
    await shot(page, 'paced-behind.png');
    const nOf = async () => Number((await page.locator('#scrub-label').textContent()).match(/^step (\d+)/)[1]);
    const n0 = await nOf();
    await page.waitForFunction((n) => Number(document.getElementById('scrub-label').textContent.match(/^step (\d+)/)[1]) !== n, n0, { timeout: 5000 });
    const n1 = await nOf();
    if (n1 !== n0 + 1) problems.push(`paced live skipped steps: ${n0} -> ${n1}`);
    await page.locator('#latest').click();
    await page.waitForFunction(() => document.getElementById('scrub-label').textContent === 'step 309 of 309', null, { timeout: 10000 });
    if ((await page.locator('#mode-live').getAttribute('aria-pressed')) !== 'true') problems.push('Live turned off by Jump to latest');
    if (!(await page.locator('#reasoning').textContent()).startsWith('Run 3 note: Burst')) problems.push('burst reasoning pane');
    const current = await page.locator('#steplog button[aria-current="true"]').textContent();
    if (!current.startsWith('#309')) problems.push(`current log row: ${current}`);
    await shot(page, 'script-burst.png');

    // Reconnect catch-up: fill the SSE client cap so the page's stream is
    // evicted, step while it is away, and expect only the missed steps fetched.
    const stepFetches = [];
    page.on('request', (r) => { const m = r.url().match(/\/steps\?from=(\d+)/); if (m) stepFetches.push(Number(m[1])); });
    const hogs = new AbortController();
    await Promise.all(Array.from({ length: SSE_MAX_CLIENTS }, () => fetch(`${fast.url}/api/events`, { signal: hogs.signal })));
    await page.locator('#interval').selectOption('100');
    for (let i = 0; i < 30; i++) await play('act', { run, action: 'ACTION6', x: i, y: 40, reasoning: `while away ${i + 1}` });
    await page.waitForFunction(() => document.getElementById('scrub-label').textContent === 'step 339 of 339', null, { timeout: 15000 });
    hogs.abort();
    const rows = await page.locator('#steplog .step-head').allTextContents();
    const ns = rows.map((t) => Number(t.match(/^#(\d+)/)[1]));
    if (ns.length !== 340 || ns.some((n, i) => n !== i)) problems.push(`log after reconnect is not #0..#339 once each (${ns.length} rows)`);
    if (!stepFetches.length || stepFetches.some((f) => f < 310)) problems.push(`reconnect fetched steps from ${JSON.stringify(stepFetches)}, expected only from 310`);
  }, { viewport: { width: 1280, height: 900 } });
} finally {
  await fast.close();
}

const diverged = await bootDiverged();
try {
  await withPage(async (page) => {
    page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
    await page.goto(diverged.url);
    await page.locator('#toolkit-banner:not([hidden])').waitFor();
    await page.getByText(/^Fix: in this worktree: `rm \.venv`/).waitFor();
    await page.screenshot({ path: path.join(OUT, 'banner.png') });
  }, { viewport: { width: 1100, height: 420 } });
} finally {
  await diverged.close();
}

const seeded = await bootSeeded(250);
try {
  await withPage(async (page) => {
    page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
    await page.goto(seeded.url);
    await page.locator('#session-list li').nth(99).waitFor();
    if ((await page.locator('#session-list li').count()) !== 100) problems.push('first page is not 100 sessions');
    await page.getByRole('button', { name: 'Load older sessions (150 more)' }).click();
    await page.locator('#session-list li').nth(199).waitFor();
    await page.getByRole('button', { name: 'Load older sessions (50 more)' }).waitFor();
    // A deep link to a session beyond the loaded pages.
    await page.goto(`${seeded.url}/?session=s-000000000005`);
    await page.locator('.game-title', { hasText: 'Old game 5' }).waitFor();
    await page.goto(seeded.url);
    await page.getByRole('button', { name: 'Load older sessions (150 more)' }).click();
    await page.locator('#session-list li').nth(199).waitFor();
    await page.screenshot({ path: path.join(OUT, 'many.png') });
  }, { viewport: { width: 1280, height: 900 } });
} finally {
  await seeded.close();
}

if (problems.length) {
  console.error(`FAILED:\n${problems.join('\n')}`);
  process.exit(1);
}
console.log(`ok: screenshots in ${OUT}`);
