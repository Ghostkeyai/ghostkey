// Halaman dokumentasi: contoh kode dengan URL dasar situs ini, angka batas dari /api/config, salin & penanda bagian aktif.
import { chrome, getConfig, api, esc, int, usd, pct, copy } from '/js/common.js';

const $ = (s, el = document) => el.querySelector(s);
const BASE = `${location.origin}/v1`;
let MODEL = 'openai/gpt-4o-mini';

const EX = {
  curl: () => `<span class="c"># 1. export GHOSTKEY_API_KEY=gk_live_…</span>
curl ${esc(BASE)}/chat/completions \\
  -H <span class="s">"Authorization: Bearer $GHOSTKEY_API_KEY"</span> \\
  -H <span class="s">"Content-Type: application/json"</span> \\
  -d <span class="s">'{"model": "${esc(MODEL)}",
       "messages": [{"role": "user", "content": "Hello"}]}'</span>`,
  py: () => `<span class="k">from</span> openai <span class="k">import</span> OpenAI

client = OpenAI(
    base_url=<span class="s">"${esc(BASE)}"</span>,   <span class="c"># the one line you change</span>
    api_key=<span class="s">"gk_live_…"</span>,
)
r = client.chat.completions.create(
    model=<span class="s">"${esc(MODEL)}"</span>,
    messages=[{<span class="s">"role"</span>: <span class="s">"user"</span>, <span class="s">"content"</span>: <span class="s">"Hello"</span>}],
)
print(r.choices[0].message.content)`,
  js: () => `<span class="k">import</span> OpenAI <span class="k">from</span> <span class="s">"openai"</span>;

<span class="k">const</span> client = <span class="k">new</span> OpenAI({
  baseURL: <span class="s">"${esc(BASE)}"</span>,   <span class="c">// the one line you change</span>
  apiKey: process.env.GHOSTKEY_API_KEY,
});
<span class="k">const</span> r = <span class="k">await</span> client.chat.completions.create({
  model: <span class="s">"${esc(MODEL)}"</span>,
  messages: [{ role: <span class="s">"user"</span>, content: <span class="s">"Hello"</span> }],
});
console.log(r.choices[0].message.content);`,
};
let tab = 'curl';
const paintEx = () => { $('#ex').innerHTML = EX[tab](); };

async function init() {
  for (const el of document.querySelectorAll('[data-base]')) el.textContent = BASE;
  paintEx();
  $('#tabs').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-t]'); if (!b) return;
    tab = b.dataset.t;
    for (const x of $('#tabs').querySelectorAll('button')) x.setAttribute('aria-pressed', String(x === b));
    paintEx();
  });
  document.addEventListener('click', (e) => {
    const b = e.target.closest('[data-cp]'); if (!b) return;
    copy($(b.dataset.cp).textContent, 'Copied');
  });

  // Penanda bagian aktif di daftar isi
  const links = [...document.querySelectorAll('#toc a')];
  const io = new IntersectionObserver((ents) => {
    for (const en of ents) if (en.isIntersecting) {
      for (const a of links) a.classList.toggle('on', a.getAttribute('href') === `#${en.target.id}`);
    }
  }, { rootMargin: '-20% 0px -70% 0px' });
  for (const s of document.querySelectorAll('.doc section[id]')) io.observe(s);

  const cfg = await getConfig();
  const free = cfg.freeMessages ?? 10;
  for (const el of document.querySelectorAll('[data-free]')) el.textContent = int(free);
  const set = (k, v) => { const el = document.querySelector(`[data-cfg="${k}"]`); if (el) el.textContent = v; };
  set('freeMessages', `${int(free)} per browser`);
  set('freeMessages2', `${int(free)} calls`);
  if (cfg.holderFreePerDay != null) set('holderFree', `${int(cfg.holderFreePerDay)} a day in chat + ${int(cfg.holderFreePerDay)} API calls a day`);
  if (cfg.apiRpm != null) set('rpm', `${int(cfg.apiRpm)} requests a minute · ${int(cfg.holderApiRpm ?? cfg.apiRpm)} for holders`);
  for (const el of document.querySelectorAll('[data-min]')) el.textContent = int(cfg.minTokens ?? 100000);
  if (cfg.minDepositUsd != null || cfg.maxDepositUsd != null) set('deposit', `${usd(cfg.minDepositUsd ?? 5, { max: 0 })} to ${usd(cfg.maxDepositUsd ?? 2000, { max: 0 })} per payment`);
  for (const el of document.querySelectorAll('[data-share]')) el.textContent = pct(cfg.holderShareBps ?? 2500);
  const x = cfg.links?.x, tg = cfg.links?.telegram;
  const c = document.querySelector('[data-contact]');
  if (c) c.innerHTML = [x && `<a class="link" href="${esc(x)}" target="_blank" rel="noopener">X</a>`, tg && `<a class="link" href="${esc(tg)}" target="_blank" rel="noopener">Telegram</a>`].filter(Boolean).join(' or ') || 'X';

  // Contoh memakai model yang benar-benar ada di katalog
  try {
    const list = await api('/api/models');
    const arr = Array.isArray(list) ? list : list?.data || [];
    if (arr.length) for (const el of document.querySelectorAll('[data-count]')) el.textContent = int(arr.length);
    if (arr.length && !arr.some((m) => m.id === MODEL)) { MODEL = (arr.find((m) => m.freeEligible) || arr[0]).id; paintEx(); }
  } catch {}
  if (location.hash) document.querySelector(location.hash)?.scrollIntoView();
}

chrome();
init();
