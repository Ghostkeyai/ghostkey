// GHOSTKEY — logika landing: chat coba, label kontrak, angka live, inspector, harga + bandingkan,
// ledger Ghost Credit, cek dompet, daftar bukti, potongan kode developer. Semua fetch gagal dengan tenang.
import { api, getConfig, clientId, esc, usd, int, compact, copy, toast, chrome, ago, EXPLORER, addrUrl, txUrl } from './common.js';
import { mountFees } from './fees.js';
import { mountChart } from './chart.js';

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const REDUCE = matchMedia('(prefers-reduced-motion: reduce)').matches;
const isAddr = (s) => /^0x[0-9a-fA-F]{40}$/.test(String(s || ''));
const isHash = (s) => /^0x[0-9a-fA-F]{64}$/.test(String(s || ''));
const ZDR_LIST = 'https://openrouter.ai/api/v1/endpoints/zdr';
const SOURCIFY = (a) => `https://repo.sourcify.dev/contracts/full_match/4663/${a}/`;

// ---------- ikon piksel (kisi ASCII → SVG crispEdges) ----------
const ICONS = {
  arrow: ['...#...', '....#..', '.....#.', '#######', '.....#.', '....#..', '...#...'],
  spark: ['..#..', '..#..', '##.##', '..#..', '..#..'],
  check: ['.......#', '......##', '#....##.', '##..##..', '.####...', '..##....'],
  cross: ['##...##', '###.###', '.#####.', '..###..', '.#####.', '###.###', '##...##'],
  wallet: ['.########.', '#........#', '#.....####', '#.....#..#', '#.....####', '#........#', '.########.'],
  globe: ['...###...', '.##.#.##.', '#..#.#..#', '#########', '#..#.#..#', '#########', '#..#.#..#', '.##.#.##.', '...###...'],
  phone: ['######', '#....#', '#....#', '#....#', '#....#', '#....#', '######', '#.##.#', '######'],
  eye: ['...#####...', '.##.....##.', '#...###...#', '#..#####..#', '#...###...#', '.##.....##.', '...#####...'],
  download: ['....#....', '....#....', '....#....', '..#.#.#..', '...###...', '....#....', '.........', '#.......#', '#########'],
  copy: ['..#######', '..#.....#', '######..#', '#....#..#', '#....#..#', '#....#..#', '#....####', '#....#...', '######...'],
  scale: ['.....#.....', '.#########.', '.#...#...#.', '#.#..#..#.#', '###..#..###', '.....#.....', '.....#.....', '...#####...'],
  swap: ['......#..', '#########', '......#..', '.........', '..#......', '#########', '..#......'],
  coin: ['..#####..', '.#.....#.', '#..###..#', '#..#....#', '#..###..#', '#....#..#', '#..###..#', '.#.....#.', '..#####..'],
  clock: ['..#####..', '.#.....#.', '#...#...#', '#...#...#', '#...###.#', '#.......#', '#.......#', '.#.....#.', '..#####..'],
  shield: ['#########', '#.......#', '#...#...#', '#..###..#', '#...#...#', '.#.....#.', '.#.....#.', '..#...#..', '...#.#...', '....#....'],
  key: ['............', '.###........', '#...#.......', '#...########', '#...#....#.#', '#...#....#..', '.###........'],
  doc: ['#####...', '#...##..', '#...###.', '#.....#.', '#.###.#.', '#.....#.', '#.###.#.', '#.....#.', '#######.'],
  cube: ['...###...', '.##...##.', '#.......#', '###...###', '#..###..#', '#...#...#', '#...#...#', '.##.#.##.', '...###...'],
  code: ['##########', '#........#', '#.#......#', '#..#.....#', '#.#..###.#', '#........#', '##########'],
  list: ['#.#######', '.........', '#.#######', '.........', '#.#######'],
};
function pxIcon(name) {
  const g = ICONS[name]; if (!g) return '';
  const w = Math.max(...g.map((r) => r.length)), h = g.length;
  let d = '';
  g.forEach((row, y) => { let x = 0; while (x < row.length) { if (row[x] === '#') { const s = x; while (row[x] === '#') x++; d += `M${s} ${y}h${x - s}v1h-${x - s}z`; } else x++; } });
  return `<svg viewBox="0 0 ${w} ${h}" width="${w}" height="${h}" fill="currentColor" shape-rendering="crispEdges" aria-hidden="true"><path d="${d}"/></svg>`;
}
const fillIcons = (root = document) => $$('[data-px]', root).forEach((el) => { if (!el.firstChild) el.innerHTML = pxIcon(el.dataset.px); });

// ---------- muncul saat digulir (opacity/transform saja) + jaring pengaman gulir ----------
const shown = new WeakSet();
function show(el) {
  if (shown.has(el)) return; shown.add(el); el.classList.add('in');
  el.dispatchEvent(new CustomEvent('reveal'));
}
const rvIO = 'IntersectionObserver' in window ? new IntersectionObserver((es) => es.forEach((e) => { if (e.isIntersecting) { show(e.target); rvIO.unobserve(e.target); } }), { rootMargin: '0px 0px -6% 0px' }) : null;
function watch(root = document) {
  $$('.rv', root).forEach((el) => {
    if (shown.has(el) || el._rv) return; el._rv = 1;
    const sibs = [...el.parentElement.children].filter((c) => c.classList.contains('rv'));
    const i = sibs.indexOf(el);
    if (i > 0) el.style.setProperty('--d', `${Math.min(i, 5) * 0.07}s`);
    if (REDUCE || !rvIO) show(el); else rvIO.observe(el);
  });
  sweep();
}
function sweep() {
  const lim = innerHeight * 0.96;
  $$('.rv:not(.in)').forEach((el) => { if (el.getBoundingClientRect().top < lim) show(el); });
}
let sweepQ = false;
const sweepSoon = () => { if (sweepQ) return; sweepQ = true; requestAnimationFrame(() => { sweepQ = false; sweep(); }); };
addEventListener('scroll', sweepSoon, { passive: true });
addEventListener('resize', sweepSoon);
addEventListener('load', sweep);

// ---------- format ----------
function rate(v) {
  if (v == null || Number.isNaN(Number(v))) return '—';
  const n = Number(v);
  if (n === 0) return 'Free';
  return '$' + n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: n < 1 ? 4 : 2 });
}
function tokens(v) {
  if (v == null) return '—';
  if (typeof v === 'string' && /^\d{19,}$/.test(v)) return compact(Number(BigInt(v) / 10n ** 18n));
  return compact(Number(v));
}
const hourLabel = (h) => {
  const d = new Date(Number(h) * 3600e3);
  if (Number.isNaN(d.getTime())) return String(h);
  return `${d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' })}, ${d.toISOString().slice(11, 16)} UTC`;
};
const modelName = (m) => String(m.name || m.id).replace(/^[^:]{1,30}:\s*/, '');

// JSON → HTML berwarna; baris di dalam blok "provider" disorot
function hlJSON(obj) {
  const lines = esc(JSON.stringify(obj, null, 2)).split('\n');
  let depth = -1;
  return lines.map((line) => {
    const html = line.replace(/(&quot;(?:[^&\\]|\\.|&(?!quot;))*?&quot;)(\s*:)?|\b(true|false|null)\b|(-?\b\d+(?:\.\d+)?(?:e[+-]?\d+)?\b)/g,
      (m, str, colon, bool, num) => (str ? (colon ? `<span class="k">${str}</span>${colon}` : `<span class="s">${str}</span>`) : bool ? `<span class="b">${bool}</span>` : `<span class="n">${num}</span>`));
    const bal = (line.match(/\{/g) || []).length - (line.match(/\}/g) || []).length;
    let hl = false;
    if (depth < 0 && /&quot;provider&quot;\s*:\s*\{/.test(line)) { hl = true; depth = bal > 0 ? bal : -1; }
    else if (depth >= 0) { hl = true; depth += bal; if (depth <= 0) depth = -1; }
    return hl ? `<span class="hl">${html}</span>` : html;
  }).join('\n');
}

// ---------- langit berbintang di hero ----------
function sky() {
  const s = $('.sky'); if (!s || REDUCE) return;
  let h = '';
  for (let i = 0; i < 16; i++) {
    const cls = i % 5 === 0 ? 'tw big' : i % 2 ? 'tw w' : 'tw';
    h += `<i class="${cls}" style="left:${(Math.random() * 96 + 2).toFixed(1)}%;top:${(Math.random() * 80 + 6).toFixed(1)}%;--d:${(Math.random() * 4).toFixed(2)}s"></i>`;
  }
  s.innerHTML = h;
}

// ---------- maskot 3D ----------
function mountHero() {
  const stage = $('#ghost-stage'); if (!stage) return;
  const pixel = innerWidth < 600 ? 3 : 4;
  import('./hero-ghost.js')
    .then((m) => m.mountGhost(stage, { pixel }))
    .catch((e) => console.warn('[ghost] 3D off, static image shown:', e?.message || e));
}

// ---------- data bersama ----------
let MODELS = null;
const modelsP = api('/api/models').then((r) => (MODELS = Array.isArray(r) ? r : (r?.data || r?.models || []))).catch(() => (MODELS = []));
const cfgP = getConfig().then((c) => c || {}).catch(() => ({}));

// ============ chat coba di hero ============
const PREF_FREE = ['openai/gpt-4o-mini', 'google/gemini-2.5-flash-lite', 'google/gemini-2.0-flash', 'meta-llama/llama-3.3-70b', 'mistralai/mistral-small', 'qwen/qwen3', 'deepseek/deepseek-chat', 'openai/gpt-oss', 'meta-llama/llama-4'];
function freeModels(list) {
  const rank = (m) => { const i = PREF_FREE.findIndex((p) => m.id.startsWith(p)); return i < 0 ? 99 : i; };
  return list.filter((m) => m.freeEligible && !SKIP.test(m.id)).sort((a, b) => rank(a) - rank(b) || (a.out - b.out));
}
const ERRORS = {
  sign_in: 'Your free messages are used up. Connect a wallet in the app to keep going.',
  free_used: 'Your free messages are used up. Connect a wallet in the app to keep going.',
  model_needs_balance: 'This model needs a balance. Pick a free model or top up in the app.',
  top_up: 'Your balance is too low for this message. Top up in the app.',
  slow_down: 'Too many messages at once. Wait a few seconds and try again.',
  free_daily_cap: 'Free messages are paused for today. Connect a wallet in the app to keep going.',
};
function setupTry() {
  const form = $('#try'), log = $('#try-log'), input = $('#try-input'), sel = $('#try-model'), send = $('#try-send'), freeEl = $('#free-left');
  const hist = [];
  let busy = false;

  modelsP.then((list) => {
    const pick = freeModels(list).slice(0, 10);
    if (!pick.length) { sel.innerHTML = '<option value="">Chat is offline right now</option>'; sel.disabled = true; return; }
    sel.innerHTML = pick.map((m) => `<option value="${esc(m.id)}">${esc(modelName(m))}${m.lab ? ' · ' + esc(m.lab) : ''}</option>`).join('');
  });

  const setFree = (n) => {
    if (n == null) return;
    freeEl.innerHTML = n > 0 ? `<b>${int(n)}</b> free message${n === 1 ? '' : 's'} left · no wallet needed` : 'Free messages used · <a class="inl" href="/app">continue in the app</a>';
  };
  api(`/api/free?clientId=${encodeURIComponent(clientId())}`).then((r) => setFree(r?.freeLeft)).catch(() => {});

  const addMsg = (cls, text) => { const d = document.createElement('div'); d.className = `msg ${cls}`; d.textContent = text; log.appendChild(d); log.classList.add('on'); log.scrollTop = log.scrollHeight; return d; };

  async function ask(text) {
    text = text.trim();
    if (!text || busy) return;
    if (!sel.value) { toast('Chat is offline right now. Try again in a minute.'); return; }
    busy = true; form.classList.add('busy', 'used'); send.disabled = true; input.value = '';
    addMsg('u', text);
    const a = addMsg('a', '');
    const tn = document.createTextNode(''); const cur = document.createElement('span'); cur.className = 'cur'; a.append(tn, cur);
    hist.push({ role: 'user', content: text });
    while (hist.length > 6) hist.shift();
    let answer = '', receipt = null;
    try {
      const r = await fetch('/api/chat', { method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'same-origin',
        body: JSON.stringify({ model: sel.value, messages: hist, clientId: clientId() }) });
      if (!r.ok || !r.body) {
        let j = null; try { j = await r.json(); } catch {}
        throw new Error(ERRORS[j?.error] || j?.message || (r.status === 404 ? 'Chat is not available on this server yet.' : `Chat is unavailable right now (HTTP ${r.status}).`));
      }
      const reader = r.body.getReader(), dec = new TextDecoder();
      let buf = '';
      const handle = (block) => {
        let ev = 'message'; const data = [];
        block.split('\n').forEach((l) => { if (l.startsWith('event:')) ev = l.slice(6).trim(); else if (l.startsWith('data:')) data.push(l.slice(5).replace(/^ /, '')); });
        const raw = data.join('\n');
        if (!raw || raw === '[DONE]') return;
        let j; try { j = JSON.parse(raw); } catch { return; }
        if (ev === 'receipt') { receipt = j; return; }
        if (ev === 'error' || j.error) { const e = j.error; throw new Error(ERRORS[e?.code || e] || j.message || e?.message || 'The model did not answer. Try another one.'); }
        const d = j.choices?.[0]?.delta?.content;
        if (d) { answer += d; tn.data = answer; log.scrollTop = log.scrollHeight; }
      };
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true }).replace(/\r\n/g, '\n');
        let i;
        while ((i = buf.indexOf('\n\n')) >= 0) { const b = buf.slice(0, i); buf = buf.slice(i + 2); handle(b); }
      }
      if (buf.trim()) handle(buf);
      cur.remove();
      if (!answer) tn.data = receipt?.empty ? 'The model used its whole budget thinking and wrote nothing. This one was not counted. Try again.' : '(No answer text came back.)';
      hist.push({ role: 'assistant', content: answer });
      if (receipt) renderReceipt(receipt);
      if (receipt?.freeLeft != null) setFree(receipt.freeLeft);
    } catch (e) {
      cur.remove(); a.classList.add('err');
      tn.data = /Failed to fetch|NetworkError|Load failed/.test(e.message) ? 'Chat is offline right now. Try again in a minute.' : e.message;
      hist.pop();
    } finally {
      busy = false; form.classList.remove('busy'); send.disabled = false;
      log.scrollTop = log.scrollHeight;
    }
  }

  function renderReceipt(r) {
    const d = document.createElement('div'); d.className = 'rcpt';
    const sent = r.forwarded || null;
    d.innerHTML = `<span>cost ${esc(usd(r.costUsd))}</span><span>${int(r.tokensIn)} in / ${int(r.tokensOut)} out</span><span class="ok">identity removed ✓</span>`
      + (sent ? '<button type="button">view what we sent</button>' : '<a class="inl" href="#inspector">view what we send</a>')
      + '<span class="rcpt-more">Stored: model, tokens, cost, time. <a href="/app">Continue in the full app →</a></span>';
    if (sent) {
      const b = d.querySelector('button');
      b.onclick = () => {
        let pre = d.querySelector('pre');
        if (pre) { pre.remove(); b.textContent = 'view what we sent'; return; }
        pre = document.createElement('pre'); pre.className = 'code'; pre.innerHTML = hlJSON(sent);
        d.appendChild(pre); b.textContent = 'hide';
      };
    }
    log.appendChild(d); log.scrollTop = log.scrollHeight;
  }

  form.addEventListener('submit', (e) => { e.preventDefault(); ask(input.value); });
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); ask(input.value); } });
  $$('#try-sugg button').forEach((b) => (b.onclick = () => ask(b.dataset.q)));
}

// ============ jumlah model live (dekat judul) ============
function setupModelCount() {
  modelsP.then((list) => {
    if (list.length) $('#model-count').textContent = int(list.length);
    else $('#model-count-l').textContent = 'models · list';
  });
}

// ============ gembok $GHOST: terkunci sebelum token ada, terbuka saat live ============
async function setupKeytag() {
  $('#kt-cells').innerHTML = '<i></i>'.repeat(40);
  const cfg = await cfgP;
  const ca = isAddr(cfg.ghostToken) ? cfg.ghostToken : null;
  if (!ca) return;   // sebelum launch: status jujur dari HTML tetap tampil
  const lc = ca.toLowerCase();
  $('#keytag').classList.add('open');
  $('#kt-chip').textContent = 'Unlocked · live';
  $('#kt-main').innerHTML = `<div class="kt-slot live"><span class="addr">${esc(ca)}</span><button class="kt-copy" type="button">Copy</button></div>`;
  $('#kt-main .kt-copy').onclick = () => copy(ca, 'Contract address copied');
  $('#kt-line').textContent = 'Unlocked. Before you buy, check that this address reads the same as our pinned post on X.';
  $('#kt-actions').innerHTML = `<a class="kt-buy" href="https://www.ponsfamily.com/launchpad/${lc}" target="_blank" rel="noopener">Buy on Pons</a>`
    + `<a class="kt-link" href="https://dexscreener.com/robinhood/${lc}" target="_blank" rel="noopener">Chart</a>`
    + `<a class="kt-link" href="${EXPLORER}/token/${ca}" target="_blank" rel="noopener">Blockscout</a>`;
}

// ============ angka live ============
function countUp(el, to, fmt) {
  const f = fmt === 'usd' ? (v) => usd(v, { min: 2, max: 2 }) : fmt === 'compact' ? (v) => (v < 10000 ? int(Math.round(v)) : compact(v)) : (v) => int(Math.round(v));
  if (REDUCE || !to) { el.textContent = f(to || 0); return; }
  const t0 = performance.now(), dur = 1400;
  const step = (t) => { const k = Math.min(1, (t - t0) / dur), e = 1 - (1 - k) ** 3; el.textContent = f(to * e); if (k < 1) requestAnimationFrame(step); else el.textContent = f(to); };
  requestAnimationFrame(step);
}
function setupStats() {
  const strip = $('#strip');
  let data = null, seen = false, done = false;
  const go = () => { if (!data || !seen || done) return; done = true; $$('[data-count]', strip).forEach((el) => countUp(el, Number(data[el.dataset.count]) || 0, el.dataset.fmt)); };
  new IntersectionObserver(([e], o) => { if (e.isIntersecting) { seen = true; o.disconnect(); go(); } }).observe(strip);
  const when = $('#strip-when');
  const load = () => api('/api/stats').then((s) => {
    if (done) $$('[data-count]', strip).forEach((el) => { const v = Number(s[el.dataset.count]) || 0; el.textContent = el.dataset.fmt === 'usd' ? usd(v, { min: 2, max: 2 }) : el.dataset.fmt === 'compact' && v >= 10000 ? compact(v) : int(v); });
    data = s; go();
    when.textContent = `Live from /api/stats · updated ${s.updatedAt ? ago(s.updatedAt) : 'just now'}`;
  }).catch(() => { when.textContent = 'Live stats are offline right now'; });
  load(); setInterval(load, 60_000);
}

// ============ inspector ============
const STRIP_LABEL = {
  ip_address: 'Your IP address', user_agent: 'Your device and browser (user agent)', cookies: 'Your cookies',
  wallet_address: 'Your wallet address', account_id: 'Your GHOSTKEY account ID', user_field: 'Any "user" field your app sends',
};
function setupInspector() {
  const go = $('#insp-go'), input = $('#insp-input'), out = $('#insp-out');
  go.onclick = async () => {
    const text = input.value.trim() || 'Hello';
    go.disabled = true; const label = go.innerHTML; go.lastChild.textContent = 'Building request…';
    try {
      const list = MODELS || await modelsP;
      const model = $('#try-model').value || list.find((m) => m.freeEligible)?.id || list[0]?.id || 'openai/gpt-4o-mini';
      const r = await api('/api/inspect', { method: 'POST', body: { model, messages: [{ role: 'user', content: text }] } });
      $('#insp-json').innerHTML = hlJSON(r.wouldSend ?? r);
      const gone = (r.stripped || Object.keys(STRIP_LABEL)).map((k) => `<li>${pxIcon('cross').replace('<svg', '<span data-px><svg').replace('</svg>', '</svg></span>')}<span>${esc(STRIP_LABEL[k] || k)}</span></li>`);
      (r.droppedFields || []).forEach((f) => gone.push(`<li><span data-px>${pxIcon('cross')}</span><span><s>${esc(f)}</s> field from your request</span></li>`));
      const hdrs = (r.notSent || []).map((h) => String(h).split(' ')[0]).filter((h) => h && !/^ip_address$/.test(h));
      $('#insp-gone').innerHTML = gone.join('')
        + (hdrs.length ? `<li class="hdrs"><span class="insp-label">Browser headers dropped (${hdrs.length})</span><span class="hchips">${hdrs.map((h) => `<s>${esc(h)}</s>`).join('')}</span></li>` : '');
      const pre = $('#insp-json'), hl = pre.querySelector('.hl');
      if (hl) requestAnimationFrame(() => { pre.scrollTop = Math.max(0, hl.offsetTop - pre.clientHeight / 2); });
      $('#insp-links').innerHTML = `<a class="proof-link" href="${esc(r.zdrList || ZDR_LIST)}" target="_blank" rel="noopener">Providers that keep nothing (ZDR)</a>`
        + (typeof r.code === 'string' && r.code ? `<a class="proof-link" href="${esc(r.code)}" target="_blank" rel="noopener">Code that builds this request</a>` : '')
        + (Array.isArray(r.zdrProviders) && r.zdrProviders.length ? `<span class="insp-prov">Zero-retention providers for this model: ${r.zdrProviders.map(esc).join(', ')}</span>` : '');
    } catch (e) {
      $('#insp-json').innerHTML = `<span class="c">// The inspector is offline right now. Try again in a minute.\n// (${esc(e.status ? 'HTTP ' + e.status : 'no connection')})</span>`;
      $('#insp-gone').innerHTML = Object.values(STRIP_LABEL).map((t) => `<li><span data-px>${pxIcon('cross')}</span><span>${esc(t)}</span></li>`).join('');
      $('#insp-links').innerHTML = `<a class="proof-link" href="${ZDR_LIST}" target="_blank" rel="noopener">OpenRouter ZDR list</a>`;
    } finally {
      out.hidden = false; go.disabled = false; go.innerHTML = label;
      $('#inspector').classList.add('hot');
    }
  };
}

// ============ harga ============
const POPULAR = [/^anthropic\/claude-sonnet/, /^openai\/gpt-5[\d.]*$/, /^google\/gemini-[\d.]+-pro$/, /^google\/gemini-[\d.]+-flash$/, /^deepseek\/deepseek-(chat|v)/, /^openai\/gpt-4o-mini$/,
  /^meta-llama\/llama-[\d.]+-70b/, /^x-ai\/grok-\d/, /^mistralai\/mistral-(medium|large|small)/, /^qwen\/qwen3/, /^moonshotai\/kimi/, /^anthropic\/claude/, /^openai\/gpt/];
const SKIP = /image|guard|embed|audio|tts|vision|preview|search|:free|-exp/i;
let priceRows = [];
function setupPrice() {
  const body = $('#price-body'), count = $('#price-count');
  modelsP.then((list) => {
    const paid = list.filter((m) => !SKIP.test(m.id) && !SKIP.test(m.name || '') && Number(m.out) > 0);
    const picked = [];
    for (const p of POPULAR) {
      const m = paid.filter((x) => p.test(x.id) && !picked.includes(x)).sort((a, b) => String(b.id).localeCompare(String(a.id), 'en', { numeric: true }))[0];
      if (m) picked.push(m);
      if (picked.length >= 8) break;
    }
    for (const m of paid) { if (picked.length >= 8) break; if (!picked.includes(m)) picked.push(m); }
    priceRows = picked;
    if (!picked.length) { body.innerHTML = '<tr class="empty"><td colspan="4">Live prices are offline right now. They load from /api/models.</td></tr>'; return; }
    body.innerHTML = picked.map((m, i) => `<tr data-i="${i}"><td><div class="mname"><span>${esc(modelName(m))}</span><small>${esc(m.id)}</small></div></td>`
      + `<td class="num" data-l="In / 1M">${rate(m.in)}</td><td class="num" data-l="Out / 1M">${rate(m.out)}</td><td class="cmp"><span class="vs wait">not checked</span></td></tr>`).join('');
    count.textContent = `${int(list.length)} models in the catalog · showing ${picked.length}`;
  });

  const btn = $('#cmp-go');
  btn.onclick = async () => {
    if (!priceRows.length) { toast('Prices have not loaded yet'); return; }
    btn.disabled = true;
    $$('#price-body .vs').forEach((v) => { v.className = 'vs wait'; v.textContent = 'checking…'; });
    try {
      const r = await fetch('https://openrouter.ai/api/v1/models');
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const j = await r.json();
      const map = new Map((j.data || []).map((m) => [m.id, m]));
      let ok = 0;
      priceRows.forEach((m, i) => {
        const cell = $(`#price-body tr[data-i="${i}"] .vs`);
        const o = map.get(m.id);
        if (!o) { cell.className = 'vs wait'; cell.textContent = 'not listed'; return; }
        const oi = Number(o.pricing?.prompt) * 1e6, oo = Number(o.pricing?.completion) * 1e6;
        const same = (a, b) => Math.abs(Number(a) - b) <= Math.max(0.0002, b * 0.002);
        if (same(m.in, oi) && same(m.out, oo)) { ok++; cell.className = 'vs ok'; cell.innerHTML = `${pxIcon('check')} match`; }
        else { cell.className = 'vs bad'; cell.innerHTML = `${pxIcon('cross')} differs <small>${rate(oi)} / ${rate(oo)}</small>`; }
      });
      const c = $('#price-count');
      c.className = ok === priceRows.length ? 'ok' : '';
      c.textContent = `${ok} of ${priceRows.length} prices match OpenRouter · checked ${new Date().toISOString().slice(11, 16)} UTC`;
    } catch {
      $$('#price-body .vs').forEach((v) => { v.className = 'vs wait'; v.textContent = 'not checked'; });
      $('#cmp-note').innerHTML = 'Could not reach OpenRouter from your browser. Try again, or open <a class="inl" href="https://openrouter.ai/models" target="_blank" rel="noopener">openrouter.ai/models</a>.';
    } finally { btn.disabled = false; }
  };
}

// ============ ledger + cek dompet ============
function setupLedger() {
  cfgP.then((c) => { if (c.minTokens) $('#min-tokens').textContent = int(c.minTokens); });
  const box = $('#ledger-body');
  api('/api/ledger?limit=6').then((rows) => {
    rows = Array.isArray(rows) ? rows.slice(0, 6) : [];
    if (!rows.length) return;
    box.innerHTML = '<div class="lrow h"><span>Hour</span><span>Pool</span><span>Holders</span><span>Check</span></div>'
      + rows.map((h) => {
        const chk = isHash(h.txHash) ? `<a href="${txUrl(h.txHash)}" target="_blank" rel="noopener">on-chain ↗</a>`
          : `<span class="dim">${esc({ no_fees: 'no fees', no_holders: 'no holders', pending: 'pending' }[h.status] || h.status || 'pending')}</span>`;
        return `<div class="lrow"><span>${esc(hourLabel(h.hour))}</span><span class="mono">${esc(usd(h.poolUsd, { min: 2 }))}</span><span>${int(h.entries || 0)}</span><span>${chk}</span></div>`;
      }).join('');
  }).catch(() => {});

  const form = $('#wc-form'), input = $('#wc-input'), out = $('#wc-out');
  form.onsubmit = async (e) => {
    e.preventDefault();
    const w = input.value.trim();
    if (!isAddr(w)) { out.innerHTML = '<p class="err">That does not look like a wallet address. It should start with 0x and have 42 characters.</p>'; return; }
    out.innerHTML = '<p class="dim">Checking…</p>';
    try {
      const r = await api(`/api/holder/${w}`);
      const credits = Array.isArray(r.credits) ? r.credits : [];
      const total = r.totalCreditedUsd != null ? Number(r.totalCreditedUsd) : credits.reduce((s, c) => s + (Number(c.creditUsd) || 0), 0);
      const elig = r.excluded ? 'Excluded' : r.eligibleNow == null ? '—' : r.eligibleNow ? 'Yes' : 'Not yet';
      out.innerHTML = `<div class="wc-res">
          <div><b>${esc(tokens(r.balanceNow))}</b><span>$GHOST held now</span></div>
          <div><b>${elig}</b><span>Eligible this hour</span></div>
          <div><b>${esc(usd(total, { min: 2 }))}</b><span>Ghost Credit received</span></div>
        </div>`
        + (credits.length ? `<ul class="wc-list">${credits.slice(-5).reverse().map((c) => `<li><span>${esc(hourLabel(c.hour))} · ${esc(usd(c.creditUsd))}</span>${isHash(c.txHash) ? `<a href="${txUrl(c.txHash)}" target="_blank" rel="noopener">verified on-chain ↗</a>` : '<span class="dim">pending</span>'}</li>`).join('')}</ul>`
          : `<p class="dim" style="margin-top:10px">${r.excluded ? 'Team and pool wallets do not receive Ghost Credit.' : r.token ? 'No Ghost Credit for this wallet yet.' : '$GHOST is not launched yet, so no hours have been posted.'}</p>`);
    } catch (err) {
      out.innerHTML = `<p class="err">${err.status === 429 ? 'Too many checks. Wait a minute and try again.' : 'The wallet check is offline right now. Try again in a minute.'}</p>`;
    }
  };
}

// ============ bukti ============
async function setupProof() {
  const [cfg, proof] = await Promise.all([cfgP, api('/api/proof').catch(() => ({}))]);
  const P = proof || {};
  const find = (...keys) => {
    for (const k of keys) {
      for (const src of [cfg, P, P.addresses, P.contracts, P.wallets]) {
        const v = src?.[k];
        if (isAddr(v)) return v;
        if (isAddr(v?.address)) return v.address;
      }
    }
    return null;
  };
  const token = find('ghostToken', 'token', 'ghost'), ledger = find('ledger', 'ledgerAddress', 'ghostLedger'),
    treasury = find('treasury', 'treasuryAddress'), owner = find('owner', 'ownerWallet', 'team');
  const github = cfg.links?.github || P.code?.repo || null;
  const privacySrc = P.code?.privacy || null;
  const ledgerSrc = P.contracts?.ledger?.sourcify || null;
  const ponsUrl = P.contracts?.token?.pons || null;
  const L = (href, t) => `<a class="proof-link" href="${esc(href)}" target="_blank" rel="noopener">${t}</a>`;
  const A = (a) => `<span class="addr">${esc(a)}</span>`;
  const na = (t) => `<span class="na">${t}</span>`;
  const items = [
    { i: 'scale', t: 'Prices match OpenRouter', p: 'Each model costs the same per million tokens as on OpenRouter.', live: true,
      l: [L('/api/models', '/api/models'), L('https://openrouter.ai/api/v1/models', 'OpenRouter prices'), '<a class="proof-link" href="#price">Compare live</a>'] },
    { i: 'eye', t: 'Wallet, IP and device are removed', p: 'The inspector shows the exact request we build for OpenRouter.', live: true,
      l: ['<a class="proof-link" href="#inspector">Open the inspector</a>', L('/privacy', 'How it works')].concat(privacySrc ? [L(privacySrc, 'Filter source')] : []) },
    { i: 'shield', t: 'Only providers that keep nothing', p: 'Every request asks for Zero Data Retention providers only.', live: true,
      l: [L(ZDR_LIST, 'OpenRouter ZDR list'), L('/api/models', 'zdr field in /api/models')] },
    { i: 'key', t: '$GHOST token contract', p: token ? A(token) : 'Not launched yet. The address is posted here first.', live: !!token,
      l: token ? [L(`${EXPLORER}/token/${token}`, 'Blockscout'), L(ponsUrl || `https://www.ponsfamily.com/launchpad/${token.toLowerCase()}`, 'Pons')] : [na('Not launched yet')] },
    { i: 'list', t: 'Ghost Credit ledger contract', p: ledger ? A(ledger) : 'Each hour\'s payout root is saved here. No owner, no upgrades.', live: !!ledger,
      l: ledger ? [L(addrUrl(ledger), 'Blockscout'), L(ledgerSrc || SOURCIFY(ledger), 'Verified source')] : [na('Not deployed yet')] },
    { i: 'wallet', t: 'Top-up address', p: treasury ? A(treasury) : 'USDG and ETH top-ups go to this address.', live: !!treasury,
      l: treasury ? [L(addrUrl(treasury), 'Blockscout')] : [na('Not deployed yet')] },
    { i: 'coin', t: 'Team wallet (75% of fees)', p: owner ? A(owner) : 'The team\'s 75% share of the $GHOST creator fee goes here.', live: !!owner,
      l: owner ? [L(addrUrl(owner), 'Blockscout')] : [na('Not deployed yet')] },
    { i: 'doc', t: 'Usage and payouts are public', p: 'Messages, tokens, cost and every hourly payout, as JSON.', live: true,
      l: [L('/api/stats', '/api/stats'), L('/api/ledger', '/api/ledger')] },
    { i: 'code', t: 'Open-source code', p: 'The gateway, the privacy filter and the ledger contract.', live: !!github,
      l: github ? [L(github, 'GitHub')] : [na('Not published yet')] },
  ];
  $('#claims').innerHTML = items.map((c) => `<article class="claim pbox hov rv">
      <div class="claim-top"><span data-px="${c.i}"></span><span class="chip ${c.live ? 'ok' : 'wait'}">${c.live ? 'Check it' : (c.l[0]?.includes('launched') ? 'Pre-launch' : 'Not deployed yet')}</span></div>
      <h3>${esc(c.t)}</h3><p>${c.p}</p>
      <div class="claim-links">${c.l.join('')}</div></article>`).join('');
  fillIcons($('#claims'));
  watch($('#claims'));
}

// ============ developer ============
async function setupDev() {
  const cfg = await cfgP;
  const host = String(cfg.publicUrl || location.origin).replace(/\/$/, '');
  $$('.host-v1').forEach((el) => (el.textContent = `${host}/v1`));
  const list = MODELS || await modelsP;
  const model = freeModels(list)[0]?.id || 'openai/gpt-4o-mini';
  const code = {
    curl: `curl ${host}/v1/chat/completions \\\n  -H "Authorization: Bearer gk_live_YOUR_KEY" \\\n  -H "Content-Type: application/json" \\\n  -d '{\n    "model": "${model}",\n    "messages": [{"role": "user", "content": "Hello"}]\n  }'`,
    py: `from openai import OpenAI\n\nclient = OpenAI(\n    base_url="${host}/v1",   # the one line you change\n    api_key="gk_live_YOUR_KEY",\n)\n\nr = client.chat.completions.create(\n    model="${model}",\n    messages=[{"role": "user", "content": "Hello"}],\n)\nprint(r.choices[0].message.content)`,
    js: `import OpenAI from "openai";\n\nconst client = new OpenAI({\n  baseURL: "${host}/v1",   // the one line you change\n  apiKey: "gk_live_YOUR_KEY",\n});\n\nconst r = await client.chat.completions.create({\n  model: "${model}",\n  messages: [{ role: "user", content: "Hello" }],\n});\nconsole.log(r.choices[0].message.content);`,
  };
  const paint = (s) => esc(s)
    .replace(/(\s)(# .*|\/\/ the one line.*)$/gm, '$1<span class="c">$2</span>')
    .replace(/(&quot;[^&\n]*?&quot;|&#39;)/g, '<span class="s">$1</span>');
  $$('[data-pane]').forEach((p) => (p.innerHTML = paint(code[p.dataset.pane])));
  let cur = 'curl';
  $$('.tabs [data-tab]').forEach((b) => (b.onclick = () => {
    cur = b.dataset.tab;
    $$('.tabs [data-tab]').forEach((x) => x.setAttribute('aria-selected', String(x === b)));
    $$('[data-pane]').forEach((p) => (p.hidden = p.dataset.pane !== cur));
  }));
  $('#code-copy').onclick = () => copy(code[cur], 'Code copied');
}

// ---------- mulai ----------
fillIcons();
sky();
watch();
chrome().catch(() => {});
mountHero();
setupTry();
setupKeytag();
setupModelCount();
setupStats();
setupInspector();
setupPrice();
setupLedger();
mountFees(document.getElementById('fees-strip'), { compact: true });
mountChart(document.getElementById('dx-chart'));
setupProof();
setupDev();
