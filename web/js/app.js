// Aplikasi chat GHOSTKEY: pemilih model, percakapan hanya di localStorage, streaming SSE dari /api/chat,
// struk per jawaban (token × tarif = biaya) dan laci "What we sent" (receipt.forwarded).
import { api, chrome, getConfig, clientId, esc, usd, int, compact, rate, labOf, toast, copy, me, signIn, pix, downloadJson, ZDR_LIST, ago } from '/js/common.js';
import { jsonHtml } from '/js/jsonview.js';

const $ = (s, el = document) => el.querySelector(s);
const CID = clientId();
const KEY_CHATS = 'gk_chats';
const KEY_MODEL = 'gk_model';

let cfg = {}, account = null, MODELS = [], byId = new Map(), model = null;
let chat = null;            // percakapan aktif
let busy = null;            // AbortController saat menjawab
let freeLeft = null;
let freeTotal = null;   // jatah dari /api/free (pemegang: per hari)
let holderFree = false; // true = jatah harian pemegang $GHOST
let filter = 'Free';

// Model bawaan: utamakan model hemat yang bisa memakai pesan gratis
const PREFERRED = [/^deepseek\/deepseek-.*(flash|chat)/, /^google\/gemini-.*flash(?!.*lite)/, /^openai\/gpt-.*mini/, /^meta-llama\/llama/, /^qwen\/qwen3/, /^mistralai\//];
const LAB_CHIPS = ['Free', 'OpenAI', 'Anthropic', 'Google', 'xAI', 'DeepSeek', 'Qwen', 'Meta', 'Mistral', 'All'];
const SUGGEST = [
  'Explain zero data retention in two sentences.',
  'Write a polite email asking for a deadline extension.',
  'Give me 5 dinner ideas with chickpeas.',
  'What is a Merkle tree? Keep it simple.',
];
// Label ramah untuk daftar kolom yang dibuang server
const STRIP_LABEL = {
  ip_address: 'IP address', user_agent: 'Device (user agent)', cookies: 'Cookies', wallet_address: 'Wallet address',
  account_id: 'Account ID', user_field: '"user" field', metadata: '"metadata" field',
};
const STORED_LABEL = { model: 'Model name', tokens: 'Token count', cost: 'Cost', time: 'Time' };

// ---------- Penyimpanan percakapan (hanya di browser ini) ----------
const store = {
  all() { try { return JSON.parse(localStorage.getItem(KEY_CHATS) || '[]'); } catch { return []; } },
  write(list) {
    try { localStorage.setItem(KEY_CHATS, JSON.stringify(list)); return true; } catch { return false; }
  },
  save(c) {
    const list = this.all().filter((x) => x.id !== c.id);
    list.unshift(c);
    if (this.write(list.slice(0, 50))) return;
    // Penyimpanan penuh → buang isi pesan di salinan "forwarded" lama (struk tetap ada), lalu kurangi jumlah
    const slim = list.map((x) => ({ ...x, messages: x.messages.map((m) => (m.receipt?.forwarded?.body?.messages ? { ...m, receipt: { ...m.receipt, forwarded: { ...m.receipt.forwarded, body: { ...m.receipt.forwarded.body, messages: '[message text not kept in the saved copy, to save browser space]' } } } } : m)) }));
    if (!this.write(slim.slice(0, 50))) this.write(slim.slice(0, 10));
  },
  remove(id) { this.write(this.all().filter((x) => x.id !== id)); },
  wipe() { try { localStorage.removeItem(KEY_CHATS); } catch {} },
};

// ---------- Markdown ringan yang aman (escape dulu, baru format) ----------
function md(text) {
  const blocks = String(text).split(/```/);
  return blocks.map((b, i) => {
    if (i % 2) { const nl = b.indexOf('\n'); return `<pre><code>${esc(nl >= 0 ? b.slice(nl + 1) : b)}</code></pre>`; }
    let h = esc(b)
      .replace(/`([^`\n]+)`/g, '<code>$1</code>')
      .replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>')
      .replace(/^### (.*)$/gm, '<h3>$1</h3>').replace(/^## (.*)$/gm, '<h2>$1</h2>').replace(/^# (.*)$/gm, '<h1>$1</h1>');
    h = h.replace(/(^|\n)((?:[-*] .*(?:\n|$))+)/g, (m, p, list) => `${p}<ul>${list.trim().split('\n').map((l) => `<li>${l.replace(/^[-*] /, '')}</li>`).join('')}</ul>`);
    h = h.replace(/(^|\n)((?:\d+\. .*(?:\n|$))+)/g, (m, p, list) => `${p}<ol>${list.trim().split('\n').map((l) => `<li>${l.replace(/^\d+\. /, '')}</li>`).join('')}</ol>`);
    return h.split(/\n{2,}/).map((p) => (/^<(h\d|ul|ol|pre)/.test(p.trim()) ? p : p.trim() ? `<p>${p.replace(/\n/g, '<br>')}</p>` : '')).join('');
  }).join('');
}

// ---------- Struk per jawaban ----------
// Tarif per 1M token. Server bisa mengirim tarif per token (angka sangat kecil) → ubah ke per 1M.
const perM = (v) => { const n = Number(v); if (!Number.isFinite(n)) return null; return n > 0 && n < 0.001 ? n * 1e6 : n; };

function receiptHtml(r, idx) {
  if (!r) return '';
  const m = byId.get(r.model);
  const ri = perM(r.rateIn ?? r.ratesPerM?.in) ?? m?.in ?? null;
  const ro = perM(r.rateOut ?? r.ratesPerM?.out) ?? m?.out ?? null;
  const tin = Number(r.tokensIn || 0), tout = Number(r.tokensOut || 0);
  const calc = ri != null && ro != null ? (tin * ri + tout * ro) / 1e6 : null;
  const cost = Number(r.costUsd ?? calc ?? 0);
  // Biaya yang ditagih = biaya yang dilaporkan OpenRouter; bisa sedikit beda dari hitungan token × tarif
  const differs = calc != null && Math.abs(calc - cost) > Math.max(0.0000015, cost * 0.02);
  const paid = r.freeLeft != null
    ? `Free message · ${int(r.freeLeft)} left`
    : r.balanceUsd != null ? `Paid from balance · ${usd(r.balanceUsd)} left` : r.paidBy === 'free' ? 'Free message' : 'Paid from balance';
  const stored = (r.stored || ['model', 'tokens', 'cost', 'time']).join(', ');
  return `<div class="rcpt">
    <div class="rcpt-math">
      <span><b>${int(tin)}</b> in × ${rate(ri)}</span><span class="op">+</span>
      <span><b>${int(tout)}</b> out × ${rate(ro)}</span><span class="op">per 1M</span><span class="op">${differs ? '≈' : '='}</span>
      <span class="total">${usd(cost, { max: 6 })}</span>
    </div>
    ${r.mock ? '<div class="why" style="color:var(--gold)">Local test mode: this answer is a placeholder, no model was called and nothing was billed.</div>' : ''}
    ${differs ? '<div class="why">Billed amount is the exact cost OpenRouter reported. It can include reasoning or cached tokens.</div>' : ''}
    <div class="rcpt-foot">
      <span class="paid">${esc(paid)}</span>
      <span>Stored: ${esc(stored)}</span>
      <button class="sent" type="button" data-sent="${idx}">${pix('eye', 12)}What we sent</button>
    </div>
    ${r.generationId ? `<div class="rcpt-id">
      <span title="OpenRouter generation ID">Gen <b>${esc(r.generationId.slice(0, 18))}…</b></span>
      ${r.forwardedSha256 ? `<span title="SHA-256 of the exact body sent to OpenRouter. Not stored on our server.">Sent SHA-256 <b>${esc(r.forwardedSha256.slice(0, 12))}…</b></span>` : ''}
      <button class="sent" type="button" data-check="${esc(r.generationId)}">Check against OpenRouter</button>
      <span class="rcpt-res" data-res="${esc(r.generationId)}"></span>
    </div>` : ''}
  </div>`;
}

// Cek struk ke catatan OpenRouter sendiri (/api/receipt/:id); catatan bisa butuh ±1 menit sebelum tersedia
async function checkReceipt(id) {
  const out = document.querySelector(`[data-res="${CSS.escape(id)}"]`);
  if (!out) return;
  out.className = 'rcpt-res'; out.textContent = 'Checking…';
  try {
    const r = await fetch(`/api/receipt/${encodeURIComponent(id)}`);
    const j = await r.json();
    if (r.status === 202) { out.textContent = 'OpenRouter is still publishing this record. Try again in a minute.'; return; }
    if (!r.ok) { out.textContent = j.message || 'Could not check right now.'; return; }
    out.className = 'rcpt-res ' + (j.match ? 'ok' : 'bad');
    out.innerHTML = `OpenRouter recorded ${usd(j.openrouter.costUsd, { max: 6 })}${j.openrouter.provider ? ` via ${esc(j.openrouter.provider)}` : ''} · we billed ${usd(j.ghostkey.billedUsd, { max: 6 })} · ${j.match ? 'match ✓' : 'mismatch'} · <a class="link" href="/api/receipt/${encodeURIComponent(id)}" target="_blank" rel="noopener">raw</a>`;
  } catch { out.textContent = 'Could not check right now.'; }
}

// ---------- Model ----------
function setModel(m) {
  if (!m) return;
  model = m;
  $('#m-name').textContent = m.name;
  $('#m-rate').textContent = `${rate(m.in)} in · ${rate(m.out)} out /1M`;
  try { localStorage.setItem(KEY_MODEL, m.id); } catch {}
}

function defaultModel() {
  let saved = null; try { saved = localStorage.getItem(KEY_MODEL); } catch {}
  if (saved && byId.get(saved)) return byId.get(saved);
  for (const re of PREFERRED) { const m = MODELS.find((x) => x.freeEligible && re.test(x.id)); if (m) return m; }
  return MODELS.find((x) => x.freeEligible) || MODELS[0];
}

function renderPicker() {
  const q = $('#m-search').value.trim().toLowerCase();
  let list;
  if (q) {
    const terms = q.split(/\s+/);
    list = MODELS.filter((m) => terms.every((t) => m._hay.includes(t)));
  } else {
    list = MODELS.filter((m) => (filter === 'All' ? true : filter === 'Free' ? m.freeEligible : m._lab === filter));
  }
  const shown = list.slice(0, 300);
  $('#m-list').innerHTML = shown.length ? shown.map((m) => {
    const prov = m.zdrProviders?.length ? `${m.zdrProviders.length} ZDR provider${m.zdrProviders.length === 1 ? '' : 's'}` : 'ZDR';
    return `<button class="mrow${m.id === model?.id ? ' sel' : ''}" data-id="${esc(m.id)}" type="button">
      <span class="n">${esc(m.name)}<span class="tag zdr" title="${esc((m.zdrProviders || []).join(', '))}">${prov}</span>${m.freeEligible ? '<span class="tag gold" title="Works with free messages">Free OK</span>' : ''}</span>
      <span class="p">${rate(m.in)} / ${rate(m.out)}<small>in / out per 1M</small></span>
      <span class="id">${esc(m.id)} · ${compact(m.context)} context</span>
    </button>`;
  }).join('') + (list.length > shown.length ? `<div class="empty" style="margin:12px">Showing 300 of ${int(list.length)}. Type to narrow it down.</div>` : '')
    : `<div class="empty" style="margin:16px">${pix('ghost', 36)}No model matches “${esc(q)}”.</div>`;
}
function renderLabChips() {
  const count = (c) => (c === 'All' ? MODELS.length : c === 'Free' ? MODELS.filter((m) => m.freeEligible).length : MODELS.filter((m) => m._lab === c).length);
  $('#m-labs').innerHTML = LAB_CHIPS.filter((c) => count(c) > 0).map((c) => `<button type="button" data-lab="${c}" aria-pressed="${filter === c}">${c === 'Free' ? 'Free OK' : c}<span class="n">${count(c)}</span></button>`).join('');
}
function openPicker(f) {
  if (!MODELS.length) return;
  if (f) filter = f;
  renderLabChips();
  $('#picker').classList.add('open');
  $('#m-search').value = '';
  renderPicker();
  setTimeout(() => $('#m-search').focus(), 30);
}
const closePicker = () => $('#picker').classList.remove('open');

// ---------- Meteran: pesan gratis / saldo ----------
function renderMeter() {
  const el = $('#meter');
  if (account && Number(account.balanceUsd) > 0) {
    el.innerHTML = `<span class="lbl">Balance</span><a class="bal" href="/account" title="Open your account">${usd(account.balanceUsd)}</a>`;
    return;
  }
  const total = Number(freeTotal ?? cfg.freeMessages ?? 10);
  const left = freeLeft == null ? null : Math.max(0, Number(freeLeft));
  const cells = left == null ? '' : `<span class="cells" aria-hidden="true">${Array.from({ length: Math.min(total, 20) }, (_, i) => `<i class="${i < left ? 'on' : ''}"></i>`).join('')}</span>`;
  const txt = left == null ? 'Free messages' : holderFree ? `<span title="$GHOST holder: free messages reset at 00:00 UTC">Holder · ${left}/${total} today</span>` : `Free ${left}/${total}`;
  const act = account
    ? '<a class="btn small" href="/account">Add balance</a>'
    : '<button class="btn small" id="m-signin" type="button"><span class="signin-lbl">Sign in to use balance</span><span class="show-s">Sign in</span></button>';
  el.innerHTML = `<span class="lbl">${txt}</span>${cells}${act}`;
  const b = $('#m-signin');
  if (b) {
    b.onclick = () => signIn().then(() => location.reload()).catch((e) => e?.message && toast(e.message));
  }
}

async function refreshFree() {
  try { const f = await api(`/api/free?clientId=${CID}`); freeLeft = f.freeLeft; freeTotal = f.freeMessages ?? null; holderFree = !!f.holder; } catch { freeLeft = null; }
  renderMeter();
  const p = $('#prompt');
  if (account && Number(account.balanceUsd) > 0) p.placeholder = 'Ask anything.';
  else if (freeLeft > 0) p.placeholder = `Ask anything (${freeLeft} free left)`;
  else if (freeLeft === 0) p.placeholder = account ? 'Add balance to keep chatting.' : 'Sign in and add balance to keep chatting.';
}

// ---------- Daftar percakapan ----------
function renderConvs() {
  const list = store.all();
  $('#conv-count').textContent = list.length ? int(list.length) : '';
  $('#convs').innerHTML = list.length
    ? list.map((c) => `<button class="conv${chat?.id === c.id ? ' on' : ''}" data-id="${esc(c.id)}" type="button"><b>${esc(c.title || 'Untitled')}</b><span>${esc(byId.get(c.model)?.name || c.model || '')} · ${ago(c.at)}</span></button>`).join('')
    : '<div class="none">No chats yet. They are saved here, in this browser only.</div>';
}

function helloHtml() {
  const total = cfg.freeMessages ?? 10;
  return `<div class="hello">
    ${pix('ghost', 72, 'pix big')}
    <h1>200+ AI models. <span class="px">None of you.</span></h1>
    <p>${account && Number(account.balanceUsd) > 0 ? 'Every answer shows its exact cost and the request we sent.' : `${total} free messages. No wallet needed. Every answer shows its exact cost and the request we sent.`}</p>
    <div class="sugs">${SUGGEST.map((s) => `<button type="button" data-sug="${esc(s)}">${esc(s)}</button>`).join('')}</div>
    <div class="facts">
      <div><b>Removed</b>Your wallet, IP and device never reach the model. <a href="/privacy#inspector">Check it ↗</a></div>
      <div><b>Zero retention</b>Only providers that keep nothing after answering. <a href="${ZDR_LIST}" target="_blank" rel="noopener">Public list ↗</a></div>
      <div><b>Same price</b>OpenRouter's price. No markup, no top-up fee. <a href="/models#compare">Compare ↗</a></div>
    </div>
  </div>`;
}

function newChat() {
  if (busy) busy.abort();
  chat = null;
  $('#thread').innerHTML = helloHtml();
  renderConvs();
  closeSide();
  $('#prompt').focus();
}

function msgEl(m, idx) {
  const el = document.createElement('div');
  el.className = `msg ${m.role === 'user' ? 'user' : 'ai'}`;
  if (m.role === 'user') {
    el.innerHTML = `<div class="bubble">${esc(typeof m.content === 'string' ? m.content : '')}</div>`;
  } else {
    el.innerHTML = `<div class="who">${pix('ghost', 14)}${esc(byId.get(m.model)?.name || m.model || '')}</div><div class="body">${md(m.content)}</div>${receiptHtml(m.receipt, idx)}`;
  }
  return el;
}

function loadChat(c) {
  if (busy) busy.abort();
  chat = c;
  const t = $('#thread');
  t.innerHTML = '';
  c.messages.forEach((m, i) => t.appendChild(msgEl(m, i)));
  if (c.model && byId.get(c.model)) setModel(byId.get(c.model));
  renderConvs();
  closeSide();
  scrollEnd();
}

const scrollEnd = () => { const w = $('#thread-wrap'); w.scrollTop = w.scrollHeight; };

// Kotak galat dengan tindakan yang jelas
function errorBlock(code, message) {
  const total = freeTotal ?? cfg.freeMessages ?? 10;
  const text = {
    sign_in: `You have used your ${total} free messages. Sign in with a wallet and add balance to keep chatting.`,
    top_up: holderFree && !(Number(account?.balanceUsd) > 0) ? `You have used today's ${total} holder messages. They reset at 00:00 UTC. Add balance to keep going now.` : 'Your balance is too low for this message. Add balance, or switch to a cheaper model.',
    model_needs_balance: 'Free messages work only with low-cost models (marked Free OK). Pick one, or sign in and add balance.',
    free_paused: 'Free messages are paused for today because the daily free budget is used up. Sign in and add balance to keep chatting.',
    bad_model: 'This model is not available right now. Pick another one.',
  }[code] || message || 'Something went wrong. Try again.';
  const actions = {
    sign_in: '<button class="btn small" data-act="signin" type="button">Sign in</button><a class="btn small ghost" href="/account">How balance works</a>',
    top_up: '<a class="btn small" href="/account">Add balance</a><button class="btn small ghost" data-act="free" type="button">Pick a cheaper model</button>',
    model_needs_balance: `<button class="btn small" data-act="free" type="button">Show Free OK models</button>${account ? '<a class="btn small ghost" href="/account">Add balance</a>' : '<button class="btn small ghost" data-act="signin" type="button">Sign in</button>'}`,
    free_paused: account ? '<a class="btn small" href="/account">Add balance</a>' : '<button class="btn small" data-act="signin" type="button">Sign in</button>',
    bad_model: '<button class="btn small" data-act="pick" type="button">Choose a model</button>',
  };
  return `<div class="err">${esc(text)}${actions[code] ? `<div class="acts">${actions[code]}</div>` : ''}</div>`;
}

// ---------- Kirim + baca stream ----------
async function send(text) {
  if (busy) { busy.abort(); return; }
  text = String(text || '').trim();
  if (!text) return;
  if (!model) return toast('Models are still loading');
  if (!chat) {
    chat = { id: 'k' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6), title: text.slice(0, 70), model: model.id, messages: [], at: Date.now() };
    $('#thread').innerHTML = '';
  }
  chat.model = model.id;
  const userMsg = { role: 'user', content: text };
  chat.messages.push(userMsg);
  const t = $('#thread');
  t.appendChild(msgEl(userMsg));
  $('#prompt').value = ''; autosize();

  const ai = { role: 'assistant', content: '', model: model.id };
  const el = msgEl(ai);
  const body = el.querySelector('.body');
  body.classList.add('cursor');
  t.appendChild(el);
  scrollEnd();

  busy = new AbortController();
  $('#send').textContent = 'Stop';
  // Riwayat yang dikirim: hanya peran + teks (tanpa struk)
  const history = chat.messages.map((m) => ({ role: m.role, content: m.content })).slice(-30);
  let stick = true;
  const wrap = $('#thread-wrap');
  const onScroll = () => { stick = wrap.scrollHeight - wrap.scrollTop - wrap.clientHeight < 80; };
  wrap.addEventListener('scroll', onScroll, { passive: true });
  try {
    const r = await fetch('/api/chat', {
      method: 'POST', signal: busy.signal, credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: model.id, messages: history, clientId: CID }),
    });
    if (!r.ok || !r.headers.get('content-type')?.includes('event-stream')) {
      const j = await r.json().catch(() => ({}));
      body.classList.remove('cursor');
      body.innerHTML = errorBlock(j.error?.code || j.error, j.message || j.error?.message || (r.ok ? '' : `The server answered ${r.status}.`));
      chat.messages.pop();                       // pesan gagal tidak disimpan sebagai giliran
      if (!chat.messages.length) chat = null;
      return;
    }
    const reader = r.body.getReader();
    const dec = new TextDecoder();
    let buf = '', receipt = null, err = null, raf = 0;
    const paint = () => { raf = 0; body.innerHTML = md(ai.content); if (stick) scrollEnd(); };
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let i;
      while ((i = buf.indexOf('\n\n')) >= 0) {
        const block = buf.slice(0, i); buf = buf.slice(i + 2);
        let ev = 'message', data = '';
        for (const line of block.split('\n')) {
          if (line.startsWith('event:')) ev = line.slice(6).trim();
          else if (line.startsWith('data:')) data += line.slice(5).trim();
        }
        if (!data || data === '[DONE]') continue;
        let obj; try { obj = JSON.parse(data); } catch { continue; }
        if (ev === 'receipt') receipt = obj;
        else if (ev === 'error' || obj.error) err = obj.error && typeof obj.error === 'object' ? { error: obj.error.code, message: obj.error.message } : obj;
        else {
          const d = obj.choices?.[0]?.delta?.content;
          if (d) { ai.content += d; if (!raf) raf = requestAnimationFrame(paint); }
        }
      }
    }
    body.classList.remove('cursor');
    if (raf) cancelAnimationFrame(raf);
    paint();
    if (err) body.insertAdjacentHTML('beforeend', errorBlock(err.error, err.message));
    if (receipt?.empty && !ai.content) body.innerHTML = '<p class="stopnote">This model used its whole token budget thinking and wrote no answer. Try a shorter question or another model.</p>';
    if (receipt) {
      ai.receipt = receipt;
      if (receipt.freeLeft != null) freeLeft = receipt.freeLeft;
      if (receipt.balanceUsd != null && account) account.balanceUsd = receipt.balanceUsd;
    }
    if (ai.content || receipt) {
      chat.messages.push(ai);
      el.insertAdjacentHTML('beforeend', receiptHtml(receipt, chat.messages.length - 1));
      chat.at = Date.now();
      store.save(chat);
    } else {
      chat.messages.pop();
      if (!chat.messages.length) chat = null;
    }
  } catch (e) {
    body.classList.remove('cursor');
    if (e.name === 'AbortError') {
      body.insertAdjacentHTML('beforeend', '<p class="stopnote">Stopped. You pay only for what was written.</p>');
      if (ai.content) { chat.messages.push(ai); chat.at = Date.now(); store.save(chat); }
    } else {
      body.innerHTML = errorBlock('', 'Could not reach the GHOSTKEY server. Check your connection and try again.');
      chat.messages.pop();
      if (!chat.messages.length) chat = null;
    }
  } finally {
    wrap.removeEventListener('scroll', onScroll);
    busy = null;
    $('#send').textContent = 'Send';
    renderConvs();
    refreshFree();
    if (stick) scrollEnd();
  }
}

// ---------- Laci "What we sent" ----------
function openDrawer(r) {
  const b = $('#drawer-b');
  const stripped = (r.stripped || Object.keys(STRIP_LABEL).slice(0, 6));
  const stored = r.stored || ['model', 'tokens', 'cost', 'time'];
  const gh = cfg.links?.github;
  const code = gh ? `${gh.replace(/\/$/, '')}/blob/main/server/privacy.mjs` : '';
  const fwd = r.forwarded;
  const prov = fwd?.body?.provider;
  b.innerHTML = `
    <div>
      <div class="label">Removed before sending</div>
      <div class="strip-list">${stripped.map((s) => `<span>${pix('cross', 10)}${esc(STRIP_LABEL[s] || s)}</span>`).join('')}</div>
    </div>
    <div class="forced">
      <div class="label" style="margin-bottom:8px">Forced on every request</div>
      ${prov ? `<code>"provider": ${esc(JSON.stringify(prov))}</code>` : '<code>"provider": {"zdr": true, "data_collection": "deny"}</code>'}
      <p style="margin-top:8px;color:var(--dim)"><b style="color:var(--ink);font-weight:500">zdr: true</b> means OpenRouter may only use providers with Zero Data Retention: they keep nothing after answering. <b style="color:var(--ink);font-weight:500">data_collection: "deny"</b> blocks providers that train on prompts.</p>
      <p style="margin-top:8px"><a class="proof-link" href="${ZDR_LIST}" target="_blank" rel="noopener">Check OpenRouter's public ZDR list</a></p>
    </div>
    <div>
      <div class="label" style="display:flex;justify-content:space-between;align-items:center;gap:12px">The full request <button class="linkbtn" id="d-copy" type="button">Copy JSON</button></div>
      ${fwd ? `<pre class="json" style="margin-top:10px">${jsonHtml(fwd, {
        maxStr: 700,
        mark: (p) => (p === 'body.provider' ? { cls: 'hl', note: 'forced by GHOSTKEY' }
          : /^headers\.authorization$/i.test(p) ? { cls: 'hl', note: 'our shared key' } : null),
      })}</pre>` : '<div class="notice warn" style="margin-top:10px">This answer came without a copy of the request. Use the <a class="link" href="/privacy#inspector">inspector</a> to see what GHOSTKEY sends.</div>'}
    </div>
    <div>
      <div class="label">What we stored about this answer</div>
      <div class="strip-list kept-list">${stored.map((s) => `<span>${pix('check', 10)}${esc(STORED_LABEL[s] || s)}</span>`).join('')}</div>
      <p class="hint" style="margin-top:10px">Not stored: your question, the answer, your IP, your device.</p>
    </div>
    <div class="links">
      <a class="proof-link" href="/account#export">Download everything we store about you</a>
      ${code ? `<a class="proof-link" href="${esc(code)}" target="_blank" rel="noopener">Read the code that builds this request</a>` : '<span class="src">Source code: published at launch</span>'}
      <a class="proof-link" href="/privacy#inspector">Try the inspector</a>
    </div>`;
  $('#d-copy').onclick = () => copy(JSON.stringify(fwd || {}, null, 2), 'Request JSON copied');
  $('#drawer').classList.add('open');
  $('#drawer').setAttribute('aria-hidden', 'false');
  $('#drawer-back').classList.add('open');
  $('#drawer-x').focus();
}
function closeDrawer() {
  $('#drawer').classList.remove('open');
  $('#drawer').setAttribute('aria-hidden', 'true');
  $('#drawer-back').classList.remove('open');
}

// ---------- Sidebar di HP ----------
const closeSide = () => $('#shell').classList.remove('side-open');

function autosize() { const ta = $('#prompt'); ta.style.height = 'auto'; ta.style.height = Math.min(240, ta.scrollHeight) + 'px'; }

// ---------- Mulai ----------
async function init() {
  $('#side-toggle').innerHTML = pix('menu', 14);
  $('#drawer-x').innerHTML = pix('cross', 14);
  [cfg, account] = await Promise.all([getConfig(), me()]);
  $('#thread').innerHTML = helloHtml();
  renderConvs();
  renderMeter();
  refreshFree();

  try {
    MODELS = await api('/api/models');
    if (!Array.isArray(MODELS)) MODELS = MODELS?.data || [];
  } catch (e) {
    MODELS = [];
    $('#m-name').textContent = 'Models unavailable';
    $('#thread').insertAdjacentHTML('afterbegin', `<div class="notice bad">Could not load the model list (${esc(e.message)}). The GHOSTKEY server may be offline. Try again in a minute.</div>`);
  }
  for (const m of MODELS) { m._lab = labOf(m); m._hay = `${m.name} ${m.id} ${m._lab}`.toLowerCase(); }
  byId = new Map(MODELS.map((m) => [m.id, m]));
  if (MODELS.length) { setModel(defaultModel()); $('#m-search').placeholder = `Search ${int(MODELS.length)} models: gpt, claude, llama…`; }
  renderConvs();

  // Peristiwa
  $('#form').addEventListener('submit', (e) => { e.preventDefault(); send($('#prompt').value); });
  $('#prompt').addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); send($('#prompt').value); } });
  $('#prompt').addEventListener('input', autosize);
  $('#new-chat').onclick = newChat;
  $('#model-btn').onclick = () => openPicker();
  $('#m-close').onclick = closePicker;
  $('#picker').addEventListener('click', (e) => { if (e.target.id === 'picker') closePicker(); });
  $('#m-search').addEventListener('input', renderPicker);
  $('#m-labs').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-lab]'); if (!b) return;
    filter = b.dataset.lab; $('#m-search').value = '';
    renderLabChips(); renderPicker();
  });
  $('#m-list').addEventListener('click', (e) => {
    const b = e.target.closest('.mrow'); if (!b) return;
    setModel(byId.get(b.dataset.id)); closePicker(); $('#prompt').focus();
  });
  $('#convs').addEventListener('click', (e) => {
    const b = e.target.closest('.conv'); if (!b) return;
    const c = store.all().find((x) => x.id === b.dataset.id);
    if (c) loadChat(c);
  });
  $('#thread').addEventListener('click', (e) => {
    const s = e.target.closest('[data-sug]');
    if (s) { send(s.dataset.sug); return; }
    const ck = e.target.closest('[data-check]');
    if (ck) { checkReceipt(ck.dataset.check); return; }
    const w = e.target.closest('[data-sent]');
    if (w && chat) { const m = chat.messages[Number(w.dataset.sent)]; if (m?.receipt) openDrawer(m.receipt); return; }
    const a = e.target.closest('[data-act]');
    if (a) {
      if (a.dataset.act === 'signin') signIn().then(() => location.reload()).catch((er) => er?.message && toast(er.message));
      else if (a.dataset.act === 'free') openPicker('Free');
      else if (a.dataset.act === 'pick') openPicker();
    }
  });
  $('#drawer-x').onclick = closeDrawer;
  $('#drawer-back').onclick = closeDrawer;
  $('#side-toggle').onclick = () => $('#shell').classList.toggle('side-open');
  $('#shell').addEventListener('click', (e) => { if ($('#shell').classList.contains('side-open') && !e.target.closest('#side') && !e.target.closest('#side-toggle')) closeSide(); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') { closePicker(); closeDrawer(); closeSide(); } });

  // Ekspor & hapus percakapan lokal
  $('#export').onclick = () => {
    const list = store.all();
    if (!list.length) return toast('No chats to export yet');
    downloadJson({ exportedAt: new Date().toISOString(), note: 'GHOSTKEY chats from this browser. Our server never stored them.', chats: list }, `ghostkey-chats-${new Date().toISOString().slice(0, 10)}.json`);
  };
  const wipe = $('#wipe');
  wipe.onclick = () => {
    if (!store.all().length) return toast('Nothing to wipe');
    if (wipe.dataset.arm !== '1') {
      wipe.dataset.arm = '1'; wipe.textContent = 'Sure? Tap again';
      setTimeout(() => { wipe.dataset.arm = ''; wipe.textContent = 'Wipe'; }, 4000);
      return;
    }
    wipe.dataset.arm = ''; wipe.textContent = 'Wipe';
    store.wipe(); newChat(); toast('All chats deleted from this browser');
  };

  // ?q=... dari landing → langsung kirim
  const q = new URLSearchParams(location.search).get('q');
  if (q && MODELS.length) { history.replaceState(null, '', location.pathname); send(q); }
}

chrome();
init();
