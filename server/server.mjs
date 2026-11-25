// Server GHOSTKEY: API + halaman statis web/. Jalankan: node server/server.mjs  (port bawaan 4877)
import http from 'node:http';
import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { join, extname, normalize } from 'node:path';
import { config, ROOT, microToUsd, usdToMicro } from './config.mjs';
import { q, schemaColumns } from './db.mjs';
import { Router, sendJson, readJson, clientIp, rateLimit } from './http.mjs';
import { makeNonce, verifySignIn, sessionCookie, accountFromSession, logout, normWallet,
  listApiKeys, createApiKey, revokeApiKey, accountFromBearer } from './auth.mjs';
import { getCatalog, modelInfo, publicModel } from './openrouter.mjs';
import { freeLeft, apiClientId, holderClientId, quoteCredit, creditDeposit, pruneDaily } from './billing.mjs';
import { runChatStream, runChatJson, cleanMessages, STORED } from './chat.mjs';
import { buildUpstream, redactForDisplay, STRIPPED, ZDR_LIST_URL, incomingNotSent, droppedFields, FORCED_PROVIDER } from './privacy.mjs';
import { ledgerList, ledgerHour, ledgerHourRaw, holderCredits, startCreditScheduler, runHour } from './credit.mjs';
import { startHarvester, harvesterReady } from './harvester.mjs';
import { configData, statsData, proofData } from './public.mjs';
import { codeUrl } from './config.mjs';

const r = new Router();
const needAuth = (req, res) => {
  const a = accountFromSession(req);
  if (!a) sendJson(res, 401, { error: 'sign_in' });
  return a;
};

// ---------- Info umum ----------
r.get('/api/config', async () => configData());
r.get('/api/models', async () => (await getCatalog()).list.map(publicModel));
r.get('/api/stats', async () => statsData());
r.get('/api/proof', async () => proofData());

// Inspector publik: tunjukkan persis badan yang AKAN dikirim ke OpenRouter. Tanpa login, gratis, tidak memanggil model.
r.post('/api/inspect', async (req) => {
  if (!rateLimit(`inspect:${clientIp(req)}`, 60, 60_000)) return [429, { error: 'slow_down' }];
  const b = await readJson(req, 2_000_000);
  const model = await modelInfo(b.model);
  if (!model) return [400, { error: 'bad_model', message: 'Unknown model, or the model has no zero-retention provider right now.' }];
  const messages = cleanMessages(b.messages);
  if (!messages) return [400, { error: 'bad_messages', message: 'Send messages like the OpenAI API: [{"role":"user","content":"..."}].' }];
  const maxTokens = Math.min(Math.max(64, Number(b.max_tokens || b.max_completion_tokens || b.maxTokens) || 4096), 32000);
  const up = buildUpstream({ modelId: model.id, messages, maxTokens, stream: !!b.stream, extra: b });
  return {
    wouldSend: redactForDisplay(up),
    stripped: STRIPPED,
    droppedFields: droppedFields(b),
    notSent: incomingNotSent(req),
    forcedProvider: FORCED_PROVIDER,
    zdrProviders: model.zdrProviders,
    zdrList: ZDR_LIST_URL,
    code: codeUrl('server/privacy.mjs'),
  };
});

// ---------- Ghost Credit ----------
r.get('/api/ledger', async (req, res, p, url) => ledgerList(url.searchParams.get('limit') || 48));
r.get('/api/ledger/:hour', async (req, res, p) => {
  const h = ledgerHour(p.hour);
  return h || [404, { error: 'not_found' }];
});
// Isi berkas jam persis per bita — keccak256(isi) = uriHash yang dikirim ke GhostLedger
r.get('/api/ledger/:hour/raw', async (req, res, p) => {
  const buf = ledgerHourRaw(p.hour);
  if (!buf) return [404, { error: 'not_found' }];
  res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'public, max-age=300',
    'Content-Disposition': `inline; filename="hour-${Number(p.hour)}.json"` });
  res.end(buf);
});

let ghostDecimals = null;
async function ghostBalance(wallet) {
  if (!config.ghostToken) return null;
  const { erc20Balance } = await import('./chain/pons.mjs');
  if (ghostDecimals == null) {
    const { Contract } = await import('ethers');
    const { provider } = await import('./chain/rpc.mjs');
    ghostDecimals = Number(await new Contract(config.ghostToken, ['function decimals() view returns (uint8)'], provider()).decimals());
  }
  const raw = await erc20Balance(config.ghostToken, wallet);
  return Number(raw / 10n ** BigInt(Math.max(0, ghostDecimals - 6))) / 1e6;   // token utuh, 6 desimal
}
const isExcludedWallet = (w) => [config.treasury, config.ownerWallet, ...config.teamWallets].some((a) => a && a.toLowerCase() === w);

// Pemegang $GHOST (≥ HOLDER_MIN_TOKENS, bukan dompet tim/pool) → jatah gratis harian + batas API lebih tinggi.
// Saldo dibaca on-chain lalu disimpan 5 menit per dompet; RPC gagal → dianggap bukan pemegang, dicoba lagi 30 detik kemudian.
const holderCache = new Map();
async function isHolder(account) {
  if (!account?.wallet || !config.ghostToken) return false;
  const w = account.wallet.toLowerCase();
  const c = holderCache.get(w);
  if (c && c.exp > Date.now()) return c.ok;
  let ok = false, ttl = 300_000;
  try { const g = await ghostBalance(w); ok = !isExcludedWallet(w) && g != null && g >= config.holderMinTokens; }
  catch { ttl = 30_000; }
  holderCache.set(w, { ok, exp: Date.now() + ttl });
  if (holderCache.size > 5000) holderCache.delete(holderCache.keys().next().value);
  return ok;
}

r.get('/api/holder/:wallet', async (req, res, p) => {
  const w = normWallet(p.wallet);
  if (!w) return [400, { error: 'bad_wallet' }];
  if (!rateLimit(`holder:${clientIp(req)}`, 30, 60_000)) return [429, { error: 'slow_down' }];
  let balanceNow = null, error;
  try { balanceNow = await ghostBalance(w); } catch { error = 'chain_unavailable'; }
  const credits = holderCredits(w);
  const excluded = isExcludedWallet(w);
  return {
    wallet: w,
    token: config.ghostToken || null,
    balanceNow,
    eligibleNow: balanceNow == null ? null : !excluded && balanceNow >= config.holderMinTokens,
    excluded,
    minTokens: config.holderMinTokens,
    totalCreditedUsd: microToUsd(credits.reduce((s, c) => s + c.creditMicro, 0)),
    credits: credits.map((c) => ({ ...c, creditMicro: String(c.creditMicro) })),   // string: dipakai tools/verify/check-wallet.mjs
    ledger: config.ledgerAddress || null,
    ...(error ? { error } : {}),
  };
});

// ---------- Masuk ----------
r.get('/api/auth/nonce', async (req, res, p, url) => {
  if (!rateLimit(`nonce:${clientIp(req)}`, 30, 60_000)) return [429, { error: 'slow_down' }];
  const m = makeNonce(url.searchParams.get('wallet'));
  return m ? { message: m } : [400, { error: 'bad_wallet' }];
});
r.post('/api/auth/verify', async (req, res) => {
  if (!rateLimit(`verify:${clientIp(req)}`, 30, 60_000)) return [429, { error: 'slow_down' }];
  const b = await readJson(req);
  const v = verifySignIn(b.wallet, b.signature);
  if (v.error) return [401, { error: v.error }];
  sendJson(res, 200, { account: { wallet: v.account.wallet } }, { 'Set-Cookie': sessionCookie(v.token) });
});
r.post('/api/auth/logout', async (req, res) => {
  logout(req);
  sendJson(res, 200, { ok: true }, { 'Set-Cookie': sessionCookie('', 0) });
});

// ---------- Akun ----------
r.get('/api/me', async (req, res) => {
  const a = needAuth(req, res); if (!a) return;
  const creditedMicro = q.one('SELECT COALESCE(SUM(credit_micro),0) s FROM credits WHERE account_id=?', a.id).s;
  let ghost = null;
  try { ghost = await ghostBalance(a.wallet); } catch {}
  const perks = await isHolder(a);
  return {
    wallet: a.wallet,
    balanceUsd: microToUsd(a.balance_micro - a.held_micro),
    apiKeys: listApiKeys(a.id),
    apiFreeLeft: perks ? freeLeft(holderClientId(a.id, 'api'), config.holderFreePerDay) : freeLeft(apiClientId(a.id), config.freeApiCalls),
    apiRpm: perks ? config.holderApiRpm : config.apiRpm,
    holder: {
      ghost,
      eligible: ghost == null ? null : !isExcludedWallet(a.wallet) && ghost >= config.holderMinTokens,
      creditedUsd: microToUsd(creditedMicro),
      perks: perks ? {
        freePerDay: config.holderFreePerDay,
        freeLeftToday: freeLeft(holderClientId(a.id, 'web'), config.holderFreePerDay),
        apiFreeLeftToday: freeLeft(holderClientId(a.id, 'api'), config.holderFreePerDay),
        apiRpm: config.holderApiRpm,
      } : null,
    },
  };
});
r.post('/api/me/apikey', async (req, res) => {
  const a = needAuth(req, res); if (!a) return;
  if (!rateLimit(`key:${a.id}`, 10, 3600_000)) return [429, { error: 'slow_down' }];
  const k = createApiKey(a.id);
  return k.error ? [400, k] : k;
});
r.post('/api/me/apikey/revoke', async (req, res) => {
  const a = needAuth(req, res); if (!a) return;
  const { prefix } = await readJson(req);
  return revokeApiKey(a.id, prefix) ? { ok: true } : [404, { error: 'not_found' }];
});
const usageRow = (u) => ({ at: u.created_at, model: u.model, tokensIn: u.tokens_in, tokensOut: u.tokens_out, costUsd: microToUsd(u.cost_micro), source: u.source });
r.get('/api/me/usage', async (req, res) => {
  const a = needAuth(req, res); if (!a) return;
  return q.all('SELECT * FROM usage WHERE account_id=? ORDER BY id DESC LIMIT 100', a.id).map(usageRow);
});
// SEMUA yang disimpan tentang akun ini. Bukti: tidak ada isi chat, IP, atau perangkat.
r.get('/api/me/export', async (req, res, p, url) => {
  const a = needAuth(req, res); if (!a) return;
  const data = {
    exportedAt: new Date().toISOString(),
    note: 'This is every row in the GHOSTKEY database linked to your account. Prompts, answers, IP addresses and device details are not stored, so they cannot appear here.',
    account: { wallet: a.wallet, status: a.status, balanceUsd: microToUsd(a.balance_micro), heldUsd: microToUsd(a.held_micro), createdAt: a.created_at },
    apiKeys: q.all('SELECT prefix, created_at, revoked_at FROM api_keys WHERE account_id=? ORDER BY id', a.id)
      .map((k) => ({ prefix: k.prefix, createdAt: k.created_at, revokedAt: k.revoked_at })),
    sessions: q.all('SELECT expires_at FROM sessions WHERE account_id=?', a.id).map((s) => ({ expiresAt: s.expires_at })),
    usage: q.all('SELECT * FROM usage WHERE account_id=? ORDER BY id', a.id).map(usageRow),
    deposits: q.all('SELECT * FROM deposits WHERE account_id=? ORDER BY created_at', a.id).map((d) => ({
      txHash: d.tx_hash, asset: d.asset, amountRaw: d.amount_raw, paidUsd: microToUsd(d.paid_micro), creditUsd: microToUsd(d.credit_micro), at: d.created_at })),
    credits: q.all('SELECT hour, credit_micro, created_at FROM credits WHERE account_id=? ORDER BY hour', a.id)
      .map((c) => ({ hour: c.hour, creditUsd: microToUsd(c.credit_micro), at: c.created_at })),
    freeApiCallsUsed: config.freeApiCalls - freeLeft(apiClientId(a.id), config.freeApiCalls),
    stored: STORED,
    notStored: ['prompts', 'answers', 'ip_address', 'user_agent', 'device'],
    schema: schemaColumns(),
  };
  const h = url.searchParams.get('download') ? { 'Content-Disposition': 'attachment; filename="ghostkey-export.json"' } : {};
  sendJson(res, 200, data, h);
});
r.get('/api/free', async (req, res, p, url) => {
  const a = accountFromSession(req);
  if (await isHolder(a)) return { freeLeft: freeLeft(holderClientId(a.id, 'web'), config.holderFreePerDay), freeMessages: config.holderFreePerDay, holder: true, perDay: true };
  return { freeLeft: freeLeft(url.searchParams.get('clientId')), freeMessages: config.freeMessages };
});

// ---------- Isi saldo (0% biaya) ----------
r.get('/api/deposit/quote', async (req, res, p, url) => {
  const usd = Math.min(config.maxDepositUsd, Math.max(config.minDepositUsd, Number(url.searchParams.get('usd')) || 20));
  const c = quoteCredit(usdToMicro(usd));
  let ethUsd = null;
  try { ethUsd = await (await import('./chain/prices.mjs')).ethUsd(); } catch {}
  return {
    treasury: config.treasury || null, usd, ethUsd,
    creditUsd: microToUsd(c.creditMicro), feeBps: 0, feeUsd: 0,
    payEth: ethUsd ? +(usd / ethUsd).toFixed(6) : null, payUsdg: usd,
    usdg: configData().usdg, minUsd: config.minDepositUsd, maxUsd: config.maxDepositUsd,
  };
});
r.post('/api/deposit/confirm', async (req, res) => {
  const a = needAuth(req, res); if (!a) return;
  if (!rateLimit(`dep:${a.id}`, 20, 60_000)) return [429, { error: 'slow_down' }];
  if (!config.treasury) return [503, { error: 'deposits_closed' }];
  const { txHash } = await readJson(req);
  if (!/^0x[0-9a-fA-F]{64}$/.test(txHash || '')) return [400, { error: 'bad_tx' }];
  if (q.one('SELECT 1 FROM deposits WHERE tx_hash=?', txHash.toLowerCase())) return [409, { error: 'already_credited' }];
  const { verifyDeposit } = await import('./chain/deposits.mjs');
  let v;
  try { v = await verifyDeposit({ txHash, from: a.wallet, treasury: config.treasury }); }
  catch { return [503, { error: 'chain_unavailable' }]; }
  if (!v.ok) return [v.reason === 'pending' || v.reason === 'too_few_confirmations' ? 202 : 400,
    { error: v.reason, confirmations: v.confirmations ?? null, required: Number(process.env.MIN_CONFIRMATIONS || 3) }];
  // Pembayaran yang sudah diterima on-chain selalu dikreditkan (minimum hanya dijaga di formulir)
  const paid = Number(v.usdMicro);
  if (paid <= 0) return [400, { error: 'zero_amount' }];
  const c = creditDeposit(a.id, { txHash: txHash.toLowerCase(), asset: v.asset, amountRaw: v.amountRaw, paidMicro: paid });
  if (c.error) return [409, c];
  return { creditedUsd: microToUsd(c.creditMicro), paidUsd: microToUsd(c.paidMicro), feeUsd: 0, balanceUsd: microToUsd(c.balanceMicro) };
});

// ---------- Chat ----------
r.post('/api/chat', async (req, res) => {
  const ip = clientIp(req);
  if (!rateLimit(`chat:${ip}`, 40, 60_000)) return [429, { error: 'slow_down', message: 'Too many messages. Wait a minute.' }];
  const b = await readJson(req, 25_000_000);
  const account = accountFromSession(req);
  const holder = await isHolder(account);
  await runChatStream(req, res, {
    account, modelId: b.model, messages: b.messages,
    clientId: holder ? holderClientId(account.id, 'web') : String(b.clientId || ''),
    ...(holder ? { freeLimit: config.holderFreePerDay } : {}),
    ip, wantTokens: Number(b.maxTokens) || undefined, extra: b,
  });
});

// ---------- OpenAI-compatible ----------
r.get('/v1/models', async () => ({
  object: 'list',
  data: (await getCatalog()).list.map((m) => ({ id: m.id, object: 'model', created: m.created, owned_by: m.lab, context_length: m.context,
    pricing: { prompt_per_million: m.in, completion_per_million: m.out }, zdr: true, zdr_providers: m.zdrProviders })),
}));
r.post('/v1/chat/completions', async (req, res) => {
  const account = accountFromBearer(req);
  if (!account) return [401, { error: { message: 'Missing or invalid API key. Create one at /account.', code: 'invalid_api_key' } }];
  const holder = await isHolder(account);
  const rpm = holder ? config.holderApiRpm : config.apiRpm;
  if (!rateLimit(`api:${account.id}`, rpm, 60_000)) return [429, { error: { message: `Rate limit: ${rpm} requests per minute.`, code: 'rate_limited' } }];
  const b = await readJson(req, 25_000_000);
  const ip = clientIp(req);
  // Akun tanpa saldo tetap bisa mencoba API memakai jatah gratisnya sendiri (model hemat saja); pemegang: jatah harian
  const clientId = holder ? holderClientId(account.id, 'api') : apiClientId(account.id);
  const freeLimit = holder ? config.holderFreePerDay : config.freeApiCalls;
  if (b.stream) {
    return runChatStream(req, res, { account, modelId: b.model, messages: b.messages, clientId, ip, freeLimit,
      wantTokens: Number(b.max_tokens || b.max_completion_tokens) || undefined, openaiStream: true, extra: b });
  }
  return runChatJson(req, res, { account, body: b, clientId, ip, freeLimit });
});

// ---------- Admin (kunci ADMIN_KEY) ----------
const isAdmin = (req) => config.adminKey && req.headers['x-admin-key'] === config.adminKey;
r.get('/api/admin/status', async (req) => {
  if (!isAdmin(req)) return [403, { error: 'forbidden' }];
  return { harvesterMissing: harvesterReady(), openrouter: !!config.openrouterKey, ghostToken: config.ghostToken || null,
    ledger: config.ledgerAddress || null, pending: q.all("SELECT hour, error FROM ledger_hours WHERE status='pending'"),
    partialHarvests: q.all("SELECT k, v FROM kv WHERE k LIKE 'harvest_partial:%'") };
});
r.post('/api/admin/run-hour', async (req) => {
  if (!isAdmin(req)) return [403, { error: 'forbidden' }];
  const { hour } = await readJson(req);
  return runHour(Number(hour));
});

// Tarik fee sekarang (tombol Desktop pemilik): klaim creator fee dari Pons lalu bagi 75/25 seperti panen terjadwal
r.post('/api/admin/harvest-now', async (req) => {
  if (!isAdmin(req)) return [403, { error: 'forbidden' }];
  const missing = harvesterReady();
  if (missing.length) return [409, { error: 'not_ready', missing }];
  const { harvestOnce, isHarvesting } = await import('./harvester.mjs');
  if (isHarvesting()) return [409, { error: 'busy' }];
  const { escrowBalance } = await import('./chain/fees.mjs');
  const { feeWallet } = await import('./chain/wallets.mjs');
  const pendingWei = String(await escrowBalance(feeWallet(0).address));
  const result = await harvestOnce(undefined, { minWei: 1n });
  return { pendingWei, result };
});

// Halaman bukti: HTML dirender server (bisa dibaca tanpa JavaScript)
r.get('/proof', async (req, res) => {
  const { renderProof } = await import('./proof.mjs');
  sendHtml(res, 200, await renderProof());
});

// ---------- Header keamanan ----------
const BASE_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'X-Frame-Options': 'DENY',
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=(), usb=()',
  ...(config.publicUrl.startsWith('https://') ? { 'Strict-Transport-Security': 'max-age=31536000' } : {}),
};
// CSP per halaman: skrip sebaris (mis. importmap) diizinkan lewat hash sha256 isinya, bukan 'unsafe-inline'.
function cspFor(html) {
  const hashes = [...html.matchAll(/<script(?![^>]*\bsrc\s*=)[^>]*>([\s\S]*?)<\/script>/gi)]
    .map((m) => `'sha256-${createHash('sha256').update(m[1], 'utf8').digest('base64')}'`);
  return [
    "default-src 'self'",
    `script-src 'self' https://cdn.jsdelivr.net ${[...new Set(hashes)].join(' ')}`.trim(),
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    "font-src 'self' https://fonts.gstatic.com data:",
    "img-src 'self' data: blob: https:",
    "connect-src 'self' https://openrouter.ai https://rpc.mainnet.chain.robinhood.com https://robinhood-rpc.publicnode.com https://robinhoodchain.blockscout.com https://cdn.jsdelivr.net",
    "worker-src 'self' blob:",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join('; ');
}
function sendHtml(res, status, html) {
  res.writeHead(status, { ...BASE_HEADERS, 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'Content-Security-Policy': cspFor(html) });
  res.end(html);
}

// ---------- Berkas statis ----------
const WEB = join(ROOT, 'web');
const PAGES = { '/': 'index.html', '/app': 'app.html', '/account': 'account.html', '/models': 'models.html',
  '/token': 'token.html', '/privacy': 'privacy.html', '/docs': 'docs.html', '/roadmap': 'roadmap.html' };
const ROOT_FILES = new Set(['/llms.txt', '/robots.txt', '/sitemap.xml', '/favicon.ico', '/favicon.svg', '/site.webmanifest']);
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif',
  '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.json': 'application/json', '.woff2': 'font/woff2', '.woff': 'font/woff',
  '.mp4': 'video/mp4', '.webm': 'video/webm', '.glb': 'model/gltf-binary', '.txt': 'text/plain; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8', '.webmanifest': 'application/manifest+json' };
const DEFAULT_HOST = 'https://ghostkeyai.com';

function cacheFor(path, ext) {
  if (ext === '.html') return 'no-store';
  // no-cache: browser wajib cek ulang tiap muat → setelah deploy tak ada CSS/JS basi
  if (ext === '.css' || ext === '.js' || ext === '.mjs') return 'no-cache';
  if (path.startsWith('/img/') || path.startsWith('/fonts/')) return 'public, max-age=86400';
  return 'public, max-age=300';
}

async function serveStatic(req, res, path, status = 200) {
  let rel;
  if (PAGES[path]) rel = PAGES[path];
  else if (path === '/404.html' || ROOT_FILES.has(path) || /^\/(css|js|img|fonts)\//.test(path)) rel = path.slice(1);
  else return false;
  const file = join(WEB, normalize(rel));
  if (!file.startsWith(WEB + '/')) return false;
  try {
    const s = await stat(file);
    if (!s.isFile()) return false;
    let body = await readFile(file);
    const ext = extname(file).toLowerCase();
    // llms.txt / robots / sitemap ditulis untuk domain utama → ganti dengan alamat publik server ini
    if ((ext === '.txt' || ext === '.xml') && config.publicUrl !== DEFAULT_HOST) {
      body = Buffer.from(body.toString('utf8').replaceAll(DEFAULT_HOST, config.publicUrl));
    }
    if (ext === '.html') {
      const html = body.toString('utf8').replaceAll('content="/img/og.png"', `content="${config.publicUrl}/img/og.png"`);
      sendHtml(res, status, html);
      return true;
    }
    res.writeHead(status, { ...BASE_HEADERS, 'Content-Type': TYPES[ext] || 'application/octet-stream', 'Cache-Control': cacheFor(path, ext) });
    res.end(body);
    return true;
  } catch { return false; }
}

// CORS: rute publik tanpa cookie boleh dipanggil dari situs lain (verifikasi, klien API)
const PUBLIC_CORS = /^\/(v1\/|api\/(models|stats|proof|ledger|holder|inspect|config)(\/|$))/;

// ---------- Server ----------
export const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const path = url.pathname;
  const cors = PUBLIC_CORS.test(path);
  if (cors) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }
  }
  for (const [k, v] of Object.entries(BASE_HEADERS)) res.setHeader(k, v);
  try {
    const m = r.match(req.method, path);
    if (m) {
      const out = await m.handler(req, res, m.params, url);
      if (res.headersSent || res.writableEnded) return;
      // [status, body] = jawaban dengan kode status; selain itu dikirim apa adanya
      if (Array.isArray(out) && out.length === 2 && typeof out[0] === 'number') return sendJson(res, out[0], out[1]);
      if (out !== undefined) return sendJson(res, 200, out);
      return;
    }
    if (req.method === 'GET' && await serveStatic(req, res, path)) return;
    if (path.startsWith('/api/') || path.startsWith('/v1/')) return sendJson(res, 404, { error: 'not_found' });
    if (await serveStatic(req, res, '/404.html', 404)) return;
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); res.end('Not found');
  } catch (e) {
    if (!e.status) console.error('[server]', req.method, path, e);
    if (!res.headersSent) sendJson(res, e.status || 500, { error: e.status ? e.message : 'server_error' });
    else if (!res.writableEnded) res.end();
  }
});

server.listen(config.port, config.host, () => {
  console.log(`GHOSTKEY jalan di http://localhost:${config.port}  (OpenRouter: ${config.openrouterKey ? 'aktif' : 'MODE TIRUAN'})`);
  getCatalog().then((c) => console.log(`[katalog] ${c.list.length} model ZDR (${c.source})`));
  if (!config.disableSchedulers) {
    startHarvester();
    startCreditScheduler();
  }
  // Bersihkan nonce, sesi kedaluwarsa, dan hitungan harian lama tiap jam
  setInterval(() => {
    q.run('DELETE FROM nonces WHERE expires_at < ?', Date.now());
    q.run('DELETE FROM sessions WHERE expires_at < ?', Date.now());
    pruneDaily();
  }, 3600_000);
});
