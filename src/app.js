// Wires the backend together and returns {server, close()}. Every collaborator
// with side effects (clock, timers, spawn, fetch, log) is injectable for tests.
import http from 'node:http';
import path from 'node:path';
import { spawn as nodeSpawn } from 'node:child_process';
import { createBootstrap } from './bootstrap.js';
import { createKeyStore } from './keyStore.js';
import { createMcp } from './mcp.js';
import { createSessions } from './sessions.js';
import { createSidecar } from './sidecar.js';
import { createSseHub } from './sse.js';
import { createStatic } from './static.js';
import { createStore } from './store.js';
import { createRouter, HttpError, onClientError, readJsonBody, SECURITY_HEADERS, sendJson } from './http.js';
import { SESSION_ID_RE, STEPS_PAGE_MAX } from './limits.js';

export async function createApp({
  config,
  clock = { now: Date.now },
  timers = { setInterval, clearInterval },
  spawn = nodeSpawn,
  fetch = globalThis.fetch,
  log = console,
  bootstrapTimeouts,
  sseKeepaliveMs,
  deadlines,
  onlineRpmLimit,
}) {
  const store = createStore({ dataDir: config.dataDir, log });
  await store.init();
  const keyStore = createKeyStore({ dataDir: config.dataDir });
  const hub = createSseHub({ headers: SECURITY_HEADERS, timers, ...(sseKeepaliveMs ? { keepaliveMs: sseKeepaliveMs } : {}) });

  const statusBody = () => ({ toolkit: bootstrap.status(), sidecar: sidecar.status() });
  const publishStatus = () => hub.publish('status', statusBody());

  const bootstrap = createBootstrap({
    checkoutDir: config.checkoutDir,
    pythonOverride: config.python,
    spawn,
    fetch,
    log,
    ...(bootstrapTimeouts ? { timeouts: bootstrapTimeouts } : {}),
    onChange: () => publishStatus(),
  });
  // Assigned below; the sidecar's exit hook reaches the sessions through it.
  let sessions = null;
  const sidecar = createSidecar({
    checkoutDir: config.checkoutDir,
    cwd: store.toolkitDir,
    python: bootstrap.python,
    testToolkitDir: config.testToolkitDir,
    getApiKey: () => keyStore.get(),
    spawn,
    log,
    onExit: ({ expected }) => { if (!expected) sessions?.onSidecarExit().catch((e) => log.error(`[code-arc] ending sessions after sidecar exit failed: ${e.message}`)); },
    onStatus: publishStatus,
  });
  sessions = createSessions({ store, sidecar, bootstrap, hub, clock, timers, log, ...(deadlines ? { deadlines } : {}), ...(onlineRpmLimit ? { onlineRpmLimit } : {}) });
  const mcp = createMcp({ sessions, log });
  const serveStatic = createStatic({ frontendDir: path.join(config.checkoutDir, 'frontend') });

  const sessionRoute = (suffix = '') => new RegExp(`^/api/sessions/(?<id>[^/]+)${suffix}$`);
  const sessionOr404 = (id) => {
    const meta = SESSION_ID_RE.test(id) ? store.get(id) : null;
    if (!meta) throw new HttpError(404, 'SESSION_UNKNOWN', 'no such session');
    return meta;
  };

  async function changeKey(res, apply) {
    const r = await sessions.changeKey(apply);
    if (!r.ok) throw new HttpError(409, r.code, r.reason);
    sendJson(res, 200, { apiKey: await keyStore.status() });
  }

  const routes = [
    ['GET', '/api/health', (req, res) => sendJson(res, 200, { ok: true })],
    ['GET', '/api/status', (req, res) => sendJson(res, 200, statusBody())],
    ['GET', '/api/sessions', (req, res) => sendJson(res, 200, { sessions: store.list() })],
    ['GET', sessionRoute(), (req, res, { params }) => sendJson(res, 200, sessionOr404(params.id))],
    ['GET', sessionRoute('/steps'), async (req, res, { params, url }) => {
      sessionOr404(params.id);
      const from = Math.max(0, Number.parseInt(url.searchParams.get('from') || '0', 10) || 0);
      const limit = Math.min(STEPS_PAGE_MAX, Math.max(1, Number.parseInt(url.searchParams.get('limit') || String(STEPS_PAGE_MAX), 10) || STEPS_PAGE_MAX));
      sendJson(res, 200, { steps: await store.readSteps(params.id, from, limit) });
    }],
    ['GET', '/api/events', (req, res) => hub.handle(req, res, [['status', statusBody()], ['sessions', store.list()]])],
    ['GET', '/api/settings', async (req, res) => sendJson(res, 200, { apiKey: await keyStore.status() })],
    ['PUT', '/api/settings/api-key', async (req, res) => {
      const body = await readJsonBody(req);
      await changeKey(res, async () => {
        try {
          await keyStore.set(body?.key);
        } catch (e) {
          if (e.code === 'INVALID_KEY') throw new HttpError(400, 'INVALID_KEY', e.message);
          throw e;
        }
      });
    }],
    ['DELETE', '/api/settings/api-key', async (req, res) => changeKey(res, () => keyStore.clear())],
    ['POST', '/api/mcp', async (req, res) => sendJson(res, 200, await mcp.handle(await readJsonBody(req)))],
  ];

  const server = http.createServer(createRouter({ routes, fallback: serveStatic, log }));
  server.on('clientError', onClientError);
  bootstrap.run();

  return {
    server,
    sessions,
    sidecar,
    bootstrap,
    store,
    mcp,
    async close() {
      sessions.close();
      await bootstrap.stop();
      sidecar.stop();
      hub.closeAll();
      const closed = new Promise((resolve) => server.close(() => resolve()));
      server.closeAllConnections();
      await closed;
      await store.flush();
    },
  };
}
