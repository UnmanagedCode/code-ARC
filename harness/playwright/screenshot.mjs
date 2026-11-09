// Drives the viewer's golden path and writes screenshots to ./out/:
//   viewer.png         a seeded session, frame drawn, reasoning shown
//   scrub.png          step 1 selected in the log
//   settings-409.png   key change refused while sessions are live
//   settings.png       key saved, shown masked
//   evil.png           a hostile game title rendered as text
//   closed.png         an online session whose scorecard was closed
//   no-reset.png       a default (one-run) session after GAME_OVER: header fact `Resets: none (one run)`, no list badge
//   resets.png         a session with max_resets 2: `Resets 0/2` list badge and `Resets: 0/2 used` header fact
//   deeplink.png       ?session=&step= routing
//   dark.png           OS dark theme (standalone fallback tokens)
//   banner.png         toolkit banner for a diverged venv, with its fix
//   many.png           250 stored sessions: first page plus Load older
//   script.png         scripted runs: run headers with notes, script badges (also one run-less script step, no header)
//   script-burst.png   after a live 300-step script burst, caught up with Jump to latest
//   paced-behind.png   mid-burst in Live: the shown step lags, "N steps behind" and Jump to latest
//   replay.png         Replay playing through the maze session
//   anim-auto.png      a two-frame step opened at a 2000 ms interval: frame 0, no animation buttons
//   anim-end.png       the same step after it played once: held on the last frame
//   anim-live.png      a live arrival animating from its first frame
//   anim-single.png    the START step: no animation line
//   anim-gap.png       a 70-frame step: only 64 stored, the not-stored note
//   interval-slider.png the interval slider row at its minimum, showing its value
//   human-newgame.png  the New game panel: Fake Maze picked, Resets allowed set to 2
//   human-live.png     a started human session: enabled action buttons, End, Reset hidden until a move is made (then shown); the human badge
//   human-click.png    ArrowRight then a click on cell (10,20): both steps logged as human
//   human-replay.png   Replay: play controls disabled with the hint, a key press sends nothing
//   human-over.png     a one-run game after GAME_OVER: actions disabled, no Reset
//   human-reset-used.png a human game with max_resets 1 after its one reset and a move: `Resets: 1/1 used`, Reset hidden
//   human-refused.png  Start refused at the live-session cap, the message shown
// Fails on any page error, CSP violation or dialog (an XSS alert).
// Run: node harness/playwright/screenshot.mjs
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { BROWSER } from './resolve.mjs';
import { bootArc, bootDiverged, bootSeeded, mcp, sessionId } from './boot.mjs';
import { MAX_LIVE_SESSIONS, SSE_MAX_CLIENTS } from '../../src/limits.js';
import { INTERVAL_MAX_MS, INTERVAL_MIN_MS, INTERVAL_STEP_MS } from '../../frontend/playback.js';

const { withPage } = await import(BROWSER);
const OUT = path.join(path.dirname(fileURLToPath(import.meta.url)), 'out');
await mkdir(OUT, { recursive: true });
const shot = (page, name) => page.screenshot({ path: path.join(OUT, name), fullPage: true });

const srv = await bootArc();
const problems = [];
try {
  const maze = sessionId(await mcp(srv.url, 'start_session', { game_id: 'fake-maze', max_resets: 2 }));
  const moves = [
    ['ACTION4', 'Probing: ACTION4 probably moves the blue player right.'],
    ['ACTION4', 'Confirmed ACTION4 = right. The green cell at x=5 looks like a goal.'],
    ['ACTION6', 'Testing the click action on (10,20) to see what it paints.', 10, 20],
    ['ACTION2', 'ACTION2 should be down; checking before heading to the goal.'],
  ];
  for (const [action, reasoning, x, y] of moves) {
    await mcp(srv.url, 'act', { session_id: maze, action, reasoning, ...(x !== undefined ? { x, y } : {}) });
  }
  const evil = sessionId(await mcp(srv.url, 'start_session', { game_id: 'fake-evil' }, { sessionId: null, project: null }));
  await mcp(srv.url, 'act', { session_id: evil, action: 'ACTION6', x: 3, y: 3, reasoning: '<img src=x onerror=alert(2)> literal text' }, { sessionId: null, project: null });
  const closed = sessionId(await mcp(srv.url, 'start_session', { game_id: 'fake-closed', online: true }));
  const closedAct = await mcp(srv.url, 'act', { session_id: closed, action: 'ACTION1' });
  if (closedAct.code !== 'SCORECARD_CLOSED') throw new Error(`expected SCORECARD_CLOSED, got ${JSON.stringify(closedAct)}`);
  const lose = sessionId(await mcp(srv.url, 'start_session', { game_id: 'fake-lose' }));
  const over = await mcp(srv.url, 'act', { session_id: lose, action: 'ACTION3', reasoning: 'One run: trying left.' });
  if (!over.text?.includes('state GAME_OVER')) throw new Error(`expected GAME_OVER, got ${JSON.stringify(over)}`);

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

    // Default (one-run) session: fact in the header, no badge in its list entry.
    await page.getByRole('button', { name: /Fake Lose/ }).click();
    await page.locator('.fact', { hasText: 'Resets: none (one run)' }).waitFor();
    if (await page.getByRole('button', { name: /Fake Lose/ }).locator('.badge.resets').count()) problems.push('one-run session shows a Resets badge');
    await page.locator('#steplog button', { hasText: 'ACTION3' }).waitFor();
    await shot(page, 'no-reset.png');

    // Resettable session: badge in the list, fact in the header.
    await page.getByRole('button', { name: /Fake Maze/ }).click();
    await page.locator('.fact', { hasText: 'Resets: 0/2 used' }).waitFor();
    await page.getByRole('button', { name: /Fake Maze/ }).locator('.badge.resets', { hasText: 'Resets 0/2' }).waitFor();
    await shot(page, 'resets.png');

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

// Scripted play: json-format calls (a run_code program's), a hostile note, two
// runs, then a live 300-step burst (raised step rate) while the viewer follows.
const fast = await bootArc({ entry: 'harness/playwright/server.mjs' });
try {
  const sid = (await mcp(fast.url, 'start_session', { game_id: 'fake-maze' }, undefined, 'json')).structured.session_id;
  const play = async (tool, args) => {
    const out = await mcp(fast.url, tool, { session_id: sid, ...args }, undefined, 'json');
    if (!out.structured) throw new Error(`script ${tool} refused: ${JSON.stringify(out)}`);
    return out.structured;
  };
  await mcp(fast.url, 'act', { session_id: sid, action: 'ACTION4', reasoning: 'Tool move before scripting.' });
  // A program's step before its first note: script badge, no run header.
  await play('act', { action: 'ACTION3', reasoning: 'Early step before any note.' });
  await play('note', { note: '<img src=x onerror=alert(3)> Sweep: try each direction and watch which cells move.' });
  for (const [i, action] of ['ACTION1', 'ACTION2', 'ACTION3', 'ACTION4', 'ACTION1'].entries()) await play('act', { action, reasoning: `sweep ${i + 1} of 5` });
  await play('note', { note: 'Phase two: ACTION2 moves down; head toward the lower goal.' });
  for (let i = 0; i < 3; i++) await play('act', { action: 'ACTION2' });

  await withPage(async (page) => {
    page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
    page.on('dialog', (d) => { problems.push(`dialog: ${d.message()}`); d.dismiss(); });
    await page.goto(`${fast.url}/?session=${sid}`);
    await page.locator('#steplog li').nth(10).waitFor();
    const headers = await page.locator('.run-header').allTextContents();
    if (headers.length !== 2) problems.push(`expected 2 run headers, got ${JSON.stringify(headers)}`);
    if (!headers[0]?.startsWith('Script run 1 — <img src=x onerror=alert(3)> Sweep')) problems.push(`run 1 header: ${headers[0]}`);
    if (!headers[1]?.startsWith('Script run 2 — Phase two')) problems.push(`run 2 header: ${headers[1]}`);
    if (await page.locator('img').count()) problems.push('an <img> element was injected');
    const badges = await page.locator('#steplog .badge.source-script').count();
    // START (a json start_session), the run-less step, then the eight steps of two runs.
    if (badges !== 10) problems.push(`expected 10 script badges, got ${badges}`);
    await page.waitForFunction(() => document.getElementById('reasoning').textContent.startsWith('Run 2 note: Phase two'));
    if (!(await page.locator('#step-summary').textContent()).includes('· script ·')) problems.push('step summary lacks the script source');
    await page.locator('#steplog').evaluate((e) => { e.scrollTop = 0; });
    await shot(page, 'script.png');

    // The run-less script step has its badge and no header.
    const early = page.locator('#steplog li', { hasText: '#2 ACTION3' }).first();
    if (await early.locator('.run-header').count()) problems.push('the run-less script step got a run header');
    if ((await early.locator('.badge.source-script').count()) !== 1) problems.push('the run-less script step lacks its badge');

    // A tool step shows as such.
    await page.getByRole('button', { name: /^#1 ACTION4/ }).click();
    await page.waitForFunction(() => document.getElementById('step-summary').textContent.includes('· tool ·'));
    if ((await page.locator('#reasoning').textContent()) !== 'Tool move before scripting.') problems.push('tool step reasoning');
    await page.locator('#mode-live').click();

    await play('note', { note: 'Burst: paint 300 cells to check the viewer keeps up.' });
    for (let i = 0; i < 300; i++) await play('act', { action: 'ACTION6', x: i % 64, y: 30 + Math.floor(i / 64), reasoning: `paint ${i + 1}` });
    await page.locator('#steplog li').nth(310).waitFor({ timeout: 10000 });
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
    await page.waitForFunction(() => document.getElementById('scrub-label').textContent === 'step 310 of 310', null, { timeout: 10000 });
    if ((await page.locator('#mode-live').getAttribute('aria-pressed')) !== 'true') problems.push('Live turned off by Jump to latest');
    if (!(await page.locator('#reasoning').textContent()).startsWith('Run 3 note: Burst')) problems.push('burst reasoning pane');
    const current = await page.locator('#steplog button[aria-current="true"]').textContent();
    if (!current.startsWith('#310')) problems.push(`current log row: ${current}`);
    await shot(page, 'script-burst.png');

    // Reconnect catch-up: fill the SSE client cap so the page's stream is
    // evicted, step while it is away, and expect only the missed steps fetched.
    const stepFetches = [];
    page.on('request', (r) => { const m = r.url().match(/\/steps\?from=(\d+)/); if (m) stepFetches.push(Number(m[1])); });
    const hogs = new AbortController();
    await Promise.all(Array.from({ length: SSE_MAX_CLIENTS }, () => fetch(`${fast.url}/api/events`, { signal: hogs.signal })));
    await page.locator('#interval').fill('100');
    for (let i = 0; i < 30; i++) await play('act', { action: 'ACTION6', x: i, y: 40, reasoning: `while away ${i + 1}` });
    await page.waitForFunction(() => document.getElementById('scrub-label').textContent === 'step 340 of 340', null, { timeout: 15000 });
    hogs.abort();
    const rows = await page.locator('#steplog .step-head').allTextContents();
    const ns = rows.map((t) => Number(t.match(/^#(\d+)/)[1]));
    if (ns.length !== 341 || ns.some((n, i) => n !== i)) problems.push(`log after reconnect is not #0..#340 once each (${ns.length} rows)`);
    if (!stepFetches.length || stepFetches.some((f) => f < 311)) problems.push(`reconnect fetched steps from ${JSON.stringify(stepFetches)}, expected only from 311`);
  }, { viewport: { width: 1280, height: 900 } });
} finally {
  await fast.close();
}

const animSrv = await bootArc();
try {
  const maze = sessionId(await mcp(animSrv.url, 'start_session', { game_id: 'fake-maze' }));
  await mcp(animSrv.url, 'act', { session_id: maze, action: 'ACTION4', reasoning: 'One move right: two frames.' });
  const long = sessionId(await mcp(animSrv.url, 'start_session', { game_id: 'fake-anim' }));
  await mcp(animSrv.url, 'act', { session_id: long, action: 'ACTION1', reasoning: 'A 70-frame animation.' });
  await withPage(async (page) => {
    page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
    page.on('response', (r) => { if (r.status() >= 400 && !/pluginBridge|pluginTheme/.test(r.url())) problems.push(`${r.status()} ${new URL(r.url()).pathname}`); });
    const label = () => page.locator('#anim-label').textContent();
    const canvas = () => page.evaluate(() => document.getElementById('grid').toDataURL());
    const slider = page.locator('#interval');
    await page.goto(animSrv.url);
    // The slider's grid is the playback constants; 2000 ms gives 1 s per frame on a two-frame step.
    for (const [attr, want] of [['min', INTERVAL_MIN_MS], ['max', INTERVAL_MAX_MS], ['step', INTERVAL_STEP_MS]]) {
      if ((await slider.getAttribute(attr)) !== String(want)) problems.push(`#interval ${attr} is not ${want}`);
    }
    await slider.fill('2000');
    await page.locator('#interval-value', { hasText: '2000 ms' }).waitFor();

    // Opening the session selects its newest step, which plays by itself, once.
    await page.getByRole('button', { name: /Fake Maze/ }).click();
    await page.locator('#anim-label', { hasText: 'frame 0 of 2' }).waitFor();
    const first = await canvas();
    await shot(page, 'anim-auto.png');
    await page.locator('#anim-label', { hasText: 'frame 1 of 2' }).waitFor();
    if ((await canvas()) === first) problems.push('the animation did not change the canvas');
    await page.waitForTimeout(2500);
    if ((await label()) !== 'frame 1 of 2') problems.push(`animation looped or moved: ${await label()}`);
    await shot(page, 'anim-end.png');
    if (await page.getByRole('button', { name: /animation/i }).count()) problems.push('an animation button is still shown');

    // Selecting the shown step again replays it.
    await page.locator('#steplog button').nth(1).click();
    await page.locator('#anim-label', { hasText: 'frame 0 of 2' }).waitFor();

    // A live arrival plays from its first frame.
    await page.locator('#mode-live').click();
    await mcp(animSrv.url, 'act', { session_id: maze, action: 'ACTION4', reasoning: 'Live arrival.' });
    await page.locator('#scrub-label', { hasText: 'step 2 of 2' }).waitFor();
    await page.locator('#anim-label', { hasText: 'frame 0 of 2' }).waitFor();
    await shot(page, 'anim-live.png');

    // Replay Play advances onto an animated step and plays it.
    await page.locator('#steplog button').first().click();
    await page.locator('#scrub-label', { hasText: 'step 0 of 2' }).waitFor();
    await page.locator('#play').click();
    await page.locator('#scrub-label', { hasText: 'step 1 of 2' }).waitFor();
    await page.locator('#anim-label', { hasText: 'frame 0 of 2' }).waitFor();
    await page.locator('#play').click();

    await page.locator('#steplog button').first().click();
    await page.locator('#scrub-label', { hasText: 'step 0 of 2' }).waitFor();
    if (!(await page.locator('#anim').isHidden())) problems.push('animation line shown on a single-frame step');
    await shot(page, 'anim-single.png');

    await page.getByRole('button', { name: /Fake Anim/ }).click();
    await page.locator('#anim-note', { hasText: 'frames 63-68 not stored' }).waitFor();
    await shot(page, 'anim-gap.png');

    // The minimum interval still ends on the last frame: frames are dropped, not the end.
    await page.locator('#steplog button').first().click();
    await slider.fill('100');
    await page.locator('#interval-value', { hasText: '100 ms' }).waitFor();
    await page.locator('#steplog button').nth(1).click();
    await page.locator('#anim-label', { hasText: 'frame 69 of 70' }).waitFor({ timeout: 1500 });
    await slider.locator('xpath=ancestor::div[1]').screenshot({ path: path.join(OUT, 'interval-slider.png') });
  }, { viewport: { width: 1280, height: 900 } });
} finally {
  await animSrv.close();
}

// Human play: its own server, so the other scenarios' live sessions don't count toward the cap.
const humanSrv = await bootArc();
try {
  await withPage(async (page) => {
    page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
    page.on('dialog', (d) => { problems.push(`dialog: ${d.message()}`); d.dismiss(); });
    page.on('console', (m) => { if (/Content Security Policy|Refused to/i.test(m.text()) && !/pluginBridge|pluginTheme/.test(m.text())) problems.push(`csp: ${m.text()}`); });
    // 409 (the cap refusal) is expected below.
    page.on('response', (r) => { if (r.status() >= 400 && r.status() !== 409 && !/pluginBridge|pluginTheme/.test(r.url())) problems.push(`${r.status()} ${new URL(r.url()).pathname}`); });
    const logRows = () => page.locator('#steplog .step-head').allTextContents();
    const startGame = async (game, max) => {
      await page.locator('#newgame-toggle').click();
      await page.locator(`#newgame-game option[value="${game}"]`).waitFor({ state: 'attached' });
      await page.selectOption('#newgame-game', game);
      await page.locator('#newgame-resets').fill(String(max));
      return page.locator('#newgame-resets');
    };
    await page.goto(humanSrv.url);
    await startGame('fake-maze', 2);
    await shot(page, 'human-newgame.png');
    await page.getByRole('button', { name: 'Start', exact: true }).click();
    await page.locator('#playbar:not([hidden])').waitFor();
    await page.locator('#session-list .badge.owner-human').waitFor();
    await page.locator('#steplog .step-head', { hasText: 'START' }).waitFor();
    if (await page.locator('#playbar button[data-action="ACTION4"]').isDisabled()) problems.push('ACTION4 is disabled on a live human session');
    if (await page.locator('#playbar button[data-action="RESET"]').isVisible()) problems.push('Reset is shown before any move on the level');
    await shot(page, 'human-live.png');

    await page.keyboard.press('ArrowRight');
    await page.locator('#steplog .step-head', { hasText: /^#1 ACTION4/ }).waitFor();
    if (!(await page.locator('#playbar button[data-action="RESET"]').isVisible())) problems.push('Reset is not shown after a move on a session with resets left');
    // A frame click needs the shown step to be the latest: wait out the pacing.
    await page.locator('#behind').waitFor({ state: 'hidden' });
    await page.locator('#scrub-label', { hasText: 'step 1 of 1' }).waitFor();
    const box = await page.locator('#grid').boundingBox();
    await page.mouse.click(box.x + (10.5 / 64) * box.width, box.y + (20.5 / 64) * box.height);
    await page.locator('#steplog .step-head', { hasText: /^#2 ACTION6 \(10,20\)/ }).waitFor();
    const rows = await logRows();
    if (!/human/.test(rows[1]) || !/human/.test(rows[2])) problems.push(`human steps lack the human badge: ${JSON.stringify(rows)}`);
    await page.locator('#scrub-label', { hasText: 'step 2 of 2' }).waitFor();
    await page.locator('#behind').waitFor({ state: 'hidden' });
    await page.locator('#reasoning', { hasText: '(human move)' }).waitFor();
    await shot(page, 'human-click.png');

    await page.locator('#mode-replay').click();
    await page.locator('.play-hint', { hasText: 'Replay — switch to Live to play' }).waitFor();
    if (!(await page.locator('#playbar button[data-action="ACTION1"]').isDisabled())) problems.push('play controls are enabled in Replay');
    await page.keyboard.press('ArrowRight');
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
    await page.waitForTimeout(400);
    if ((await logRows()).length !== rows.length) problems.push('a key or click sent a step in Replay');
    await shot(page, 'human-replay.png');
    await page.locator('#mode-live').click();

    await startGame('fake-lose', 0);
    await page.getByRole('button', { name: 'Start', exact: true }).click();
    await page.locator('.game-title', { hasText: 'Fake Lose' }).waitFor();
    await page.locator('#playbar button[data-action="ACTION3"]:enabled').waitFor();
    await page.keyboard.press('ArrowLeft');
    await page.locator('.fact', { hasText: 'State: GAME_OVER' }).waitFor();
    for (const b of await page.locator('#playbar .play-actions button').all()) if (!(await b.isDisabled())) problems.push('an action is enabled after GAME_OVER');
    if (await page.locator('#playbar button[data-action="RESET"]').isVisible()) problems.push('Reset is shown on a one-run session');
    await shot(page, 'human-over.png');

    // One reset allowed: after it and a move, the fact reads 1/1 and Reset is gone.
    await startGame('fake-maze', 1);
    await page.getByRole('button', { name: 'Start', exact: true }).click();
    await page.locator('.fact', { hasText: 'Resets: 0/1 used' }).waitFor();
    await page.locator('#playbar button[data-action="ACTION4"]:enabled').waitFor();
    await page.keyboard.press('ArrowRight');
    await page.locator('#playbar button[data-action="RESET"]:visible').waitFor();
    await page.keyboard.press('r');
    await page.locator('.fact', { hasText: 'Resets: 1/1 used' }).waitFor();
    await page.locator('#steplog .step-head', { hasText: /^#2 reset/i }).waitFor();
    await page.locator('#behind').waitFor({ state: 'hidden' });
    await page.keyboard.press('ArrowRight');
    await page.locator('#steplog .step-head', { hasText: /^#3 ACTION4/ }).waitFor();
    if (await page.locator('#playbar button[data-action="RESET"]').isVisible()) problems.push('Reset is shown with the budget used up');
    await shot(page, 'human-reset-used.png');

    // The agent's session is watch-only.
    const agentId = sessionId(await mcp(humanSrv.url, 'start_session', { game_id: 'fake-maze' }));
    await page.locator('#session-list li', { hasText: 'Fake Maze' }).filter({ hasNot: page.locator('.owner-human') }).first().click();
    await page.locator('#steplog .step-head', { hasText: 'START' }).waitFor();
    if (!(await page.locator('#playbar').isHidden())) problems.push('the play bar is shown on an agent session');
    if (!agentId) problems.push('no agent session');

    // Fill the cap with agent sessions: Start is refused with the service's message.
    for (let i = 0; i < MAX_LIVE_SESSIONS; i++) {
      const r = await mcp(humanSrv.url, 'start_session', { game_id: 'fake-maze' });
      if (!r.text) break;
    }
    await startGame('fake-maze', 0);
    await page.getByRole('button', { name: 'Start', exact: true }).click();
    await page.locator('.newgame-message', { hasText: 'TOO_MANY_SESSIONS' }).waitFor();
    await shot(page, 'human-refused.png');
  }, { viewport: { width: 1280, height: 900 } });
} finally {
  await humanSrv.close();
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
