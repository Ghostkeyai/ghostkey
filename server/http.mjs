// Alat bantu HTTP kecil: router, baca JSON, kirim JSON, batas laju.
export class Router {
  constructor() { this.routes = []; }
  add(method, pattern, handler) {
    // '/api/ledger/:hour' → regex dengan grup bernama
    const re = new RegExp('^' + pattern.replace(/:([a-zA-Z]+)/g, '(?<$1>[^/]+)') + '/?$');
    this.routes.push({ method, re, handler });
  }
  get(p, h) { this.add('GET', p, h); }
  post(p, h) { this.add('POST', p, h); }
  match(method, path) {
    for (const r of this.routes) {
      if (r.method !== method) continue;
      const m = path.match(r.re);
      if (m) return { handler: r.handler, params: m.groups || {} };
    }
    return null;
  }
}

export function sendJson(res, status, obj, headers = {}) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers });
  res.end(body);
}

export async function readJson(req, limit = 2_000_000) {
  let size = 0; const chunks = [];
  for await (const c of req) {
    size += c.length;
    if (size > limit) { const e = new Error('too_large'); e.status = 413; throw e; }
    chunks.push(c);
  }
  if (!chunks.length) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { const e = new Error('bad_json'); e.status = 400; throw e; }
}

export function clientIp(req) {
  // Di VPS di belakang Caddy: ambil entri X-Forwarded-For TERAKHIR (ditulis Caddy, tak bisa dipalsukan klien).
  // Hanya dipercaya bila koneksi datang dari localhost (Caddy).
  const xf = req.headers['x-forwarded-for'];
  const dari = req.socket.remoteAddress || '';
  const lokal = dari === '127.0.0.1' || dari === '::1' || dari === '::ffff:127.0.0.1';
  return (xf && lokal ? String(xf).split(',').pop() : dari).trim();
}

// Batas laju sederhana di memori: maks n permintaan per jendela waktu per kunci.
const buckets = new Map();
export function rateLimit(key, n, windowMs) {
  const t = Date.now();
  let b = buckets.get(key);
  if (!b || t - b.start > windowMs) { b = { start: t, count: 0 }; buckets.set(key, b); }
  b.count++;
  if (buckets.size > 50_000) buckets.clear();
  return b.count <= n;
}

export function sseStart(res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-store',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
}
export const sseData = (res, obj) => res.write(`data: ${typeof obj === 'string' ? obj : JSON.stringify(obj)}\n\n`);
export const sseEvent = (res, ev, obj) => res.write(`event: ${ev}\ndata: ${JSON.stringify(obj)}\n\n`);
