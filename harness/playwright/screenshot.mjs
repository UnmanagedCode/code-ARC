// Drives the viewer's golden path and writes screenshots to ./out/:
//   viewer.png         a seeded session, frame drawn, reasoning shown
//   scrub.png          step 1 selected in the log
//   settings-409.png   key change refused while sessions are live
//   settings.png       key saved, shown masked
//   evil.png           a hostile game title rendered as text
//   closed.png         an online session whose scorecard was closed
//   deeplink.png       ?session=&step= routing
//   dark.png           OS dark theme (standalone fallback tokens)
//   banner.png         toolkit banner for a diverged venv, with its fix
//   many.png           250 stored sessions: first page plus Load older
// Fails on any page error, CSP violation or dialog (an XSS alert).
// Run: node harness/playwright/screenshot.mjs
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { BROWSER } from './resolve.mjs';
import { bootArc, bootDiverged, bootSeeded, mcp } from './boot.mjs';

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
    if (await page.locator('#follow').isChecked()) problems.push('follow live still on after scrubbing back');
    if (!new URL(page.url()).search.includes('step=1')) problems.push(`route not written: ${page.url()}`);
    await shot(page, 'scrub.png');

    // Settings: refused while sessions are live, then saved and masked.
    await page.getByRole('button', { name: 'Settings' }).click();
    await page.getByLabel('ARC API key').fill('harness-key-0123456789abcd');
    await page.getByRole('button', { name: 'Save' }).click();
    await page.getByText('end the live game sessions before changing the API key').waitFor();
    await shot(page, 'settings-409.png');
    await mcp(srv.url, 'end_session', { session_id: maze });
    await mcp(srv.url, 'end_session', { session_id: evil }, { sessionId: null, project: null });
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
