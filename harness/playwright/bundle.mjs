// Visual check of the offline bundle in the viewer, on the fake toolkit:
//   bundle-ready.png     a verified bundle: the header names it as the
//                        toolkit and local-game source; a local game plays
//   bundle-rejected.png  a tampered bundle: the "Bundle rejected" banner with
//                        the detail and the fix
// Fails on any page error or CSP violation.
// Run: node harness/playwright/bundle.mjs
import { appendFile, mkdir, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { BROWSER } from './resolve.mjs';
import { mcp, REPO } from './boot.mjs';
import { makeBundleDir } from '../../tests/_bundle.mjs';

const { bootServer, withPage } = await import(BROWSER);
const OUT = path.join(path.dirname(fileURLToPath(import.meta.url)), 'out');
await mkdir(OUT, { recursive: true });
const tmp = await mkdtemp(path.join(os.tmpdir(), 'code-arc-bundle-shot-'));

const boot = (bundleDir) => bootServer({
  cwd: REPO,
  entry: 'server.js',
  silent: true,
  sandbox: { dirs: { CONDUCTOR_PLUGIN_DATA_DIR: 'data', PROJECTS_ROOT: 'root' } },
  env: { CODE_ARC_PYTHON: 'python3', CODE_ARC_TEST_TOOLKIT_DIR: path.join(REPO, 'sidecar', 'tests', 'fakes'), CODE_ARC_BUNDLE: bundleDir },
});

async function shoot(url, name, check) {
  const problems = [];
  await withPage(async (page) => {
    page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
    page.on('console', (m) => {
      const t = m.text();
      if (/pluginBridge\.js|pluginTheme\.css/.test(t)) return;
      if (/Content Security Policy|Refused to/i.test(t)) problems.push(`csp: ${t}`);
    });
    await page.goto(url);
    await page.getByRole('heading', { name: 'Code ARC', level: 1 }).waitFor();
    await check(page);
    await page.screenshot({ path: path.join(OUT, name), fullPage: true });
  });
  if (problems.length) throw new Error(`${name}: ${problems.join('; ')}`);
}

try {
  const good = await makeBundleDir(path.join(tmp, 'good'));
  const srv = await boot(good.dir);
  try {
    const start = await mcp(srv.url, 'start_session', { game_id: 'fake-maze' });
    if (!start.meta) throw new Error(`start_session failed: ${JSON.stringify(start)}`);
    await mcp(srv.url, 'act', { session_id: start.meta.session_id, action: 'ACTION4', reasoning: 'Playing a bundled game with no download.' });
    await shoot(srv.url, 'bundle-ready.png', async (page) => {
      const label = page.locator('#toolkit-source');
      await page.waitForFunction(() => document.getElementById('toolkit-source').textContent.includes('bundle'));
      const text = await label.textContent();
      const want = `Toolkit and local games: bundle ${good.id.slice(0, 12)} (2 games)`;
      if (text !== want) throw new Error(`source label: ${JSON.stringify(text)}, want ${JSON.stringify(want)}`);
      await page.getByRole('button', { name: /Fake Maze/ }).click();
      await page.locator('#grid[data-drawn="true"]').waitFor();
    });
  } finally {
    await srv.close();
  }

  const bad = await makeBundleDir(path.join(tmp, 'tampered'));
  await appendFile(path.join(bad.dir, 'games', 'fake', 'maze', 'fake.py'), 'import os  # tampered\n');
  const rej = await boot(bad.dir);
  try {
    await shoot(rej.url, 'bundle-rejected.png', async (page) => {
      await page.locator('#toolkit-banner', { hasText: 'Bundle rejected' }).waitFor();
      const banner = await page.locator('#toolkit-banner').textContent();
      if (!/Fix: re-import/.test(banner)) throw new Error(`banner lacks the fix: ${banner}`);
    });
  } finally {
    await rej.close();
  }
  console.log(`wrote ${path.join(OUT, 'bundle-ready.png')} and bundle-rejected.png`);
} finally {
  await rm(tmp, { recursive: true, force: true });
}
