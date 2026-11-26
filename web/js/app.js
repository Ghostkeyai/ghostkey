// Aplikasi chat GHOSTKEY: pemilih model, percakapan hanya di localStorage, streaming SSE dari /api/chat,
// struk per jawaban (token × tarif = biaya) dan laci "What we sent" (receipt.forwarded).
import { api, chrome, getConfig, clientId, esc, usd, int, compact, rate, labOf, toast, copy, me, signIn, pix, downloadJson, ZDR_LIST, ago } from '/js/common.js';
import { jsonHtml } from '/js/jsonview.js';
import { readPdf, estTokens, docMessage, ERR_TEXT as PDF_ERR } from '/js/pdf-attach.js';

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

// ---------- Persona (hanya di browser ini) ----------
// Persona = nama + model + instruksi. Disimpan di localStorage, tidak pernah di server. Saat chat memakai persona,
// instruksinya dikirim sebagai pesan "system" pertama di setiap permintaan (terlihat di laci "What we sent").
const KEY_PERSONAS = 'gk_personas';
const MAX_NAME = 40, MAX_INSTR = 6000, MAX_PERSONAS = 40;
const STARTERS = [
  { name: 'Plain editor', instructions: "You are a careful editor. Fix grammar, cut filler and keep the writer's own voice. Return the edited text first, then at most three short notes on what you changed and why." },
  { name: 'Code reviewer', instructions: 'You review code like a senior engineer. List real bugs first, then risky patterns, then style. Quote the exact line for each point and show the fix. If the code is fine, say so in one line.' },
  { name: 'Explain it simply', instructions: 'Explain things to a smart beginner. Short sentences, one everyday example, no jargon unless you define it in the same sentence. End with one line the reader could repeat to a friend.' },
  { name: 'Translator', instructions: 'Translate whatever I send into natural English, or into the language I name at the start of my message. Keep the meaning and tone, not the word order. Return only the translation.' },
];
// Browser yang memblokir localStorage (mode privat ketat, uji otomatis): persona tetap jalan di memori tab ini saja
let pMem = null;
const personas = {
  all() {
    if (pMem) return pMem.slice();
    try { const l = JSON.parse(localStorage.getItem(KEY_PERSONAS) || '[]'); return Array.isArray(l) ? l : []; } catch { return []; }
  },
  write(list) {
    const l = list.slice(0, MAX_PERSONAS);
    if (!pMem) { try { localStorage.setItem(KEY_PERSONAS, JSON.stringify(l)); return true; } catch {} }
    pMem = l;
    return 'tab';
  },
  get(id) { return this.all().find((x) => x.id === id) || null; },
  save(pp) { const list = this.all(); const i = list.findIndex((x) => x.id === pp.id); if (i >= 0) list[i] = pp; else list.unshift(pp); return this.write(list); },
  remove(id) { this.write(this.all().filter((x) => x.id !== id)); },
};
// rapikan persona dari berkas / masukan: hanya kolom yang dikenal, dipotong ke batas
function cleanPersona(x) {
  if (!x || typeof x !== 'object') return null;
  const name = String(x.name || '').replace(/\s+/g, ' ').trim().slice(0, MAX_NAME);
  const instructions = String(x.instructions || '').trim().slice(0, MAX_INSTR);
  if (!name || !instructions) return null;
  return { id: 'p' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6), name, model: String(x.model || '').slice(0, 120), instructions, at: Date.now() };
}
// Lampiran PDF untuk pesan berikutnya: { state: 'reading'|'ready'|'error', name, i, n, doc, err }
let attached = null;
const DOC_MAX_CHARS = 200_000;      // ≈50k token: batas satu pesan berdokumen (server menolak >400k karakter total)
const DOC_FREE_CHARS = 100_000;     // tanpa saldo (pesan gratis): ≈25k token
let persona = null;          // persona untuk chat baru (chat lama membawa salinannya sendiri)

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
      <span><b>${int(tout)}</b> out × ${rate(ro)}</span><span class="op">per 1M</span><span class="op">${differs ? '· billed' : '='}</span>
      <span class="total">${usd(cost, { max: 6 })}</span>
    </div>
    ${r.mock ? '<div class="why" style="color:var(--gold)">Local test mode: this answer is a placeholder, no model was called and nothing was billed.</div>' : ''}
    ${differs ? `<div class="why">At listed rates this would be ${usd(calc, { max: 7 })}. Billed is the exact cost OpenRouter reported for this answer, which differs when the provider that served it charges another rate or reasoning or cached tokens are counted.</div>` : ''}
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
  if (attached) renderAtt();
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
let pickFor = null;          // null = model chat · fungsi = pilih model untuk editor persona
function openPicker(f, forFn = null) {
  if (!MODELS.length) return;
  pickFor = forFn;
  if (f) filter = f;
  renderLabChips();
  $('#picker').classList.add('open');
  $('#m-search').value = '';
  renderPicker();
  setTimeout(() => $('#m-search').focus(), 30);
}
const closePicker = () => { $('#picker').classList.remove('open'); pickFor = null; };

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
    ? list.map((c) => `<button class="conv${chat?.id === c.id ? ' on' : ''}" data-id="${esc(c.id)}" type="button"><b>${esc(c.title || 'Untitled')}</b><span>${c.persona ? `${esc(c.persona.name)} · ` : ''}${esc(byId.get(c.model)?.name || c.model || '')} · ${ago(c.at)}</span></button>`).join('')
    : '<div class="none">No chats yet. They are saved here, in this browser only.</div>';
}

function helloHtml() {
  const total = cfg.freeMessages ?? 10;
  if (persona) return `<div class="hello">
    ${pix('ghost', 72, 'pix big')}
    <h1><span class="px">${esc(persona.name)}</span></h1>
    <p>Your persona, on ${esc(byId.get(persona.model)?.name || model?.name || 'the model above')}. Its instructions go out as the first message of every request. Open "What we sent" under any answer to see them.</p>
    <div class="p-preview">${esc(persona.instructions.slice(0, 420))}${persona.instructions.length > 420 ? '…' : ''}</div>
    <div class="sugs"><button type="button" data-pedit="${esc(persona.id)}">Edit persona</button><button type="button" data-pclear>Chat without a persona</button></div>
  </div>`;
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
  renderPersonaUi();
  $('#thread').innerHTML = helloHtml();
  renderConvs();
  closeSide();
  $('#prompt').focus();
}

function msgEl(m, idx) {
  const el = document.createElement('div');
  el.className = `msg ${m.role === 'user' ? 'user' : 'ai'}`;
  if (m.role === 'user') {
    const shown = m.doc ? (m.ask ?? '') : (typeof m.content === 'string' ? m.content : '');
    el.innerHTML = `<div class="bubble">${m.doc ? `<div class="doc-chip">${pix('doc', 12)}<b>${esc(m.doc.name)}</b><span>${int(m.doc.pages)} page${m.doc.pages === 1 ? '' : 's'} · read in this browser</span></div>` : ''}${esc(shown)}</div>`;
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
  persona = c.persona ? (personas.get(c.persona.id) || c.persona) : null;
  renderPersonaUi();
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
  if (attached?.state === 'reading') return toast('Still reading the PDF');
  const doc = attached?.state === 'ready' ? attached.doc : null;
  if (doc && docBlocked(doc)) return toast(docBlocked(doc));
  if (!text && !doc) return;
  if (!model) return toast('Models are still loading');
  const ask = text || 'Summarize this document.';
  if (!chat) {
    chat = { id: 'k' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6), title: (doc ? `${doc.name}: ${ask}` : text).slice(0, 70), model: model.id, messages: [], at: Date.now(),
      persona: persona ? { id: persona.id, name: persona.name, instructions: persona.instructions } : null };
    $('#thread').innerHTML = '';
  }
  chat.model = model.id;
  // Dokumen: teks PDF (dibaca di browser) + pertanyaan jadi satu pesan biasa; berkasnya tidak pernah dikirim
  const userMsg = doc ? { role: 'user', content: docMessage(doc, ask), ask, doc: { name: doc.name, pages: doc.pages, chars: doc.chars } }
    : { role: 'user', content: text };
  chat.messages.push(userMsg);
  const t = $('#thread');
  t.appendChild(msgEl(userMsg));
  $('#prompt').value = ''; autosize();
  if (doc) { attached = null; renderAtt(); }

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
  // persona: instruksinya selalu jadi pesan pertama (diambil dari salinan di chat ini, jadi chat lama tetap konsisten)
  if (chat.persona?.instructions) history.unshift({ role: 'system', content: chat.persona.instructions });
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
          : p === 'body.messages[0]' && fwd.body?.messages?.[0]?.role === 'system' ? { cls: 'hl', note: 'your persona, from this browser' }
          : /^body\.messages\[\d+\]$/.test(p) && /^<document /.test(fwd.body?.messages?.[Number(p.match(/\d+/)[0])]?.content || '') ? { cls: 'hl', note: 'text of your PDF, read in this browser' }
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

// ---------- Persona: daftar, chip, editor ----------
function renderPersonas() {
  const list = personas.all();
  const active = chat ? chat.persona?.id : persona?.id;
  $('#personas').innerHTML = list.length
    ? list.map((x) => `<div class="prow${x.id === active ? ' on' : ''}"><button class="puse" type="button" data-puse="${esc(x.id)}"><b>${esc(x.name)}</b><span>${esc(byId.get(x.model)?.name || (x.model ? x.model.split('/').pop() : 'any model'))}</span></button><button class="pedit" type="button" data-pedit="${esc(x.id)}" aria-label="Edit ${esc(x.name)}">Edit</button></div>`).join('')
    : '<div class="none">Save a model with your own instructions. Kept in this browser only.</div>';
}
function renderPersonaUi() {
  const cur = chat ? chat.persona : persona;
  const chip = $('#p-chip');
  if (cur) { chip.hidden = false; $('#p-chip-n').textContent = cur.name; } else chip.hidden = true;
  renderPersonas();
}
function usePersona(id) {
  const x = personas.get(id); if (!x) return;
  if (busy) busy.abort();
  persona = x;
  if (x.model && byId.get(x.model)) setModel(byId.get(x.model));
  chat = null;
  $('#thread').innerHTML = helloHtml();
  renderPersonaUi(); renderConvs(); closeSide();
  $('#prompt').focus();
}
function clearPersona() {
  persona = null;
  if (chat?.persona) chat = null;
  $('#thread').innerHTML = helloHtml();
  renderPersonaUi(); renderConvs();
  $('#prompt').focus();
}

let draft = null;            // persona yang sedang disunting
function openEditor(id) {
  const x = id ? personas.get(id) : null;
  draft = x ? { ...x } : { id: null, name: '', model: model?.id || '', instructions: '' };
  $('#pe-title').textContent = x ? 'Edit persona' : 'New persona';
  $('#pe-name').value = draft.name;
  $('#pe-instr').value = draft.instructions;
  $('#pe-del').hidden = !x; $('#pe-dl').hidden = !x;
  $('#pe-starters').hidden = !!x;
  $('#pe-starters .chips').innerHTML = STARTERS.map((st, i) => `<button type="button" data-starter="${i}">${esc(st.name)}</button>`).join('');
  peModel(); peCount();
  $('#pe').classList.add('open');
  setTimeout(() => $('#pe-name').focus(), 30);
}
const closeEditor = () => { $('#pe').classList.remove('open'); draft = null; };
function peModel() { const m = byId.get(draft.model); $('#pe-model-n').textContent = m ? m.name : (draft.model || 'Pick a model'); $('#pe-model-r').textContent = m ? `${rate(m.in)} in · ${rate(m.out)} out /1M` : ''; }
function peCount() { const n = $('#pe-instr').value.length; const c = $('#pe-count'); c.textContent = `${int(n)} / ${int(MAX_INSTR)}`; c.classList.toggle('over', n > MAX_INSTR); }
function saveEditor() {
  const name = $('#pe-name').value.replace(/\s+/g, ' ').trim();
  const instructions = $('#pe-instr').value.trim();
  if (!name) return toast('Give the persona a name');
  if (!instructions) return toast('Write its instructions');
  if (instructions.length > MAX_INSTR) return toast(`Instructions can be up to ${int(MAX_INSTR)} characters`);
  // model belum dipilih / daftar model belum termuat → pakai model yang sedang aktif; jangan gagal simpan
  if (!draft.model) draft.model = model?.id || [...byId.keys()][0] || '';
  const isNew = !draft.id;
  if (isNew && personas.all().length >= MAX_PERSONAS) return toast(`Up to ${MAX_PERSONAS} personas per browser`);
  const x = { id: draft.id || 'p' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6), name: name.slice(0, MAX_NAME), model: draft.model, instructions, at: Date.now() };
  const where = personas.save(x);
  closeEditor();
  toast(where === 'tab' ? 'This browser blocks storage, so the persona is kept for this tab only'
    : isNew ? 'Persona saved in this browser' : 'Persona updated');
  // persona aktif ikut diperbarui; chat lama tetap memakai salinan instruksinya sendiri
  if (isNew || persona?.id === x.id) usePersona(x.id); else renderPersonas();
}
function deleteEditor() {
  const b = $('#pe-del');
  if (b.dataset.arm !== '1') { b.dataset.arm = '1'; b.textContent = 'Sure? Tap again'; setTimeout(() => { b.dataset.arm = ''; b.textContent = 'Delete'; }, 4000); return; }
  b.dataset.arm = ''; b.textContent = 'Delete';
  const id = draft.id; personas.remove(id); closeEditor();
  if (persona?.id === id) clearPersona(); else renderPersonas();
  toast('Persona deleted from this browser');
}
function downloadPersona() {
  const x = personas.get(draft?.id); if (!x) return;
  const slug = x.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'persona';
  downloadJson({ ghostkeyPersona: 1, name: x.name, model: x.model, instructions: x.instructions }, `ghostkey-persona-${slug}.json`);
}
async function importPersonas(file) {
  try {
    if (file.size > 400_000) throw new Error('big');
    const j = JSON.parse(await file.text());
    const raw = Array.isArray(j) ? j : Array.isArray(j.personas) ? j.personas : [j];
    const add = raw.map(cleanPersona).filter(Boolean);
    if (!add.length) return toast('No persona found in that file');
    const list = personas.all();
    const room = MAX_PERSONAS - list.length;
    if (room <= 0) return toast(`Up to ${MAX_PERSONAS} personas per browser`);
    personas.write([...add.slice(0, room), ...list]);
    renderPersonas();
    toast(`${add.slice(0, room).length} persona${add.length === 1 ? '' : 's'} imported`);
  } catch { toast('That file is not a GHOSTKEY persona'); }
}

// ---------- Sidebar di HP ----------
const closeSide = () => $('#shell').classList.remove('side-open');

function autosize() { const ta = $('#prompt'); ta.style.height = 'auto'; ta.style.height = Math.min(240, ta.scrollHeight) + 'px'; }

// ---------- Lampiran PDF ----------
// Alasan dokumen tidak bisa dikirim dengan model/saldo sekarang ('' = boleh)
function docBlocked(doc) {
  const paid = account && Number(account.balanceUsd) > 0;
  const lim = paid ? DOC_MAX_CHARS : DOC_FREE_CHARS;
  if (doc.chars > lim) return paid
    ? `This PDF has about ${int(estTokens(doc.chars))} tokens of text. One message carries up to about ${int(estTokens(lim))}. Attach fewer pages.`
    : `Free messages carry up to about ${int(estTokens(lim))} tokens of PDF text, and this one has about ${int(estTokens(doc.chars))}. Add balance for longer files, or attach fewer pages.`;
  if (model?.context && estTokens(doc.chars) > model.context * 0.8) return `Too long for ${model.name} (${compact(model.context)} context). Pick a model with a larger context.`;
  return '';
}
function renderAtt() {
  const box = $('#att');
  if (!attached) { box.hidden = true; box.innerHTML = ''; box.classList.remove('bad'); return; }
  box.hidden = false;
  const a = attached;
  const x = '<button class="att-x" type="button" data-att-x aria-label="Remove the PDF">×</button>';
  if (a.state === 'reading') {
    const pct = a.n ? Math.round((a.i / a.n) * 100) : 4;
    box.classList.remove('bad');
    box.innerHTML = `<div class="att-top">${pix('doc', 14)}<span class="att-n">${esc(a.name)}</span><span class="att-m">${a.n ? `reading page ${int(a.i)} of ${int(a.n)} in this browser` : 'opening in this browser'}</span>${x}</div><div class="att-bar"><i style="width:${pct}%"></i></div>`;
    return;
  }
  if (a.state === 'error') {
    box.classList.add('bad');
    box.innerHTML = `<div class="att-top">${pix('warn', 14)}<span class="att-n">${esc(a.name)}</span>${x}</div><p class="att-note">${esc(a.err)}</p>`;
    return;
  }
  const d = a.doc, tok = estTokens(d.chars), why = docBlocked(d);
  const cost = model ? (tok * Number(model.in || 0)) / 1e6 : 0;
  box.classList.toggle('bad', !!why);
  box.innerHTML = `<div class="att-top">${pix(why ? 'warn' : 'doc', 14)}<span class="att-n">${esc(d.name)}</span><span class="att-m">${int(d.pages)} page${d.pages === 1 ? '' : 's'} · ~${compact(tok)} tokens${model ? ` · ${cost > 0 && cost < 0.00001 ? 'under $0.00001' : `~${usd(cost, { max: 5 })}`} to send` : ''}</span>${x}</div>
    ${why ? `<p class="att-note">${esc(why)}</p>` : ''}
    <p class="att-note"><b>Read in this browser.</b> Only the text goes out, inside your message, and the file never leaves this device.${d.totalPages > d.pages ? ` Only the first ${int(d.pages)} of ${int(d.totalPages)} pages were read.` : ''}${d.emptyPages ? ` ${int(d.emptyPages)} page${d.emptyPages === 1 ? ' has' : 's have'} no text, so ${d.emptyPages === 1 ? 'it is' : 'they are'} skipped.` : ''} Send with no question for a summary. Follow-ups in this chat send the text again, like the rest of the conversation.</p>
    <details><summary>Preview the text that will be sent</summary><pre>${esc(d.text.slice(0, 2000))}${d.text.length > 2000 ? '\n…' : ''}</pre></details>`;
}
async function attachFile(file) {
  if (!file) return;
  if (busy) return toast('Wait for the answer to finish');
  const mine = attached = { state: 'reading', name: file.name || 'document.pdf', i: 0, n: 0 };
  renderAtt();
  try {
    const doc = await readPdf(file, (i, n) => { if (attached !== mine) return; mine.i = i; mine.n = n; renderAtt(); });
    if (attached !== mine) return;                       // dibatalkan saat membaca
    attached = { state: 'ready', name: doc.name, doc };
    if (!$('#prompt').value.trim()) $('#prompt').placeholder = 'Ask about this PDF';
  } catch (e) {
    if (attached !== mine) return;
    attached = { state: 'error', name: mine.name, err: PDF_ERR[e.code] || PDF_ERR.broken };
  }
  renderAtt();
  $('#prompt').focus();
}
function clearAtt() { attached = null; renderAtt(); $('#prompt').placeholder = 'Ask anything.'; refreshFree(); }

// ---------- Mulai ----------
async function init() {
  $('#side-toggle').innerHTML = pix('menu', 14);
  $('#drawer-x').innerHTML = pix('cross', 14);
  [cfg, account] = await Promise.all([getConfig(), me()]);
  $('#thread').innerHTML = helloHtml();
  renderConvs();
  renderMeter();
  refreshFree();

  const modelsReq = api('/api/models');   // dimulai sekarang, ditunggu sesudah semua tombol terpasang

  // Peristiwa
  $('#form').addEventListener('submit', (e) => { e.preventDefault(); send($('#prompt').value); });
  $('#prompt').addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); send($('#prompt').value); } });
  $('#prompt').addEventListener('input', autosize);
  // Lampiran PDF: tombol, pilih berkas, seret-lepas ke kotak tulis
  $('#att-btn').innerHTML = pix('doc', 16);
  $('#att-btn').onclick = () => $('#att-file').click();
  $('#att-file').addEventListener('change', (e) => { const f = e.target.files?.[0]; e.target.value = ''; attachFile(f); });
  $('#att').addEventListener('click', (e) => { if (e.target.closest('[data-att-x]')) clearAtt(); });
  const comp = $('.composer');
  comp.addEventListener('dragover', (e) => { if ([...(e.dataTransfer?.types || [])].includes('Files')) { e.preventDefault(); comp.classList.add('drop'); } });
  comp.addEventListener('dragleave', (e) => { if (!comp.contains(e.relatedTarget)) comp.classList.remove('drop'); });
  comp.addEventListener('drop', (e) => { e.preventDefault(); comp.classList.remove('drop'); attachFile(e.dataTransfer?.files?.[0]); });
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
    const m = byId.get(b.dataset.id);
    if (pickFor) { const fn = pickFor; pickFor = null; closePicker(); fn(m); return; }
    setModel(m); closePicker(); $('#prompt').focus();
  });
  $('#convs').addEventListener('click', (e) => {
    const b = e.target.closest('.conv'); if (!b) return;
    const c = store.all().find((x) => x.id === b.dataset.id);
    if (c) loadChat(c);
  });
  $('#thread').addEventListener('click', (e) => {
    const s = e.target.closest('[data-sug]');
    if (s) { send(s.dataset.sug); return; }
    const pe = e.target.closest('[data-pedit]'); if (pe) { openEditor(pe.dataset.pedit); return; }
    if (e.target.closest('[data-pclear]')) { clearPersona(); return; }
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
  // persona
  renderPersonaUi();
  $('#p-new').onclick = () => openEditor(null);
  $('#p-chip-x').onclick = clearPersona;
  $('#personas').addEventListener('click', (e) => {
    const u = e.target.closest('[data-puse]'); if (u) { usePersona(u.dataset.puse); return; }
    const ed = e.target.closest('[data-pedit]'); if (ed) openEditor(ed.dataset.pedit);
  });
  $('#pe-close').onclick = closeEditor;
  $('#pe').addEventListener('click', (e) => { if (e.target.id === 'pe') closeEditor(); });
  $('#pe-model').onclick = () => openPicker(null, (m) => { if (draft) { draft.model = m.id; peModel(); } });
  $('#pe-instr').addEventListener('input', peCount);
  $('#pe-starters').addEventListener('click', (e) => {
    const b = e.target.closest('[data-starter]'); if (!b) return;
    const st = STARTERS[Number(b.dataset.starter)];
    if (!$('#pe-name').value.trim()) $('#pe-name').value = st.name;
    $('#pe-instr').value = st.instructions; peCount();
  });
  $('#pe-del').onclick = deleteEditor;
  $('#pe-dl').onclick = downloadPersona;
  $('#p-import').onclick = () => $('#p-file').click();
  $('#p-file').addEventListener('change', (e) => { const f = e.target.files?.[0]; if (f) importPersonas(f); e.target.value = ''; });
  $('#pe-form').addEventListener('submit', (e) => { e.preventDefault(); saveEditor(); });
  $('#drawer-x').onclick = closeDrawer;
  $('#drawer-back').onclick = closeDrawer;
  $('#side-toggle').onclick = () => $('#shell').classList.toggle('side-open');
  $('#shell').addEventListener('click', (e) => { if ($('#shell').classList.contains('side-open') && !e.target.closest('#side') && !e.target.closest('#side-toggle')) closeSide(); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') { if ($('#picker').classList.contains('open')) closePicker(); else if ($('#pe').classList.contains('open')) closeEditor(); else { closeDrawer(); closeSide(); } } });

  // Ekspor & hapus percakapan lokal
  $('#export').onclick = () => {
    const list = store.all(), ps = personas.all();
    if (!list.length && !ps.length) return toast('No chats or personas to export yet');
    downloadJson({ exportedAt: new Date().toISOString(), note: 'GHOSTKEY chats and personas saved in this browser. Our database has no column for prompts, answers or persona instructions.', chats: list, personas: ps }, `ghostkey-chats-${new Date().toISOString().slice(0, 10)}.json`);
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

  await loadModels(modelsReq);
  // ?q=... dari landing → langsung kirim
  const q = new URLSearchParams(location.search).get('q');
  if (q && MODELS.length) { history.replaceState(null, '', location.pathname); send(q); }
}

async function loadModels(req) {
  try {
    MODELS = await req;
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
  if (draft) peModel();                     // editor persona sudah terbuka sebelum model termuat
  if (persona?.model && byId.get(persona.model) && !chat) setModel(byId.get(persona.model));
}

chrome();
init();
