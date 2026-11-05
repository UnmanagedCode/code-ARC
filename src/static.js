// Serves the frontend: an explicit allowlist of files, nothing else. The host
// URLs (/pluginBridge.js, /pluginTheme.css) are deliberately absent so they
// 404 standalone, as the plugin UI contract requires.
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { send } from './http.js';

const TYPES = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8' };
const FILES = ['index.html', 'app.css', 'app.js', 'api.js', 'grid.js', 'palette.js', 'sessions.js', 'steplog.js', 'settings.js', 'safeHref.js'];

export function createStatic({ frontendDir }) {
  const allowed = new Map(FILES.map((f) => [`/${f}`, f]));
  allowed.set('/', 'index.html');
  return async function serve(req, res, { url }) {
    const file = (req.method === 'GET' || req.method === 'HEAD') && allowed.get(url.pathname);
    if (!file) {
      send(res, 404, 'not found');
      return;
    }
    const body = await fs.readFile(path.join(frontendDir, file));
    send(res, 200, req.method === 'HEAD' ? undefined : body, TYPES[path.extname(file)], { 'cache-control': 'no-cache' });
  };
}
