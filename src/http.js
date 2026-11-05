// Cross-cutting HTTP rules: the same security headers on every response,
// bounded JSON bodies, the cross-site guard for non-GET routes, and a router
// whose handlers can't take the process down.
import { BODY_MAX_BYTES } from './limits.js';

export const SECURITY_HEADERS = Object.freeze({
  'content-security-policy': "default-src 'none'; script-src 'self'; style-src 'self'; font-src 'self'; connect-src 'self'; frame-ancestors 'self'; base-uri 'none'; form-action 'none'",
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
});

export class HttpError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export function send(res, status, body, contentType = 'text/plain; charset=utf-8', extra = {}) {
  if (res.headersSent) {
    res.end();
    return;
  }
  res.writeHead(status, { ...SECURITY_HEADERS, 'content-type': contentType, 'cache-control': 'no-store', ...extra });
  res.end(body);
}

export const sendJson = (res, status, obj) => send(res, status, JSON.stringify(obj), 'application/json; charset=utf-8');

export function readJsonBody(req, maxBytes = BODY_MAX_BYTES) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let done = false;
    const fail = (err) => {
      if (done) return;
      done = true;
      reject(err);
    };
    req.on('error', (e) => fail(new HttpError(400, 'BAD_REQUEST', `request stream error: ${e.message}`)));
    req.on('data', (c) => {
      if (done) return;
      size += c.length;
      if (size > maxBytes) {
        fail(new HttpError(413, 'BODY_TOO_LARGE', `request body over ${maxBytes} bytes`));
        req.resume();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      if (done) return;
      done = true;
      const text = Buffer.concat(chunks).toString('utf8');
      try {
        resolve(text === '' ? {} : JSON.parse(text));
      } catch {
        reject(new HttpError(400, 'BAD_JSON', 'request body is not valid JSON'));
      }
    });
  });
}

// Non-GET requests must be same-origin JSON: a JSON content type (a form or a
// no-cors fetch can't send one), and no cross-site Sec-Fetch-Site; without
// that header, no Origin either.
export function crossSiteGuard(req) {
  const type = String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
  if (type !== 'application/json') return new HttpError(415, 'UNSUPPORTED_MEDIA_TYPE', 'content-type must be application/json');
  const site = req.headers['sec-fetch-site'];
  if (site !== undefined) {
    if (site !== 'same-origin' && site !== 'none') return new HttpError(403, 'CROSS_SITE', 'cross-site request refused');
  } else if (req.headers.origin !== undefined) {
    return new HttpError(403, 'CROSS_SITE', 'request with an Origin but no Sec-Fetch-Site refused');
  }
  return null;
}

// Routes: [method, pattern, handler]; pattern is a string path or a RegExp
// whose named groups become params. A handler gets (req, res, {params, url}).
export function createRouter({ routes, fallback, log = console }) {
  return async function handle(req, res) {
    req.on('error', () => {});
    res.on('error', () => {});
    req.socket?.on('error', () => {});
    try {
      const url = new URL(req.url, 'http://localhost');
      const pathname = url.pathname;
      let pathMatched = false;
      for (const [method, pattern, handler] of routes) {
        let params = null;
        if (typeof pattern === 'string') {
          if (pattern === pathname) params = {};
        } else {
          const m = pattern.exec(pathname);
          if (m) params = m.groups || {};
        }
        if (!params) continue;
        pathMatched = true;
        if (req.method !== method) continue;
        if (method !== 'GET') {
          const err = crossSiteGuard(req);
          if (err) throw err;
        }
        await handler(req, res, { params, url });
        return;
      }
      if (pathMatched) throw new HttpError(405, 'METHOD_NOT_ALLOWED', 'method not allowed');
      await fallback(req, res, { url });
    } catch (e) {
      if (e instanceof HttpError) {
        sendJson(res, e.status, { error: e.message, code: e.code });
      } else {
        log.error(`[code-arc] ${req.method} ${String(req.url).slice(0, 200)} failed: ${e.stack || e.message}`);
        sendJson(res, 500, { error: 'internal error', code: 'INTERNAL' });
      }
    }
  };
}

// A malformed request never reaches the router; answer it with the same headers.
export function onClientError(err, socket) {
  if (!socket.writable) {
    socket.destroy();
    return;
  }
  const head = Object.entries(SECURITY_HEADERS).map(([k, v]) => `${k}: ${v}\r\n`).join('');
  socket.end(`HTTP/1.1 400 Bad Request\r\n${head}content-type: text/plain; charset=utf-8\r\ncontent-length: 11\r\nconnection: close\r\n\r\nbad request`);
}
