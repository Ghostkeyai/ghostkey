// Halaman akun: masuk dompet, saldo, isi saldo (kutipan → bayar → konfirmasi), kunci API, pemakaian,
// Ghost Credit yang diterima, dan unduhan "semua yang kami simpan" (/api/me/export).
import {
  api, getConfig, chrome, me, signIn, signOut, connect, provider, payEth, payUsdg,
  usd, int, short, ago, when, hourLabel, esc, copy, toast, txUrl, addrUrl, pix, paintIcons, downloadJson, isHash,
} from '/js/common.js';

const $ = (s, el = document) => el.querySelector(s);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const PENDING = 'gk_pending_tx';             // hash setoran yang belum selesai dikonfirmasi (hanya di browser ini)

let cfg = {};
let acct = null;
let asset = 'ETH';
let lastQuote = null;
let quoteSeq = 0;
let busy = false;
let newKey = null;                           // kunci penuh yang baru dibuat (sekali tampil, hanya di memori)

async function init() {
  paintIcons();
  [cfg, acct] = await Promise.all([getConfig(), me()]);
  $('#head-out').hidden = !!acct;
  $('#head-in').hidden = !acct;
  $('#connect').onclick = doSignIn;
  bindTopup();
  renderKey();
  renderCurl();
  renderCredit();
  renderExport();
  if (acct) {
    renderHead();
    $('#signout').onclick = () => signOut();
    $('#usage-refresh').hidden = false;
    $('#usage-refresh').onclick = () => loadUsage();
    loadUsage();
    // Lanjutkan konfirmasi setoran yang tertunda (mis. tab sempat ditutup)
    const p = readPending();
    if (p && p.wallet?.toLowerCase() === acct.wallet.toLowerCase()) trackDeposit(p.hash, { fresh: true, resumed: true });
  } else {
    $('#usage-body').innerHTML = `<div class="empty">${pix('ghost', 40)}<span>Sign in to see your usage. Each row shows tokens and cost, never your messages.</span></div>`;
  }
  if (location.hash) document.querySelector(location.hash)?.scrollIntoView();
}

async function doSignIn() {
  const err = $('#connect-err');
  err.hidden = true;
  try {
    await signIn();
    location.reload();
  } catch (e) {
    if (e?.message) { err.textContent = e.message; err.hidden = false; toast(e.message); }
  }
}

// ---------- Kepala ----------
function balHtml(v) {
  const micro = Math.round(Number(v || 0) * 1e6);
  const a = Math.abs(micro);
  const dollars = Math.floor(a / 1e6);
  const rest = String(a % 1e6).padStart(6, '0');
  return `${micro < 0 ? '−' : ''}$${dollars.toLocaleString('en-US')}.${rest.slice(0, 2)}<span class="c">${rest.slice(2)}</span>`;
}
function renderHead() {
  $('#bal').innerHTML = balHtml(acct.balanceUsd);
  $('#bal').title = `$${Number(acct.balanceUsd || 0).toFixed(6)}`;
  $('#h-wallet').textContent = acct.wallet;
  $('#h-scan').href = addrUrl(acct.wallet);
  $('#h-copy').innerHTML = pix('copy', 14);
  $('#h-copy').onclick = () => copy(acct.wallet, 'Wallet address copied');
  $('#h-credit').textContent = usd(acct.holder?.creditedUsd ?? 0, { max: 2 });
}

// ---------- Isi saldo ----------
const MIN = () => Number(cfg.minDepositUsd ?? 5);
const MAX = () => Number(cfg.maxDepositUsd ?? 2000);

function bindTopup() {
  const inp = $('#amt');
  inp.addEventListener('input', scheduleQuote);
  inp.addEventListener('blur', () => { const v = readAmount(); if (Number.isFinite(v) && v > 0) inp.value = String(Math.round(v * 100) / 100); });
  $('#quick').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-v]'); if (!b) return;
    inp.value = b.dataset.v; loadQuote();
  });
  $('#asset').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-a]'); if (!b) return;
    asset = b.dataset.a;
    for (const x of $('#asset').querySelectorAll('button')) x.setAttribute('aria-pressed', String(x === b));
    renderQuote(lastQuote); updatePay();
  });
  $('#pay').addEventListener('click', () => (acct ? doPay() : doSignIn()));
  $('#paste-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const h = $('#paste-hash').value.trim();
    if (!isHash(h)) { showPayErr('That is not a transaction hash. It starts with 0x and has 64 characters after it.'); return; }
    if (!acct) { showPayErr('Sign in with the wallet that sent the payment first.'); return; }
    trackDeposit(h, { fresh: false });
  });
  loadQuote();
  // Harga ETH bergerak: segarkan kutipan tiap 60 detik selama halaman terbuka
  setInterval(() => { if (!busy && document.visibilityState === 'visible') loadQuote(); }, 60_000);
}

function readAmount() {
  const raw = $('#amt').value.replace(/[$,\s]/g, '');
  if (!raw) return NaN;
  const v = Number(raw);
  return Number.isFinite(v) ? v : NaN;
}
let qTimer;
function scheduleQuote() { clearTimeout(qTimer); qTimer = setTimeout(loadQuote, 220); }

async function loadQuote() {
  const v = readAmount();
  const ok = v >= MIN() && v <= MAX();
  $('#amt-box').classList.toggle('bad', !ok);
  $('#amt-hint').textContent = ok
    ? `Any amount from ${usd(MIN(), { max: 0 })} to ${usd(MAX(), { max: 0 })} per top-up.`
    : `Enter an amount from ${usd(MIN(), { max: 0 })} to ${usd(MAX(), { max: 0 })}.`;
  for (const b of $('#quick').querySelectorAll('button')) b.setAttribute('aria-pressed', String(Number(b.dataset.v) === v));
  if (!ok) { lastQuote = null; renderQuote(null); updatePay(); return; }
  const seq = ++quoteSeq;
  const amount = Math.round(v * 100) / 100;
  try {
    const q = await api(`/api/deposit/quote?usd=${amount}`);
    if (seq !== quoteSeq) return;
    lastQuote = { ...q, usd: Number(q.usd ?? q.creditUsd ?? amount) };
  } catch (e) {
    if (seq !== quoteSeq) return;
    lastQuote = null;
    $('#q-src').textContent = `Quote unavailable right now (${e.message}).`;
  }
  renderQuote(lastQuote);
  updatePay();
}

function renderQuote(q) {
  if (!q) {
    for (const id of ['#q-pay', '#q-credit', '#q-eth']) $(id).textContent = '—';
    $('#q-fee').textContent = '0% · $0.00';
    return;
  }
  const fee = Number(q.feeBps ?? 0);
  const payEthN = Number(q.payEth);
  $('#q-pay').innerHTML = asset === 'ETH'
    ? (payEthN ? `${payEthN.toFixed(6)} ETH<small>${usd(q.usd)}</small>` : 'ETH price unavailable')
    : `${Number(q.payUsdg ?? q.usd).toFixed(2)} USDG<small>valued 1:1 with USD</small>`;
  $('#q-fee').textContent = `${(fee / 100).toFixed(fee % 100 ? 1 : 0)}% · ${usd((q.usd * fee) / 10000)}`;
  $('#q-credit').textContent = usd(q.creditUsd ?? q.usd);
  $('#q-eth').textContent = q.ethUsd ? usd(q.ethUsd) : '—';
  $('#q-src').innerHTML = `Live from the server: <a href="/api/deposit/quote?usd=${q.usd}" target="_blank" rel="noopener">/api/deposit/quote?usd=${q.usd} ↗</a>`;
}

function updatePay() {
  const btn = $('#pay');
  const to = $('#pay-to');
  const treasury = lastQuote?.treasury || cfg.treasury;
  $('#closed').hidden = !!treasury;
  $('#paste-form').hidden = !treasury;
  if (!treasury) { btn.disabled = true; btn.textContent = 'Top-ups open at launch'; to.innerHTML = ''; return; }
  to.innerHTML = `to the GHOSTKEY treasury <a class="link mono" href="${addrUrl(treasury)}" target="_blank" rel="noopener">${short(treasury)}</a>`;
  if (!acct) { btn.disabled = false; btn.textContent = 'Connect wallet to pay'; return; }
  if (busy) { btn.disabled = true; return; }
  if (!lastQuote) { btn.disabled = true; btn.textContent = 'Pay'; return; }
  if (asset === 'ETH' && !Number(lastQuote.payEth)) { btn.disabled = true; btn.textContent = 'ETH price unavailable'; return; }
  btn.disabled = false;
  btn.textContent = asset === 'ETH' ? `Pay ${Number(lastQuote.payEth).toFixed(6)} ETH` : `Pay ${Number(lastQuote.payUsdg ?? lastQuote.usd).toFixed(2)} USDG`;
}

// "0.011693" ETH → wei (BigInt) tanpa pembulatan floating point
function ethToWei(x) {
  const [i, f = ''] = Number(x).toFixed(8).split('.');
  return BigInt(i) * 10n ** 18n + BigInt((f + '0'.repeat(18)).slice(0, 18));
}
function showPayErr(msg) { const e = $('#pay-err'); e.textContent = msg; e.hidden = !msg; }

async function doPay() {
  showPayErr('');
  if (busy) return;
  busy = true;
  const btn = $('#pay');
  btn.disabled = true; btn.textContent = 'Preparing…';
  try {
    await loadQuote();                       // harga ETH terbaru tepat sebelum membayar
    const q = lastQuote;
    const treasury = q?.treasury || cfg.treasury;
    if (!q || !treasury) throw new Error('Enter a valid amount first.');
    if (asset === 'ETH' && !Number(q.payEth)) throw new Error('ETH price unavailable right now. Try USDG or retry in a minute.');
    btn.textContent = 'Confirm in your wallet…';
    if (!provider()) await connect();
    const [from] = await provider().request({ method: 'eth_accounts' });
    if (!from || from.toLowerCase() !== acct.wallet.toLowerCase()) {
      throw new Error(`Your wallet is on ${from ? short(from) : 'no account'}, but you are signed in as ${short(acct.wallet)}. Top-ups count only from the signed-in wallet. Switch accounts in your wallet and try again.`);
    }
    const hash = asset === 'ETH'
      ? await payEth(treasury, ethToWei(q.payEth))
      : await payUsdg(treasury, BigInt(Math.round(Number(q.payUsdg ?? q.usd) * 1e6)));
    if (!isHash(hash)) throw new Error('The wallet did not return a transaction hash.');
    busy = false;
    trackDeposit(hash, { fresh: true });
  } catch (e) {
    const rejected = e?.code === 4001 || e?.code === 'ACTION_REJECTED' || /reject|denied/i.test(e?.message || '');
    showPayErr(rejected ? 'You rejected the request in your wallet. Nothing was sent.' : String(e?.message || 'Payment failed.').slice(0, 300));
  } finally {
    busy = false;
    updatePay();
  }
}

const DEP_ERR = {
  not_found: 'Robinhood Chain does not show this transaction yet. Check the hash. If your wallet shows it as sent, wait a minute and confirm again.',
  wrong_sender: 'This payment came from a different wallet than the one you are signed in with, so it cannot be added to this account.',
  wrong_recipient: 'This transaction did not pay the GHOSTKEY treasury in ETH or USDG.',
  failed: 'This transaction failed on-chain. Nothing was sent, nothing was added.',
  below_minimum: 'This payment is below the minimum top-up, so it was not added. Contact the team with the hash.',
  already_credited: 'This transaction was already added to a balance.',
  bad_tx: 'That is not a valid transaction hash.',
  deposits_closed: 'Top-ups are not open yet.',
  sign_in: 'Your session ended. Sign in again with the paying wallet.',
  server_error: 'The server could not reach Robinhood Chain right now. Try again in a minute.',
  network: 'Could not reach the GHOSTKEY server. Check your connection and try again.',
};

function readPending() { try { return JSON.parse(localStorage.getItem(PENDING) || 'null'); } catch { return null; } }
function writePending(v) { try { v ? localStorage.setItem(PENDING, JSON.stringify(v)) : localStorage.removeItem(PENDING); } catch {} }

let run = null;                              // penanda loop konfirmasi yang aktif
function step(name, cls, right) {
  const li = $(`#dep-steps li[data-s="${name}"]`);
  li.className = cls || '';
  if (right !== undefined) li.querySelector('span:last-child').innerHTML = right;
}

async function trackDeposit(hash, { fresh, resumed = false }) {
  const mine = (run = {});
  writePending({ hash, wallet: acct.wallet, at: Date.now() });
  $('#dep').hidden = false;
  showPayErr('');
  step('sent', 'done', `<a class="link" href="${txUrl(hash)}" target="_blank" rel="noopener">${short(hash, 8, 6)}</a>`);
  step('conf', 'now', '');
  step('cred', '', '');
  const msg = $('#dep-msg');
  msg.className = '';
  msg.innerHTML = resumed ? '<p class="hint">Picking up your last payment where it left off.</p>' : '';
  const started = Date.now();
  const nfMax = fresh ? 10 : 2;              // RPC bisa beberapa detik belum melihat tx yang baru dikirim
  let notFound = 0, netErr = 0;
  while (run === mine) {
    let r = null, err = null;
    try { r = await api('/api/deposit/confirm', { method: 'POST', body: { txHash: hash } }); } catch (e) { err = e; }
    if (run !== mine) return;
    const code = err ? (err.body?.error || (err.status === 429 ? 'slow_down' : err.status ? 'server_error' : 'network')) : r?.error;
    if (!code && r) return depositDone(hash, r);
    const elapsed = Math.round((Date.now() - started) / 1000);
    const wait = code === 'pending' || code === 'too_few_confirmations' || code === 'slow_down'
      || (code === 'not_found' && ++notFound <= nfMax) || ((code === 'network' || code === 'server_error') && ++netErr <= 3);
    if (wait && Date.now() - started < 15 * 60_000) {
      const label = code === 'not_found' ? 'waiting for the network' : code === 'pending' ? 'in mempool' : code === 'too_few_confirmations' ? 'confirming' : 'retrying';
      step('conf', 'now', `${label} · ${elapsed}s`);
      await sleep(code === 'slow_down' ? 8000 : 4000);
      continue;
    }
    return depositFailed(hash, wait ? 'timeout' : code);
  }
}

function depositDone(hash, r) {
  run = null;
  writePending(null);
  step('conf', 'done', 'confirmed');
  step('cred', 'done', `+${usd(r.creditedUsd)}`);
  const msg = $('#dep-msg');
  msg.className = 'notice good';
  msg.innerHTML = `<b>Added ${usd(r.creditedUsd)}</b> to your balance. Fee: $0.00. New balance <span class="mono">${usd(r.balanceUsd)}</span>.`;
  toast(`Added ${usd(r.creditedUsd)}`);
  if (acct && r.balanceUsd != null) { acct.balanceUsd = r.balanceUsd; renderHead(); }
  me(true).then((m) => { if (m) { acct = m; renderHead(); } });
}

function depositFailed(hash, code) {
  run = null;
  const terminal = code !== 'timeout' && code !== 'server_error' && code !== 'network';
  if (terminal) writePending(null);
  step('conf', 'fail', code === 'timeout' ? 'still pending' : esc(code || 'error'));
  const msg = $('#dep-msg');
  msg.className = 'notice bad';
  const text = code === 'timeout'
    ? 'Still not confirmed after 15 minutes. If it was sent, your payment is safe on-chain. Confirm it later with the hash.'
    : (DEP_ERR[code] || `Could not confirm this payment (${esc(code)}).`);
  msg.innerHTML = `${text}<div style="margin-top:10px;display:flex;gap:8px;flex-wrap:wrap"><button class="btn small" data-retry type="button">Try again</button><button class="btn small ghost" data-dismiss type="button">Dismiss</button></div>`;
  msg.querySelector('[data-retry]').onclick = () => trackDeposit(hash, { fresh: false });
  msg.querySelector('[data-dismiss]').onclick = () => { writePending(null); $('#dep').hidden = true; };
  $('#paste-hash').value = hash;
}

// ---------- Kunci API ----------
function renderCurl() {
  const key = newKey || '$GHOSTKEY_API_KEY';
  const pre = $('#key-curl');
  pre.innerHTML = `<span class="c"># any OpenAI SDK works: change the base URL</span>
curl ${esc(location.origin)}/v1/chat/completions \\
  -H <span class="s">"Authorization: Bearer ${esc(key)}"</span> \\
  -H <span class="s">"Content-Type: application/json"</span> \\
  -d <span class="s">'{"model":"openai/gpt-4o-mini",
       "messages":[{"role":"user","content":"Hello"}]}'</span>`;
  $('#key-cp').onclick = () => copy(pre.textContent, 'Command copied');
}

function keyList() {
  if (Array.isArray(acct?.apiKeys)) return acct.apiKeys;
  return acct?.apiKeyPrefix ? [{ prefix: acct.apiKeyPrefix }] : [];
}

function renderKey() {
  const el = $('#key-body');
  if (!acct) {
    el.innerHTML = `<div class="panel-h">${pix('key', 18)} Your API key</div>
      <p class="body-p" style="margin-top:8px">Making a key is free. New accounts get ${int(cfg.freeMessages ?? 10)} free API calls on low-cost models, so you can test before you top up.</p>
      <div style="display:flex;gap:10px;flex-wrap:wrap;margin-top:18px"><button class="btn small" data-signin type="button">Sign in to create a key</button><a class="btn small ghost" href="/docs">Read the docs</a></div>`;
    el.querySelector('[data-signin]').onclick = doSignIn;
    return;
  }
  const keys = keyList();
  let html = `<div class="panel-h">${pix('key', 18)} Your API keys</div>`;
  if (newKey) {
    html += `<div class="notice warn" style="margin-top:12px"><b>Copy this key now.</b> It is shown once. We keep only a hash of it.</div>
      <div class="secret"><code>${esc(newKey)}</code><button class="btn small" data-copy type="button">Copy</button></div>`;
  }
  html += keys.length
    ? `<div class="keys-list table-scroll"><table class="table"><thead><tr><th>Key</th><th class="r">Created</th><th class="r"></th></tr></thead><tbody>
        ${keys.map((k) => `<tr><td class="mono">${esc(k.prefix)}…</td><td class="r num">${k.createdAt ? `${ago(k.createdAt)}<span class="sub">${when(k.createdAt)}</span>` : '—'}</td><td class="r"><button class="linkbtn" type="button" data-revoke="${esc(k.prefix)}">Revoke</button></td></tr>`).join('')}
      </tbody></table></div>`
    : '<p class="body-p" style="margin-top:8px">No key yet. Create one to call the API.</p>';
  html += `<p class="hint" style="margin-top:12px">Each key bills your balance at OpenRouter's price. With a $0 balance, a new account gets ${int(cfg.freeApiCalls ?? cfg.freeMessages ?? 10)} free calls on low-cost models.${acct.apiFreeLeft != null ? ` <b style="color:var(--ink);font-weight:500">Free calls left: ${int(acct.apiFreeLeft)}.</b>` : ''}</p>
    <div style="margin-top:16px"><button class="btn small" data-make type="button">${keys.length ? 'Create another key' : 'Create API key'}</button></div>`;
  el.innerHTML = html;
  el.querySelector('[data-copy]')?.addEventListener('click', () => copy(newKey, 'API key copied'));
  const mk = el.querySelector('[data-make]');
  mk.onclick = () => makeKey(mk);
  for (const b of el.querySelectorAll('[data-revoke]')) b.onclick = () => revokeKey(b);
}

// Cabut kunci: konfirmasi dua langkah (tanpa dialog bawaan browser)
async function revokeKey(btn) {
  if (btn.dataset.arm !== '1') {
    btn.dataset.arm = '1'; btn.textContent = 'Sure? It stops working';
    setTimeout(() => { if (btn.isConnected && btn.dataset.arm === '1') { btn.dataset.arm = ''; btn.textContent = 'Revoke'; } }, 5000);
    return;
  }
  btn.disabled = true;
  try {
    await api('/api/me/apikey/revoke', { method: 'POST', body: { prefix: btn.dataset.revoke } });
    acct.apiKeys = keyList().filter((k) => k.prefix !== btn.dataset.revoke);
    if (newKey && newKey.startsWith(btn.dataset.revoke)) newKey = null;
    renderKey(); renderCurl();
    toast('Key revoked');
  } catch (e) {
    btn.disabled = false;
    toast(e.status === 401 ? 'Session ended. Sign in again.' : `Could not revoke: ${e.message}`);
  }
}

async function makeKey(btn) {
  btn.disabled = true;
  try {
    const r = await api('/api/me/apikey', { method: 'POST' });
    newKey = r.apiKey;
    const fresh = await me(true);
    if (fresh) acct = fresh;
    const prefix = r.prefix || newKey.slice(0, 14);
    if (!keyList().some((k) => k.prefix === prefix)) acct.apiKeys = [...keyList(), { prefix, createdAt: Date.now() }];
    renderKey(); renderCurl();
    toast('New API key created');
  } catch (e) {
    btn.disabled = false;
    toast(e.status === 401 ? 'Session ended. Sign in again.' : `Could not create a key: ${e.message}`);
  }
}

// ---------- Pemakaian ----------
const SRC = { free: 'Free', chat: 'Chat', web: 'Chat', api: 'API' };
async function loadUsage() {
  const body = $('#usage-body');
  body.innerHTML = '<p class="loading-line">Loading usage</p>';
  let rows;
  try { rows = await api('/api/me/usage'); }
  catch (e) { body.innerHTML = `<div class="notice bad">Could not load usage (${esc(e.message)}).</div>`; return; }
  if (!Array.isArray(rows)) rows = rows?.rows || [];
  const sum = rows.reduce((a, u) => ({ n: a.n + 1, i: a.i + Number(u.tokensIn || 0), o: a.o + Number(u.tokensOut || 0), c: a.c + Number(u.costUsd || 0) }), { n: 0, i: 0, o: 0, c: 0 });
  $('#usage-tot').innerHTML = rows.length
    ? `<div class="usage-tot"><div>Calls<b>${int(sum.n)}</b></div><div>Tokens in<b>${int(sum.i)}</b></div><div>Tokens out<b>${int(sum.o)}</b></div><div>Cost<b>${usd(sum.c)}</b></div></div>`
    : '';
  if (!rows.length) {
    body.innerHTML = `<div class="empty">${pix('ghost', 40)}<span>No usage yet. Messages you send in <a class="link" href="/app">Chat</a> or through the API show up here with tokens and exact cost.</span></div>`;
    return;
  }
  body.innerHTML = `<div class="table-scroll"><table class="table">
    <thead><tr><th>Time</th><th>Model</th><th class="r hide-m">Tokens in</th><th class="r hide-m">Tokens out</th><th class="r">Cost</th><th class="hide-m">Via</th></tr></thead>
    <tbody>${rows.map((u) => `<tr>
      <td class="num" title="${esc(when(u.at))}">${ago(u.at)}<span class="sub">${when(u.at)}</span></td>
      <td><span class="mono" style="font-size:13px;overflow-wrap:anywhere">${esc(u.model)}</span><span class="sub">${int(u.tokensIn)} in · ${int(u.tokensOut)} out</span></td>
      <td class="r num hide-m">${int(u.tokensIn)}</td>
      <td class="r num hide-m">${int(u.tokensOut)}</td>
      <td class="r num">${usd(u.costUsd, { max: 6 })}</td>
      <td class="hide-m"><span class="tag${u.source === 'free' ? ' gold' : ''}">${esc(SRC[u.source] || u.source || '—')}</span></td>
    </tr>`).join('')}</tbody></table></div>`;
}

// ---------- Ghost Credit ----------
async function renderCredit() {
  const el = $('#credit-body');
  if (!acct) {
    el.innerHTML = `<div class="empty">${pix('coin', 32)}<span>Sign in to see the Ghost Credit paid to your wallet. Or <a class="link" href="/token#check">check any wallet</a> without signing in.</span></div>`;
    return;
  }
  const h = acct.holder || {};
  const head = `<div class="grid-3" style="margin-bottom:16px">
    <div class="panel"><span class="label">$GHOST held now</span><div class="bignum" style="font-size:30px;margin-top:12px">${cfg.ghostToken && h.ghost != null ? int(Math.floor(Number(h.ghost))) : '—'}</div><p class="hint" style="margin-top:8px">${cfg.ghostToken ? 'Read from the token contract.' : '$GHOST is not launched yet.'}</p></div>
    <div class="panel"><span class="label">Eligible this hour</span><div class="bignum" style="font-size:30px;margin-top:12px">${h.eligible == null ? '—' : h.eligible ? 'Yes' : 'No'}</div><p class="hint" style="margin-top:8px">Needs an average of ${int(cfg.minTokens ?? 100000)} $GHOST over the hour.</p></div>
    <div class="panel"><span class="label">Total received</span><div class="bignum" style="font-size:30px;margin-top:12px">${usd(h.creditedUsd ?? 0, { max: 2 })}</div><p class="hint" style="margin-top:8px">Added to your balance as AI credit.</p></div>
  </div>`;
  el.innerHTML = head + '<p class="loading-line">Loading your Ghost Credit history</p>';
  let r = null;
  try { r = await api(`/api/holder/${acct.wallet}`); } catch {}
  const credits = r?.credits || [];
  el.innerHTML = head + (credits.length
    ? `<div class="table-scroll"><table class="table"><thead><tr><th>Hour</th><th class="r">Credit</th><th class="hide-m">Merkle root</th><th>Check it</th></tr></thead><tbody>
        ${credits.map((c) => `<tr>
          <td class="num">${esc(hourLabel(c.hour))}<span class="sub">hour #${esc(c.hour)}</span></td>
          <td class="r num">${usd(c.creditUsd, { max: 6 })}</td>
          <td class="mono hide-m" style="font-size:12.5px">${esc(short(c.root || '', 10, 6))}</td>
          <td><div style="display:flex;gap:12px;flex-wrap:wrap">${c.txHash ? `<a class="proof-link" href="${txUrl(c.txHash)}" target="_blank" rel="noopener">Posted tx</a>` : '<span class="tag gold">Not posted yet</span>'}<a class="proof-link" href="/token?wallet=${esc(acct.wallet)}&hour=${esc(c.hour)}#check">Verify on-chain</a></div></td>
        </tr>`).join('')}</tbody></table></div>`
    : `<div class="empty">${pix('coin', 32)}<span>No Ghost Credit for this wallet yet. It is paid each hour to wallets holding at least ${int(cfg.minTokens ?? 100000)} $GHOST on average.</span></div>`);
}

// ---------- Ekspor ----------
function renderExport() {
  const el = $('#export-body');
  if (!acct) {
    el.innerHTML = `<p class="body-p">Sign in to download your file. It is built from the database at the moment you ask for it.</p>
      <button class="btn small" style="margin-top:16px" data-signin type="button">Sign in</button>`;
    el.querySelector('[data-signin]').onclick = doSignIn;
    return;
  }
  el.innerHTML = `<p class="body-p">The file is built from our database the moment you click. You can also open the raw data in a new tab.</p>
    <div style="display:flex;gap:12px;flex-wrap:wrap;align-items:center;margin-top:16px">
      <button class="btn" id="export-btn" type="button">${pix('down', 14)} Download my data</button>
      <a class="proof-link" href="/api/me/export" target="_blank" rel="noopener">Open raw JSON</a>
    </div>
    <div class="export-sum" id="export-sum"></div>`;
  $('#export-btn').onclick = doExport;
}

async function doExport() {
  const btn = $('#export-btn');
  btn.disabled = true;
  try {
    const data = await api('/api/me/export');
    downloadJson(data, `ghostkey-${acct.wallet.slice(0, 8).toLowerCase()}-${new Date().toISOString().slice(0, 10)}.json`);
    // Ringkasan isi berkas: nama bagian + jumlah baris, supaya mudah diperiksa
    const parts = Object.entries(data || {}).map(([k, v]) => `<div><dt>${esc(k)}</dt><dd>${Array.isArray(v) ? `${int(v.length)} row${v.length === 1 ? '' : 's'}` : v && typeof v === 'object' ? `${Object.keys(v).length} fields` : esc(String(v)).slice(0, 40)}</dd></div>`).join('');
    const text = JSON.stringify(data);
    const hasChat = /"(content|prompt|messages|completion)"\s*:/.test(text);
    $('#export-sum').innerHTML = `<dl class="kv" style="margin-top:18px">${parts}</dl>
      <p class="hint" style="margin-top:10px">${hasChat ? 'The file has a field named like message content. Please tell us: it should not.' : `Checked in your browser: no field named content, prompt or messages in this file (${int(text.length)} characters).`}</p>`;
    toast('Your data was downloaded');
  } catch (e) {
    $('#export-sum').innerHTML = `<p class="err-line" style="margin-top:12px">${e.status === 401 ? 'Your session ended. Sign in again.' : `Could not build the file (${esc(e.message)}).`}</p>`;
  } finally {
    btn.disabled = false;
  }
}

chrome();
init();
