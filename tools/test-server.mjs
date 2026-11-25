// Uji ujung-ke-ujung server GHOSTKEY (mode tiruan, tanpa biaya, tanpa transaksi on-chain).
// Menyalakan server di port 4890 dengan folder data sementara, lalu menguji semua endpoint,
// struk SSE, inspector privasi, ekspor tanpa isi chat, alur kunci API, dan mesin Ghost Credit (pembaca token tiruan).
// Jalankan: node tools/test-server.mjs   → keluar dengan kode ≠ 0 kalau ada yang gagal.
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Wallet, keccak256 } from 'ethers';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 4890;
const B = `http://127.0.0.1:${PORT}`;
const DATA = mkdtempSync(join(tmpdir(), 'ghostkey-test-'));
const TREASURY = Wallet.createRandom().address;
const OWNER = Wallet.createRandom().address;
const TEAM = Wallet.createRandom().address;
const MARKER = `zebra-marker-${Date.now()}`;   // teks unik di prompt: tidak boleh muncul di DB/ekspor

// Lingkungan yang sama untuk server anak & modul yang diimpor tes ini (DB yang sama)
const ENV = {
  PORT: String(PORT), HOST: '127.0.0.1', GHOSTKEY_DATA_DIR: DATA, GHOSTKEY_ENV_FILE: join(DATA, 'none.env'),
  PUBLIC_URL: B, OPENROUTER_API_KEY: '', GHOSTKEY_NO_SCHEDULERS: '1', ADMIN_KEY: 'test-admin',
  TREASURY_ADDRESS: TREASURY, OWNER_WALLET: OWNER, TEAM_WALLETS: TEAM, GHOST_TOKEN: '', LEDGER_ADDRESS: '', GHOST_MNEMONIC: '',
  HOLDER_MIN_TOKENS: '100000', HOLDER_SHARE_BPS: '2500', FREE_MESSAGES: '10', FREE_API_CALLS: '10', FREE_PER_IP_DAY: '200',
  LINK_GITHUB: 'https://github.com/example/ghostkey',
};
Object.assign(process.env, ENV);

let ok = 0, bad = 0;
const check = (name, cond, extra = '') => { cond ? ok++ : bad++; console.log(`${cond ? '✓' : '✗'} ${name}${extra ? '  ' + extra : ''}`); };
const J = (o) => JSON.stringify(o);

// ---------- Nyalakan server ----------
const child = spawn(process.execPath, [join(ROOT, 'server/server.mjs')], { env: { ...process.env, ...ENV }, stdio: ['ignore', 'pipe', 'pipe'] });
let serverLog = '';
child.stdout.on('data', (d) => { serverLog += d; });
child.stderr.on('data', (d) => { serverLog += d; });
const stop = () => { try { child.kill(); } catch {} };
process.on('exit', stop);

async function waitUp() {
  for (let i = 0; i < 100; i++) {
    try { const r = await fetch(B + '/api/config'); if (r.ok) return true; } catch {}
    await new Promise((r) => setTimeout(r, 150));
  }
  return false;
}

// SSE → { status, events:[{event, data}], content, receipt, json }
async function sse(path, body, headers = {}) {
  const r = await fetch(B + path, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: J(body) });
  if (!r.headers.get('content-type')?.includes('event-stream')) return { status: r.status, json: await r.json() };
  const raw = await r.text();
  const events = raw.split('\n\n').filter(Boolean).map((blk) => {
    const ev = blk.match(/^event: (.*)$/m)?.[1] || null;
    const data = blk.match(/^data: (.*)$/m)?.[1] ?? '';
    let parsed = data; try { parsed = JSON.parse(data); } catch {}
    return { event: ev, data: parsed };
  });
  const content = events.filter((e) => !e.event && e.data?.choices).map((e) => e.data.choices[0]?.delta?.content || '').join('');
  const receipt = events.find((e) => e.event === 'receipt')?.data || events.find((e) => e.data?.ghostkey_receipt)?.data.ghostkey_receipt || null;
  return { status: r.status, raw, events, content, receipt };
}
const get = async (p, headers = {}) => { const r = await fetch(B + p, { headers }); let j = null; try { j = await r.clone().json(); } catch {} return { r, j }; };
const post = async (p, body, headers = {}) => {
  const r = await fetch(B + p, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: J(body) });
  let j = null; try { j = await r.json(); } catch {} return { r, j };
};

async function signIn(w) {
  const { j } = await get(`/api/auth/nonce?wallet=${w.address}`);
  const sig = await w.signMessage(j.message);
  const r = await fetch(B + '/api/auth/verify', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: J({ wallet: w.address, signature: sig }) });
  return { r, cookie: r.headers.get('set-cookie')?.split(';')[0], sig };
}

try {
  check('server menyala (mode tiruan)', await waitUp(), serverLog.split('\n')[0]);

  // ---------- Konfigurasi & header ----------
  let { r, j: cfg } = await get('/api/config');
  check('/api/config bentuk', cfg.chainId === 4663 && cfg.ghostToken === null && cfg.ledger === null && cfg.holderShareBps === 2500 &&
    cfg.minTokens === 100000 && cfg.freeMessages === 10 && cfg.topUpFeeBps === 0 && cfg.treasury === TREASURY && cfg.owner === OWNER &&
    cfg.blockscout === 'https://robinhoodchain.blockscout.com' && cfg.mock === true && typeof cfg.links === 'object', J(cfg).slice(0, 160));
  check('/api/config no-store + header keamanan', r.headers.get('cache-control') === 'no-store' && r.headers.get('x-content-type-options') === 'nosniff' &&
    r.headers.get('referrer-policy') === 'no-referrer' && r.headers.get('x-frame-options') === 'DENY');

  // ---------- Katalog ZDR ----------
  const { j: models } = await get('/api/models');
  check('katalog model ZDR', Array.isArray(models) && models.length > 50, `(${models?.length} model)`);
  check('semua model zdr:true + punya penyedia ZDR', models.every((m) => m.zdr === true && m.zdrProviders.length > 0));
  const [orModels, zdrList] = await Promise.all([
    fetch('https://openrouter.ai/api/v1/models').then((x) => x.json()),
    fetch('https://openrouter.ai/api/v1/endpoints/zdr').then((x) => x.json()),
  ]);
  const zdrIds = new Set(zdrList.data.map((e) => e.model_id));
  check('semua model ada di daftar ZDR publik OpenRouter', models.every((m) => zdrIds.has(m.id)));
  const orBy = new Map(orModels.data.map((m) => [m.id, m]));
  const priceMismatch = models.filter((m) => {
    const o = orBy.get(m.id); if (!o) return false;
    return +(Number(o.pricing.prompt) * 1e6).toFixed(4) !== m.in || +(Number(o.pricing.completion) * 1e6).toFixed(4) !== m.out;
  });
  check('tarif = harga OpenRouter persis', priceMismatch.length === 0, priceMismatch.slice(0, 3).map((m) => m.id).join(', '));
  const cheap = models.find((m) => m.freeEligible);
  const pricey = models.find((m) => !m.freeEligible && m.out > 5);
  check('ada model gratis & mahal', !!cheap && !!pricey, `${cheap?.id} / ${pricey?.id}`);
  const { j: v1models } = await get('/v1/models');
  check('/v1/models', v1models.object === 'list' && v1models.data.length === models.length && v1models.data[0].zdr === true);

  // ---------- Inspector ----------
  ({ r, j } = await post('/api/inspect', {
    model: cheap.id, messages: [{ role: 'user', content: 'hi', name: 'alice' }], user: 'alice@example.com', metadata: { wallet: '0xabc' },
    provider: { zdr: false, data_collection: 'allow', order: ['SomeProvider'] }, temperature: 0.3, logit_bias: { 1: 2 },
  }, { Cookie: 'gk_s=secret-session', 'X-Forwarded-For': '203.0.113.9', 'User-Agent': 'TestBrowser/1.0' }));
  var j;
  const ws = j?.wouldSend;
  check('inspect 200', r.status === 200 && !!ws, r.status);
  check('inspect: provider dipaksa zdr:true + deny', J(ws.body.provider) === J({ zdr: true, data_collection: 'deny' }));
  check('inspect: kolom user/metadata/logit_bias dibuang', !('user' in ws.body) && !('metadata' in ws.body) && !('logit_bias' in ws.body) && ws.body.temperature === 0.3);
  check('inspect: nama pengirim di pesan dibuang', !('name' in ws.body.messages[0]));
  check('inspect: Authorization disamarkan', /hidden/.test(ws.headers.Authorization) && !/sk-or-mock/.test(J(j)));
  check('inspect: header klien tidak dikirim', ['cookie', 'x-forwarded-for', 'user-agent'].every((h) => j.notSent.includes(h)) &&
    !J(ws.headers).includes('203.0.113.9') && !J(ws.headers).includes('TestBrowser') && !J(ws).includes('secret-session'));
  check('inspect: droppedFields + stripped + tautan', ['user', 'metadata', 'provider', 'logit_bias'].every((f) => j.droppedFields.includes(f)) &&
    j.stripped.includes('ip_address') && j.zdrList === 'https://openrouter.ai/api/v1/endpoints/zdr' && j.code.endsWith('/server/privacy.mjs'));
  ({ r } = await post('/api/inspect', { model: 'no/such-model', messages: [{ role: 'user', content: 'x' }] }));
  check('inspect model tak dikenal → 400', r.status === 400);

  // ---------- Pesan gratis (web) ----------
  const clientId = 'test' + Math.random().toString(36).slice(2) + 'xxxxxxxxxxxxxxxx';
  ({ j } = await get(`/api/free?clientId=${clientId}`));
  check('/api/free awal = 10', j.freeLeft === 10);
  let s = await sse('/api/chat', { model: cheap.id, clientId, user: 'leak@example.com', messages: [{ role: 'user', content: `hello ${MARKER}` }] });
  const rc = s.receipt;
  check('chat gratis jalan', s.status === 200 && s.content.length > 10, `freeLeft=${rc?.freeLeft}`);
  check('struk: kolom lengkap', rc && ['model', 'tokensIn', 'tokensOut', 'rateIn', 'rateOut', 'costUsd', 'balanceUsd', 'freeLeft', 'forwarded', 'stripped', 'stored'].every((k) => k in rc));
  check('struk: angka', rc.model === cheap.id && rc.tokensIn > 0 && rc.tokensOut > 0 && rc.rateIn === cheap.in && rc.rateOut === cheap.out &&
    rc.balanceUsd === null && rc.freeLeft === 9 && rc.paidBy === 'free');
  check('struk: biaya = token × tarif (mode tiruan)', Math.abs(rc.costUsd - Math.round(rc.tokensIn * cheap.in + rc.tokensOut * cheap.out) / 1e6) < 1e-9, `$${rc.costUsd}`);
  check('struk: forwarded = permintaan ZDR tersamar', J(rc.forwarded.body.provider) === J({ zdr: true, data_collection: 'deny' }) &&
    /hidden/.test(rc.forwarded.headers.Authorization) && !('user' in rc.forwarded.body) && rc.forwarded.body.stream === true);
  check('struk: stored = model/tokens/cost/time', J(rc.stored) === J(['model', 'tokens', 'cost', 'time']) && rc.stripped.includes('wallet_address'));
  const order = s.events.map((e) => e.event || (e.data === '[DONE]' ? 'done' : 'chunk'));
  check('SSE: potongan → receipt → [DONE]', order.at(-1) === 'done' && order.at(-2) === 'receipt' && order[0] === 'chunk');
  s = await sse('/api/chat', { model: pricey.id, clientId, messages: [{ role: 'user', content: 'hello' }] });
  check('model mahal ditolak saat gratis', s.status === 402 && s.json.error === 'model_needs_balance');
  for (let i = 0; i < 9; i++) await sse('/api/chat', { model: cheap.id, clientId, messages: [{ role: 'user', content: `n${i} ${MARKER}` }] });
  ({ j } = await get(`/api/free?clientId=${clientId}`));
  check('jatah gratis habis setelah 10', j.freeLeft === 0);
  s = await sse('/api/chat', { model: cheap.id, clientId, messages: [{ role: 'user', content: 'again' }] });
  check('pesan ke-11 → 402 sign_in', s.status === 402 && s.json.error === 'sign_in');
  s = await sse('/api/chat', { model: cheap.id, clientId: 'short', messages: [{ role: 'user', content: 'x' }] });
  check('clientId tak sah → 402', s.status === 402);

  // ---------- Masuk dompet ----------
  const w = Wallet.createRandom();
  const si = await signIn(w);
  const cookie = si.cookie;
  check('masuk dompet → cookie gk_s', si.r.status === 200 && cookie?.startsWith('gk_s='));
  const again = await fetch(B + '/api/auth/verify', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: J({ wallet: w.address, signature: si.sig }) });
  check('nonce tidak bisa dipakai ulang', again.status === 401);
  ({ r } = await get('/api/me'));
  check('/api/me tanpa sesi → 401', r.status === 401);
  ({ j } = await get('/api/me', { cookie }));
  check('/api/me bentuk', j.wallet === w.address.toLowerCase() && j.balanceUsd === 0 && Array.isArray(j.apiKeys) && j.apiKeys.length === 0 &&
    j.holder && j.holder.ghost === null && j.holder.eligible === null && j.holder.creditedUsd === 0, J(j));

  // ---------- Chat berbayar (saldo diisi langsung di DB uji) ----------
  const { q } = await import('../server/db.mjs');
  q.run('UPDATE accounts SET balance_micro=5000000 WHERE wallet=?', w.address.toLowerCase());
  s = await sse('/api/chat', { model: pricey.id, clientId: clientId + 'b', messages: [{ role: 'user', content: `explain gravity ${MARKER}` }] }, { cookie });
  check('chat berbayar jalan', s.status === 200 && s.receipt?.paidBy === 'balance' && s.receipt.costUsd > 0, `biaya=$${s.receipt?.costUsd} saldo=$${s.receipt?.balanceUsd}`);
  check('saldo terpotong tepat', Math.abs(5 - s.receipt.costUsd - s.receipt.balanceUsd) < 1e-6 && s.receipt.freeLeft === null);
  check('tahanan dilepas', q.one('SELECT held_micro h FROM accounts WHERE wallet=?', w.address.toLowerCase()).h === 0);

  // ---------- Kunci API ----------
  ({ j } = await post('/api/me/apikey', {}, { cookie }));
  const apiKey = j?.apiKey;
  check('kunci API gk_live_ dibuat', /^gk_live_/.test(apiKey || '') && j.prefix === apiKey.slice(0, 14));
  ({ j } = await get('/api/me', { cookie }));
  check('/api/me apiKeys = prefix saja', j.apiKeys.length === 1 && j.apiKeys[0].prefix === apiKey.slice(0, 14) && !J(j).includes(apiKey));
  let jr = await fetch(B + '/v1/chat/completions', { method: 'POST', headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: J({ model: cheap.id, user: 'leak', messages: [{ role: 'user', content: `ping ${MARKER}` }] }) });
  let jj = await jr.json();
  check('/v1 non-stream (saldo)', jr.status === 200 && jj.choices?.[0]?.message?.content?.length > 5 && jj.ghostkey_receipt?.paidBy === 'balance' &&
    Number(jr.headers.get('x-ghostkey-cost')) === jj.ghostkey_receipt.costUsd);
  check('/v1 ghostkey_receipt.forwarded ZDR + tanpa user', jj.ghostkey_receipt.forwarded.body.provider.zdr === true && !('user' in jj.ghostkey_receipt.forwarded.body));
  s = await sse('/v1/chat/completions', { model: cheap.id, stream: true, messages: [{ role: 'user', content: 'ping' }] }, { Authorization: `Bearer ${apiKey}` });
  check('/v1 stream: format OpenAI murni + struk di potongan terakhir', s.status === 200 && s.content.length > 5 && !/^event:/m.test(s.raw) &&
    s.receipt?.paidBy === 'balance' && s.events.at(-1).data === '[DONE]');
  ({ r } = await post('/v1/chat/completions', {}, { Authorization: 'Bearer gk_live_wrong' }));
  check('/v1 kunci salah → 401', r.status === 401);
  ({ j } = await post('/api/me/apikey/revoke', { prefix: apiKey.slice(0, 14) }, { cookie }));
  ({ r } = await post('/v1/chat/completions', { model: cheap.id, messages: [{ role: 'user', content: 'x' }] }, { Authorization: `Bearer ${apiKey}` }));
  check('kunci dicabut → 401', j?.ok === true && r.status === 401);

  // ---------- Akun burner baru: 10 panggilan API gratis ----------
  const burner = Wallet.createRandom();
  const bs = await signIn(burner);
  ({ j } = await post('/api/me/apikey', {}, { cookie: bs.cookie }));
  const bKey = j.apiKey;
  ({ j } = await get('/api/me', { cookie: bs.cookie }));
  check('akun baru: apiFreeLeft = 10', j.apiFreeLeft === 10);
  jr = await fetch(B + '/v1/chat/completions', { method: 'POST', headers: { Authorization: `Bearer ${bKey}`, 'Content-Type': 'application/json' },
    body: J({ model: cheap.id, messages: [{ role: 'user', content: 'free ping' }] }) });
  jj = await jr.json();
  check('/v1 gratis akun baru', jr.status === 200 && jj.ghostkey_receipt?.paidBy === 'free' && jj.ghostkey_receipt.freeLeft === 9 && jr.headers.get('x-ghostkey-free-left') === '9');
  ({ r, j } = await post('/v1/chat/completions', { model: pricey.id, messages: [{ role: 'user', content: 'x' }] }, { Authorization: `Bearer ${bKey}` }));
  check('/v1 gratis: model mahal → 402', r.status === 402 && j.error.code === 'model_needs_balance');
  for (let i = 0; i < 9; i++) await post('/v1/chat/completions', { model: cheap.id, messages: [{ role: 'user', content: 'p' }] }, { Authorization: `Bearer ${bKey}` });
  ({ r, j } = await post('/v1/chat/completions', { model: cheap.id, messages: [{ role: 'user', content: 'p' }] }, { Authorization: `Bearer ${bKey}` }));
  check('/v1 panggilan gratis ke-11 → 402 + pesan jelas', r.status === 402 && / /.test(j.error.message), J(j));

  // ---------- Pemakaian & ekspor ----------
  ({ j } = await get('/api/me/usage', { cookie }));
  check('/api/me/usage', Array.isArray(j) && j.length >= 3 && ['at', 'model', 'tokensIn', 'tokensOut', 'costUsd', 'source'].every((k) => k in j[0]));
  ({ r, j } = await get('/api/me/export?download=1', { cookie }));
  check('/api/me/export lengkap', r.status === 200 && j.account.wallet === w.address.toLowerCase() && j.apiKeys.length === 1 && j.usage.length >= 3 &&
    Array.isArray(j.deposits) && Array.isArray(j.credits) && /attachment/.test(r.headers.get('content-disposition') || ''));
  check('ekspor tanpa isi chat', !J(j).includes(MARKER) && !J(j).includes('gravity') && !J(j).includes(apiKey));
  const BANNED = /^(content|prompt|prompts|message|messages|text|answer|answers|reply|response|completion|ip|ip_address|user_agent|ua|body)$/i;
  const badCols = Object.entries(j.schema).flatMap(([t, cols]) => cols.filter((c) => BANNED.test(c)).map((c) => `${t}.${c}`));
  check('skema DB tanpa kolom isi/IP', badCols.length === 0, badCols.join(','));
  const dbBytes = readdirSync(DATA).filter((f) => f.startsWith('ghostkey.db')).map((f) => readFileSync(join(DATA, f)).toString('latin1')).join('');
  check('berkas DB (termasuk WAL) tidak memuat teks prompt', dbBytes.length > 0 && !dbBytes.includes(MARKER) && !dbBytes.includes('203.0.113.9'));

  // ---------- Isi saldo ----------
  ({ j } = await get('/api/deposit/quote?usd=20'));
  check('quote: fee 0, kredit = USD', j.feeBps === 0 && j.creditUsd === 20 && j.usd === 20 && j.treasury === TREASURY && j.payUsdg === 20, J(j));
  ({ r } = await post('/api/deposit/confirm', { txHash: '0x1234' }, { cookie }));
  check('confirm tx tak sah → 400', r.status === 400);
  ({ r } = await post('/api/deposit/confirm', { txHash: '0x' + '1'.repeat(64) }));
  check('confirm tanpa sesi → 401', r.status === 401);
  const { creditDeposit } = await import('../server/billing.mjs');
  const accId = q.one('SELECT id FROM accounts WHERE wallet=?', w.address.toLowerCase()).id;
  const before = q.one('SELECT balance_micro b FROM accounts WHERE id=?', accId).b;
  const dep = creditDeposit(accId, { txHash: '0x' + 'a'.repeat(64), asset: 'USDG', amountRaw: 20_000_000n, paidMicro: 20_000_000 });
  const dup = creditDeposit(accId, { txHash: '0x' + 'a'.repeat(64), asset: 'USDG', amountRaw: 20_000_000n, paidMicro: 20_000_000 });
  check('deposit 0%: +$20 tepat, tx ganda ditolak', dep.creditMicro === 20_000_000 && dep.balanceMicro === before + 20_000_000 && dup.error === 'already_credited');

  // ---------- Panen + Ghost Credit (dependensi tiruan) ----------
  const credit = await import('../server/credit.mjs');
  const { harvestOnce } = await import('../server/harvester.mjs');
  const merkle = await import('../server/merkle.mjs');
  const nowH = credit.hourOf();
  const H0 = nowH - 6, H1 = nowH - 5, H2 = nowH - 4;
  const atHour = (h, min) => h * 3_600_000 + min * 60_000;

  // Panen tiruan di jam H1: 1 ETH diklaim @ $3000 → 25% ke treasury (+ sisa 1 wei), 75% ke pemilik
  const fakeClaim = (claimed) => async ({ splits }) => {
    const owner = splits.find((x) => x.to === OWNER), tre = splits.find((x) => x.to === TREASURY);
    const ow = (claimed * BigInt(owner.bps)) / 10000n, tw = (claimed * BigInt(tre.bps)) / 10000n;
    return { claimedWei: claimed, txs: [{ kind: 'claim', txHash: '0x' + 'c1'.repeat(32) }],
      sent: [{ to: OWNER, wei: ow, txHash: '0x' + 'd1'.repeat(32) }, { to: TREASURY, wei: tw, txHash: '0x' + 'e1'.repeat(32) }] };
  };
  const hv = await harvestOnce({ escrowBalance: async () => 10n ** 18n, claimAndSplit: fakeClaim(411522633744855967n), ethUsd: async () => 3000,
    feeAddress: Wallet.createRandom().address, now: () => atHour(H1, 50) });
  check('panen: 25% → treasury, 75% → pemilik, jam benar', hv.hour === H1 && hv.holderWei === (411522633744855967n * 2500n / 10000n).toString() &&
    Math.abs(hv.holderMicro - hv.usdMicro * 0.25) <= 1 && Math.abs(hv.ownerMicro - hv.usdMicro * 0.75) <= 1, `pool=$${hv.holderMicro / 1e6}`);
  const small = await harvestOnce({ escrowBalance: async () => 10n, claimAndSplit: async () => { throw new Error('should not claim'); }, ethUsd: async () => 3000, feeAddress: TEAM });
  check('panen di bawah minimum dilewati', small === null);

  // Pembaca token tiruan: A & B layak, C = dompet tim (dikecualikan), D di bawah minimum, E saldo nol, + treasury
  const A = Wallet.createRandom().address.toLowerCase(), Bw = Wallet.createRandom().address.toLowerCase();
  const D = Wallet.createRandom().address.toLowerCase(), E = Wallet.createRandom().address.toLowerCase();
  const T = (n) => BigInt(n) * 10n ** 18n;
  const bal = {
    [A]: [T(300_000), T(300_000), T(300_000), T(300_000)],
    [Bw]: [T(500_000), T(700_000), T(800_000), T(800_000)],      // rata-rata 700k
    [TEAM.toLowerCase()]: [T(5_000_000), T(5_000_000), T(5_000_000), T(5_000_000)],
    [D]: [T(50_000), T(50_000), T(50_000), T(50_000)],
    [E]: [0n, 0n, 0n, 0n],
    [TREASURY.toLowerCase()]: [T(1_000_000), T(1_000_000), T(1_000_000), T(1_000_000)],
  };
  const fakeReader = {
    token: '0x' + '9'.repeat(40),
    decimals: async () => 18,
    blockAt: async (ts) => ts - 1_700_000_000,
    holders: async () => Object.keys(bal),
    balancesAt: async (addrs, block) => {
      const idx = credit.SNAPSHOT_OFFSETS.indexOf((block + 1_700_000_000) % 3600 || 3600);
      return new Map(addrs.map((a) => [a, bal[a]?.[idx] ?? 0n]));
    },
    systemExclusions: async () => [{ address: '0x' + '7'.repeat(40), label: 'Pons bonding curve' }],
  };
  const posts = [];
  const fakeLedger = {
    readHour: async () => null,
    postHour: async (a) => { posts.push(a); return { txHash: '0x' + String(posts.length).padStart(2, '0').repeat(32), blockNumber: 1000 + posts.length }; },
  };
  const feeWalletAddr = Wallet.createRandom().address;
  const deps = { tokenReader: fakeReader, merkle, ledger: fakeLedger, signer: { fake: true }, feeWallet: feeWalletAddr, now: () => atHour(nowH, 6) };

  const tooEarly = await credit.runHour(nowH, deps);
  check('jam berjalan ditolak (too_early)', tooEarly.status === 'too_early');
  const r0 = await credit.runHour(H0, deps);
  check('jam tanpa fee → no_fees, tidak posting', r0.status === 'no_fees' && posts.length === 0 && r0.poolUsd === 0);
  const r1 = await credit.runHour(H1, deps);
  const pool1 = hv.holderMicro;
  const expA = Math.floor((pool1 * 300_000) / 1_000_000), expB = Math.floor((pool1 * 700_000) / 1_000_000);
  const f1 = credit.ledgerHour(H1);
  const eA = f1.entries.find((e) => e.wallet === A), eB = f1.entries.find((e) => e.wallet === Bw);
  check('Ghost Credit: hanya A & B yang dapat (tim, treasury, di bawah minimum, nol dikecualikan)', f1.entries.length === 2 && !!eA && !!eB, f1.entries.map((e) => e.wallet.slice(0, 8)).join(','));
  check('Ghost Credit: pro-rata rata-rata 4 bacaan, dibulatkan ke bawah', eA.creditMicro === expA && eB.creditMicro === expB && eB.avgBalance === T(700_000).toString(),
    `A=${eA.creditMicro} B=${eB.creditMicro} pool=${pool1}`);
  check('Ghost Credit: sisa pembulatan dibawa ke jam berikut', f1.carryOutMicro === pool1 - expA - expB && f1.poolMicro === pool1);
  check('Ghost Credit: daftar pengecualian dipublikasikan', [TEAM, TREASURY, OWNER, feeWalletAddr].every((x) => f1.excluded.some((e) => e.address === x.toLowerCase())) &&
    f1.excluded.some((e) => e.label === 'Pons bonding curve') && f1.belowMin === 1);
  check('Ghost Credit: 4 blok snapshot :15/:30/:45/:60', J(f1.blocks) === J(credit.SNAPSHOT_OFFSETS.map((o) => H1 * 3600 + o - 1_700_000_000)));
  const proofsOk = f1.entries.every((e) => merkle.verifyProof(merkle.leafHash(e.wallet, H1, e.creditMicro), e.proof, f1.root));
  check('Ghost Credit: bukti Merkle sah', proofsOk && /^0x[0-9a-f]{64}$/.test(f1.root));
  check('Ghost Credit: bukti palsu ditolak', !merkle.verifyProof(merkle.leafHash(A, H1, eA.creditMicro + 1), eA.proof, f1.root));
  check('Ghost Credit: diposting sekali + status posted', r1.status === 'posted' && posts.length === 1 && posts[0].root === f1.root &&
    posts[0].poolMicro === pool1 && posts[0].entries === 2 && posts[0].hour === H1 && r1.txHash === '0x' + '01'.repeat(32));
  const rawBuf = readFileSync(credit.hourFilePath(H1));
  check('uriHash = keccak256(berkas jam)', keccak256(rawBuf) === posts[0].uriHash && f1.uriHash === posts[0].uriHash);
  const accA = q.one('SELECT * FROM accounts WHERE wallet=?', A);
  check('akun pending dibuat + saldo dikreditkan', accA?.status === 'pending' && accA.balance_micro === expA);
  // Idempoten
  const r1b = await credit.runHour(H1, deps);
  check('idempoten: jalan ulang tidak posting/kredit dua kali', r1b.status === 'posted' && posts.length === 1 &&
    q.one('SELECT balance_micro b FROM accounts WHERE wallet=?', A).b === expA && q.one('SELECT COUNT(*) n FROM credits WHERE hour=?', H1).n === 2);

  // Jam H2: panen baru + sisa H1; ledger belum dikonfigurasi → pending; lalu dicoba lagi → posted
  const hv2 = await harvestOnce({ escrowBalance: async () => 10n ** 18n, claimAndSplit: fakeClaim(2n * 10n ** 17n), ethUsd: async () => 2500,
    feeAddress: feeWalletAddr, now: () => atHour(H2, 51) });
  const r2 = await credit.runHour(H2, { ...deps, ledger: null });
  const f2 = credit.ledgerHour(H2);
  check('jam berikut: pool = fee + sisa', f2.poolMicro === hv2.holderMicro + f1.carryOutMicro && f2.carryInMicro === f1.carryOutMicro);
  check('tanpa ledger → pending (sudah dikreditkan)', r2.status === 'pending' && posts.length === 1 && q.one('SELECT COUNT(*) n FROM credits WHERE hour=?', H2).n === 2);
  const r2b = await credit.runHour(H2, deps);
  check('pending dicoba ulang → posted', r2b.status === 'posted' && posts.length === 2 && posts[1].hour === H2);

  // ---------- Skrip verifikasi publik ----------
  const runTool = (args) => new Promise((res) => {
    const ch = spawn(process.execPath, ['--no-warnings', ...args], { env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = ''; ch.stdout.on('data', (d) => { out += d; }); ch.stderr.on('data', (d) => { out += d; });
    ch.on('close', (code) => res({ code, out }));
  });
  let t = await runTool([join(ROOT, 'tools/verify/recompute-hour.mjs'), '--file', credit.hourFilePath(H1)]);
  check('recompute-hour.mjs: jam H1 cocok (exit 0)', t.code === 0 && /0 failed/.test(t.out), t.out.split('\n').filter((l) => /FAIL/.test(l)).join(' | '));
  const tampered = join(DATA, 'tampered.json');
  const tj = JSON.parse(readFileSync(credit.hourFilePath(H1), 'utf8')); tj.entries[0].creditMicro += 1;
  (await import('node:fs')).writeFileSync(tampered, JSON.stringify(tj, null, 2));
  t = await runTool([join(ROOT, 'tools/verify/recompute-hour.mjs'), '--file', tampered]);
  check('recompute-hour.mjs: berkas diubah → gagal (exit 1)', t.code === 1);
  t = await runTool([join(ROOT, 'tools/verify/compare-prices.mjs'), B]);
  check('compare-prices.mjs: semua tarif sama + ZDR (exit 0)', t.code === 0, t.out.split('\n').slice(1, 4).join(' |'));

  // ---------- API Ghost Credit ----------
  ({ j } = await get('/api/ledger?limit=48'));
  check('/api/ledger', Array.isArray(j) && j.length === 3 && j[0].hour === H2 && ['hour', 'poolUsd', 'entries', 'root', 'txHash', 'feeTxs', 'status'].every((k) => k in j[0]) &&
    j.find((x) => x.hour === H0).status === 'no_fees' && j.find((x) => x.hour === H1).feeTxs.length === 3, J(j[0]));
  ({ j } = await get(`/api/ledger/${H1}`));
  check('/api/ledger/:hour = isi berkas + status', j.hour === H1 && j.root === f1.root && j.entries.length === 2 && j.txHash === r1.txHash && j.status === 'posted');
  const raw = await fetch(`${B}/api/ledger/${H1}/raw`);
  check('/api/ledger/:hour/raw = bita persis', keccak256(new Uint8Array(await raw.arrayBuffer())) === f1.uriHash);
  ({ r } = await get('/api/ledger/12'));
  check('/api/ledger jam tak ada → 404', r.status === 404);
  ({ j } = await get(`/api/holder/${A}`));
  check('/api/holder: kredit + bukti + txHash', j.wallet === A && j.balanceNow === null && j.eligibleNow === null && j.credits.length === 2 &&
    j.credits.some((c) => c.hour === H1 && c.txHash === r1.txHash && c.proof?.length >= 1 && c.root === f1.root) && j.totalCreditedUsd > 0, J(j).slice(0, 200));
  ({ j } = await get(`/api/holder/${TEAM}`));
  check('/api/holder dompet tim: excluded', j.excluded === true && j.credits.length === 0);
  ({ r } = await get('/api/holder/0x123'));
  check('/api/holder alamat tak sah → 400', r.status === 400);

  // Akun Ghost Credit masuk pertama kali → jadi aktif dengan saldonya
  ({ j } = await get('/api/stats'));
  const accountsBefore = j.accounts;
  check('/api/stats bentuk + angka dari DB', j.messages >= 20 && j.tokensServed > 0 && j.billedUsd > 0 && j.hoursPosted === 2 && j.lastHour?.hour === H2 &&
    Math.abs(j.holderCreditPaidUsd - (f1.distributedMicro + f2.distributedMicro) / 1e6) < 1e-9 && typeof j.updatedAt === 'number', J(j).slice(0, 220));
  check('/api/stats: akun pending tidak dihitung', accountsBefore === 2);

  // ---------- /api/proof & /proof ----------
  ({ j } = await get('/api/proof'));
  check('/api/proof: kontrak belum ada = null, dompet terisi', j.contracts.ledger === null && j.contracts.token === null && j.wallets.fee === null &&
    j.wallets.treasury.address === TREASURY && j.wallets.treasury.url.endsWith(`/address/${TREASURY}`) && j.wallets.team[0].address === TEAM &&
    j.split.holderShareBps === 2500 && j.latestHours.length === 3 && j.harvests.length === 2 && j.code.privacy.endsWith('server/privacy.mjs'));
  ({ r } = await get('/proof'));
  const html = await r.text();
  const csp = r.headers.get('content-security-policy') || '';
  check('/proof render server', r.status === 200 && html.includes('Check every claim yourself') && html.includes('Not deployed yet') &&
    html.includes('Launches soon') && html.includes(TREASURY) && html.includes(r1.txHash.slice(0, 10)) && !/Holder Credit|Mothpoint/.test(html));
  check('/proof CSP: frame-ancestors none + hash skrip sebaris', /frame-ancestors 'none'/.test(csp) && /'sha256-/.test(csp) && !/script-src[^;]*unsafe-inline/.test(csp) &&
    csp.includes('https://cdn.jsdelivr.net') && csp.includes('https://rpc.mainnet.chain.robinhood.com') && r.headers.get('cache-control') === 'no-store');

  // ---------- Statis & lain-lain ----------
  ({ r } = await get('/css/base.css'));
  check('/css/base.css + no-cache (selalu dicek ulang)', r.status === 200 && /no-cache/.test(r.headers.get('cache-control') || ''));
  ({ r } = await get('/server/config.mjs'));
  check('kode server tidak bisa diunduh', r.status === 404);
  ({ r } = await get('/../.env'));
  check('path traversal ditolak', r.status === 404);
  ({ r } = await get('/api/nope'));
  check('API tak dikenal → 404 JSON', r.status === 404 && (await r.json()).error === 'not_found');
  ({ r } = await post('/api/admin/run-hour', { hour: H0 }));
  check('admin tanpa kunci → 403', r.status === 403);
  const opt = await fetch(B + '/v1/chat/completions', { method: 'OPTIONS' });
  check('CORS preflight /v1', opt.status === 204 && opt.headers.get('access-control-allow-origin') === '*');
  ({ r } = await get('/api/me', { Origin: 'https://evil.example' }));
  check('rute sesi tanpa CORS', !r.headers.get('access-control-allow-origin'));
  // Masuk dengan dompet A (akun Ghost Credit pending) → aktif, saldo kredit terlihat
  const credsA = q.one('SELECT balance_micro b FROM accounts WHERE wallet=?', A).b;
  check('saldo A = jumlah kredit 2 jam', credsA === f1.entries.find((e) => e.wallet === A).creditMicro + f2.entries.find((e) => e.wallet === A).creditMicro);

  // ---------- Opsional: GhostLedger asli di anvil + server/chain/ledger.mjs asli ----------
  const anvilBin = [join(process.env.HOME || '', '.foundry/bin/anvil'), 'anvil'].find((p) => { try { return readFileSync(p) && true; } catch { return p === 'anvil'; } });
  const artifact = join(ROOT, 'contracts/out/GhostLedger.sol/GhostLedger.json');
  let anvil = null;
  try { readFileSync(artifact); anvil = spawn(anvilBin, ['--port', '8879', '--silent'], { stdio: 'ignore' }); } catch {}
  if (anvil) {
    anvil.on('error', () => {});
    try {
      const { JsonRpcProvider, ContractFactory, Wallet: W } = await import('ethers');
      const prov = new JsonRpcProvider('http://127.0.0.1:8879', 31337, { cacheTimeout: -1, staticNetwork: true });
      let up = false;
      for (let i = 0; i < 50 && !up; i++) { try { await prov.getBlockNumber(); up = true; } catch { await new Promise((r) => setTimeout(r, 200)); } }
      if (!up) throw new Error('anvil tidak menyala');
      const signer = new W('0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80', prov);   // akun uji bawaan anvil #0
      const art = JSON.parse(readFileSync(artifact, 'utf8'));
      const c = await new ContractFactory(art.abi, art.bytecode.object ?? art.bytecode, signer).deploy(signer.address);
      await c.waitForDeployment();
      process.env.LEDGER_ADDRESS = await c.getAddress();
      process.env.LEDGER_RPC = 'http://127.0.0.1:8879';
      const realLedger = await import('../server/chain/ledger.mjs');
      const H3 = nowH - 3;
      await harvestOnce({ escrowBalance: async () => 10n ** 18n, claimAndSplit: fakeClaim(3n * 10n ** 17n), ethUsd: async () => 2000,
        feeAddress: feeWalletAddr, now: () => atHour(H3, 50) });
      const r3 = await credit.runHour(H3, { ...deps, ledger: realLedger, signer });
      const f3 = credit.ledgerHour(H3);
      const onChain = await realLedger.readHour(H3);
      check('anvil: jam diposting ke GhostLedger asli', r3.status === 'posted' && /^0x[0-9a-f]{64}$/i.test(r3.txHash) && onChain?.root === f3.root &&
        Number(onChain.poolMicro) === f3.poolMicro && onChain.entries === f3.entries.length, r3.txHash);
      const oks = await Promise.all(f3.entries.map((e) => realLedger.verifyOnChain({ hour: H3, wallet: e.wallet, creditMicro: e.creditMicro, proof: e.proof })));
      const forged = await realLedger.verifyOnChain({ hour: H3, wallet: f3.entries[0].wallet, creditMicro: f3.entries[0].creditMicro + 1, proof: f3.entries[0].proof });
      check('anvil: verify() on-chain menerima bukti asli, menolak palsu', oks.every(Boolean) && forged === false);
      const again3 = await credit.runHour(H3, { ...deps, ledger: realLedger, signer });
      check('anvil: jalan ulang tidak posting dua kali', again3.status === 'posted' && again3.txHash === r3.txHash);
      const t3 = await new Promise((res) => {
        const ch = spawn(process.execPath, ['--no-warnings', join(ROOT, 'tools/verify/recompute-hour.mjs'), '--base', B, '--hour', String(H3),
          '--ledger', process.env.LEDGER_ADDRESS, '--rpc', 'http://127.0.0.1:8879'], { stdio: ['ignore', 'pipe', 'pipe'] });
        let out = ''; ch.stdout.on('data', (d) => { out += d; }); ch.stderr.on('data', (d) => { out += d; });
        ch.on('close', (code) => res({ code, out }));
      });
      check('anvil: recompute-hour.mjs cocok dengan rantai (root + uriHash)', t3.code === 0 && /OK +Posted\.uriHash/.test(t3.out) && /OK +on-chain root/.test(t3.out),
        t3.out.split('\n').filter((l) => /FAIL|skipped/.test(l)).join(' | '));
    } catch (e) {
      check('anvil: integrasi ledger asli', false, e.message);
    } finally { anvil.kill(); delete process.env.LEDGER_ADDRESS; delete process.env.LEDGER_RPC; }
  } else console.log('· anvil/artefak kontrak tidak ada — uji GhostLedger asli dilewati');
} catch (e) {
  bad++;
  console.error('✗ pengecualian:', e);
  console.error(serverLog.slice(-2000));
} finally {
  stop();
  try { rmSync(DATA, { recursive: true, force: true }); } catch {}
}

console.log(`\n${ok} lolos, ${bad} gagal`);
process.exit(bad ? 1 : 0);
