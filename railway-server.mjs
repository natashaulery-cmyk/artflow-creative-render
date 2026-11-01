// Railway migration adapter. Do not deploy as production until staging is tested.
import { createServer } from 'node:http';
import { createReadStream, promises as fs } from 'node:fs';
import { timingSafeEqual } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url));
const dist = path.join(root, 'dist');
const apiDir = path.join(root, 'api');
const port = Number(process.env.PORT || 3000);
const maxBody = 25 * 1024 * 1024;
const streamRoutes = new Set(['inbound-orders', 'inbound-expenses', 'depop-webhook']);
const cronRoutes = new Set([
  'gmail-sales-cron', 'marketplace-orders-cron', 'yahoo-mail-cron',
  'gmail-expense-cron', 'poshmark-listing-cron',
]);
const mime = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.gif': 'image/gif', '.webp': 'image/webp', '.ico': 'image/x-icon',
  '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf',
  '.otf': 'font/otf', '.pdf': 'application/pdf',
  '.webmanifest': 'application/manifest+json', '.txt': 'text/plain; charset=utf-8',
};

function enhanceResponse(res) {
  res.status = function (code) { this.statusCode = code; return this; };
  res.json = function (data) {
    if (!this.headersSent) this.setHeader('Content-Type', 'application/json; charset=utf-8');
    return this.end(JSON.stringify(data));
  };
  res.send = function (data) {
    if (data && typeof data === 'object' && !Buffer.isBuffer(data)) return this.json(data);
    if (!this.hasHeader('Content-Type')) this.setHeader('Content-Type',
      Buffer.isBuffer(data) ? 'application/octet-stream' : 'text/html; charset=utf-8');
    return this.end(data == null ? '' : data);
  };
  res.redirect = function (codeOrLocation, location) {
    this.statusCode = typeof codeOrLocation === 'number' ? codeOrLocation : 302;
    this.setHeader('Location', String(typeof codeOrLocation === 'number' ? location : codeOrLocation));
    return this.end();
  };
  return res;
}

function queryObject(searchParams) {
  const out = {};
  for (const [key, value] of searchParams) {
    if (Object.prototype.hasOwnProperty.call(out, key)) {
      out[key] = Array.isArray(out[key]) ? [...out[key], value] : [out[key], value];
    } else out[key] = value;
  }
  return out;
}

async function parseBody(req) {
  const parts = [];
  let length = 0;
  for await (const part of req) {
    length += part.length;
    if (length > maxBody) {
      const err = new Error('Request body is too large');
      err.statusCode = 413;
      throw err;
    }
    parts.push(part);
  }
  const data = Buffer.concat(parts);
  const type = String(req.headers['content-type'] || '').toLowerCase();
  if (type.includes('application/json') || type.includes('+json')) {
    if (!data.length) return {};
    try { return JSON.parse(data.toString('utf8')); }
    catch {
      const err = new Error('Invalid JSON');
      err.statusCode = 400;
      throw err;
    }
  }
  if (type.includes('application/x-www-form-urlencoded')) {
    return queryObject(new URLSearchParams(data.toString('utf8')));
  }
  if (type.startsWith('text/')) return data.toString('utf8');
  return data;
}

function cronAuthorized(req) {
  const secret = String(process.env.CRON_SECRET || '');
  const presented = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  if (!secret || !presented) return false;
  const a = Buffer.from(secret);
  const b = Buffer.from(presented);
  return a.length === b.length && timingSafeEqual(a, b);
}

async function handleApi(req, res, route, url) {
  if (route === 'auth' || route.startsWith('auth/')) {
    const authPath = route === 'auth' ? '' : route.slice(5);
    const params = new URLSearchParams(url.search);
    params.set('__path', authPath);
    req.url = '/api/better-auth?' + params;
    req.query = queryObject(params);
    if (req.method !== 'GET' && ['sign-up/email', 'sign-in/email', 'login-form'].includes(authPath)) {
      req.body = await parseBody(req);
    }
    route = 'better-auth';
  } else {
    if (route.includes('/')) return res.status(404).json({ error: 'Not found' });
    // Do not use the old Vercel proxy after changing hosts.
    if (route === 'mobile-listing-proxy') route = 'mobile-listing-sync';
    if (!['GET', 'HEAD'].includes(req.method) && !streamRoutes.has(route)) {
      req.body = await parseBody(req);
    }
  }
  if (!/^[a-z][a-z0-9-]*$/.test(route)) return res.status(404).json({ error: 'Not found' });
  // No spoofing x-vercel-cron-schedule after switching providers.
  if (cronRoutes.has(route) && !cronAuthorized(req)) {
    return res.status(401).json({ error: 'Unauthorized scheduled job' });
  }
  const file = path.join(apiDir, route + '.mjs');
  try { await fs.access(file); }
  catch { return res.status(404).json({ error: 'Not found' }); }
  const module = await import(pathToFileURL(file).href);
  if (typeof module.default !== 'function') return res.status(404).json({ error: 'Not found' });
  return module.default(req, res);
}

async function serveStatic(req, res, urlPath) {
  if (!['GET', 'HEAD'].includes(req.method)) return res.status(405).json({ error: 'Method not allowed' });
  let decoded;
  try { decoded = decodeURIComponent(urlPath); }
  catch { return res.status(400).json({ error: 'Bad URL' }); }
  if (decoded.includes('\0') || decoded.includes('\\')) return res.status(400).json({ error: 'Bad path' });
  const base = path.resolve(dist);
  let file = path.resolve(base, '.' + decoded);
  if (file !== base && !file.startsWith(base + path.sep)) return res.status(404).json({ error: 'Not found' });
  let stat;
  try { stat = await fs.stat(file); } catch {}
  if (!stat?.isFile()) {
    if (path.extname(decoded)) return res.status(404).json({ error: 'Not found' });
    file = path.join(dist, 'index.html');
    try { stat = await fs.stat(file); }
    catch { return res.status(503).json({ error: 'Frontend build missing' }); }
  }
  res.setHeader('Content-Type', mime[path.extname(file).toLowerCase()] || 'application/octet-stream');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Length', stat.size);
  if (req.method === 'HEAD') return res.end();
  return new Promise((resolve) => {
    const stream = createReadStream(file);
    stream.on('error', (error) => {
      console.error('Static file error', error);
      if (!res.headersSent) res.status(500).json({ error: 'Static file error' });
      else res.destroy(error);
      resolve();
    });
    res.on('finish', resolve);
    stream.pipe(res);
  });
}

const server = createServer(async (req, response) => {
  const res = enhanceResponse(response);
  try {
    const url = new URL(req.url || '/', 'http://localhost');
    req.query = queryObject(url.searchParams);
    if (url.pathname === '/_health') return res.status(200).json({ ok: true });
    if (url.pathname === '/login') return handleApi(req, res, 'login-page', url);
    if (url.pathname.startsWith('/api/')) {
      const route = url.pathname.slice(5).replace(/\/$/, '');
      return handleApi(req, res, route, url);
    }
    return serveStatic(req, res, url.pathname);
  } catch (error) {
    console.error('Art Flow Railway request failed', error?.stack || error);
    if (!res.headersSent) return res.status(error.statusCode || 500).json({
      error: error.statusCode ? error.message : 'Internal server error',
    });
    res.destroy(error);
  }
});

server.listen(port, '0.0.0.0', () => {
  console.log('Art Flow Creative listening on 0.0.0.0:' + port);
});
