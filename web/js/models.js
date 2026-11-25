// Halaman model & harga: katalog live dari /api/models, cari/filter/urut, dan pembanding langsung ke OpenRouter
// (harga + daftar ZDR publik) yang dijalankan di browser pengguna — server GHOSTKEY tidak ikut campur.
import { api, chrome, esc, int, rate, compact, labOf, pix, OR_MODELS, ZDR_LIST } from '/js/common.js';

const $ = (s, el = document) => el.querySelector(s);
const PAGE = 50;

let all = [];
const state = { q: '', lab: '', free: false, vision: false, tools: false, sort: 'in' };
let limit = PAGE;
let checked = null;          // hasil pembanding: Map id → { price:'match'|'differs'|'missing', oi, oo, zdr:boolean|null }

function readUrl() {
  const p = new URLSearchParams(location.search);
  state.q = p.get('q') || '';
  state.lab = p.get('lab') || '';
  for (const f of ['free', 'vision', 'tools']) state[f] = p.get(f) === '1';
  state.sort = p.get('sort') || 'in';
}
function writeUrl() {
  const p = new URLSearchParams();
  if (state.q) p.set('q', state.q);
  if (state.lab) p.set('lab', state.lab);
  for (const f of ['free', 'vision', 'tools']) if (state[f]) p.set(f, '1');
  if (state.sort !== 'in') p.set('sort', state.sort);
  const qs = p.toString();
  history.replaceState(null, '', location.pathname + (qs ? '?' + qs : '') + location.hash);
}

function filtered() {
  const terms = state.q.toLowerCase().split(/\s+/).filter(Boolean);
  const list = all.filter((m) => {
    if (state.lab && m._lab !== state.lab) return false;
    if (state.free && !m.freeEligible) return false;
    if (state.vision && !m.vision) return false;
    if (state.tools && !m.tools) return false;
    return terms.every((t) => m._hay.includes(t));
  });
  const by = {
    in: (a, b) => a.in - b.in || a.out - b.out,
    '-in': (a, b) => b.in - a.in || b.out - a.out,
    out: (a, b) => a.out - b.out || a.in - b.in,
    '-out': (a, b) => b.out - a.out || b.in - a.in,
    '-ctx': (a, b) => (b.context || 0) - (a.context || 0),
    ctx: (a, b) => (a.context || 0) - (b.context || 0),
    name: (a, b) => a.name.localeCompare(b.name),
    '-name': (a, b) => b.name.localeCompare(a.name),
  }[state.sort] || (() => 0);
  return list.slice().sort(by);
}

function provCell(m) {
  const p = m.zdrProviders || [];
  if (!p.length) return '<span class="tag zdr">ZDR</span>';
  const head = p.slice(0, 3).map((x) => `<span class="tag zdr">${esc(x)}</span>`).join('');
  return `<div class="provs">${head}${p.length > 3 ? `<button class="more" type="button" data-more="${esc(m.id)}" title="${esc(p.join(', '))}">+${p.length - 3}</button>` : ''}</div>`;
}
function checkCell(m) {
  if (!checked) return '';
  const c = checked.get(m.id);
  if (!c) return '';
  const price = c.price === 'match' ? `<span class="tag ok">${pix('check', 9)}Price match</span>`
    : c.price === 'differs' ? `<span class="tag bad" title="OpenRouter now: ${rate(c.oi)} in / ${rate(c.oo)} out">≠ Differs</span><span class="sub">OpenRouter: ${rate(c.oi)} / ${rate(c.oo)}</span>`
    : '<span class="tag">Not listed</span>';
  const zdr = c.zdr == null ? '' : c.zdr ? `<span class="tag ok">${pix('check', 9)}On ZDR list</span>` : '<span class="tag bad">Not on ZDR list</span>';
  return `<div style="display:flex;gap:4px;flex-wrap:wrap">${price}${zdr}</div>`;
}

function render() {
  const list = filtered();
  const rows = list.slice(0, limit);
  const tb = $('#rows');
  tb.innerHTML = list.length ? rows.map((m) => {
    const tags = `${m.freeEligible ? '<span class="tag gold" title="Works with free messages">Free OK</span>' : ''}${m.vision ? '<span class="tag">Vision</span>' : ''}${m.tools ? '<span class="tag">Tools</span>' : ''}`;
    const c = checked?.get(m.id);
    return `<tr${c && c.price === 'differs' ? ' class="diff"' : ''}>
      <td class="c-model"><div class="mn">${esc(m.name)}</div><span class="sub">${esc(m.id)}</span>${tags ? `<div style="display:flex;gap:4px;flex-wrap:wrap;margin-top:6px">${tags}</div>` : ''}</td>
      <td class="c-lab dim">${esc(m._lab)}</td>
      <td class="p c-in">${rate(m.in)}</td>
      <td class="p c-out">${rate(m.out)}</td>
      <td class="p c-ctx">${m.context ? compact(m.context) : '—'}</td>
      <td class="c-prov">${provCell(m)}</td>
      <td class="c-ok ok-cell">${checkCell(m)}</td>
    </tr>`;
  }).join('') : `<tr><td colspan="7"><div class="empty">${pix('ghost', 36)}<span>No model matches these filters.</span></div></td></tr>`;
  $('#more').hidden = list.length <= limit;
  $('#more-btn').textContent = `Show all ${int(list.length)}`;
  $('#shown').textContent = `Showing ${int(Math.min(limit, list.length))} of ${int(list.length)} · ${int(all.length)} in the live catalog`;
  for (const b of document.querySelectorAll('th button[data-sort]')) {
    const k = b.dataset.sort.replace('-', '');
    if (k === state.sort.replace('-', '')) b.dataset.dir = state.sort.startsWith('-') ? '↓' : '↑'; else delete b.dataset.dir;
  }
  $('#sort').value = [...$('#sort').options].some((o) => o.value === state.sort) ? state.sort : 'in';
}

function renderLabs() {
  const counts = new Map();
  for (const m of all) counts.set(m._lab, (counts.get(m._lab) || 0) + 1);
  const top = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10).map(([l]) => l);
  if (state.lab && !top.includes(state.lab)) top.push(state.lab);
  $('#labs').innerHTML = `<button type="button" data-lab="" aria-pressed="${!state.lab}">All labs<span class="n">${int(all.length)}</span></button>`
    + top.map((l) => `<button type="button" data-lab="${esc(l)}" aria-pressed="${state.lab === l}">${esc(l)}<span class="n">${int(counts.get(l) || 0)}</span></button>`).join('');
}

function bind() {
  const q = $('#q');
  q.value = state.q;
  let t;
  q.addEventListener('input', () => { clearTimeout(t); t = setTimeout(() => { state.q = q.value.trim(); limit = PAGE; writeUrl(); render(); }, 120); });
  $('#labs').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-lab]'); if (!b) return;
    state.lab = b.dataset.lab; limit = PAGE;
    for (const x of $('#labs').querySelectorAll('button')) x.setAttribute('aria-pressed', String(x === b));
    writeUrl(); render();
  });
  for (const b of document.querySelectorAll('.flags button')) {
    b.setAttribute('aria-pressed', String(state[b.dataset.f]));
    b.onclick = () => { state[b.dataset.f] = !state[b.dataset.f]; b.setAttribute('aria-pressed', String(state[b.dataset.f])); limit = PAGE; writeUrl(); render(); };
  }
  $('#sort').addEventListener('change', (e) => { state.sort = e.target.value; writeUrl(); render(); });
  for (const b of document.querySelectorAll('th button[data-sort]')) {
    b.onclick = () => {
      const k = b.dataset.sort.replace('-', '');
      const cur = state.sort.replace('-', '');
      state.sort = k === cur ? (state.sort.startsWith('-') ? k : '-' + k) : b.dataset.sort;
      writeUrl(); render();
    };
  }
  $('#rows').addEventListener('click', (e) => {
    const b = e.target.closest('[data-more]'); if (!b) return;
    const m = all.find((x) => x.id === b.dataset.more);
    if (m) b.closest('.provs').innerHTML = m.zdrProviders.map((x) => `<span class="tag zdr">${esc(x)}</span>`).join('');
  });
  $('#more-btn').onclick = () => { limit = Infinity; render(); };
  $('#cmp').onclick = compare;
}

// ---------- Bandingkan dengan OpenRouter (langsung dari browser) ----------
const r4 = (x) => +Number(x).toFixed(4);                  // harga per 1M dibulatkan 4 desimal di kedua sisi
const perM = (x) => r4(Number(x || 0) * 1e6);

async function fetchJson(url) {
  const r = await fetch(url, { cache: 'no-store', credentials: 'omit' });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return (await r.json()).data || [];
}

async function compare() {
  const btn = $('#cmp');
  const out = $('#cmp-out');
  btn.disabled = true;
  btn.textContent = 'Downloading from openrouter.ai…';
  out.innerHTML = '';
  const t0 = performance.now();
  const [orRes, zdrRes] = await Promise.allSettled([fetchJson(OR_MODELS), fetchJson(ZDR_LIST)]);
  const ms = Math.round(performance.now() - t0);
  btn.disabled = false;
  btn.textContent = 'Compare again';

  checked = new Map(all.map((m) => [m.id, { price: 'missing', zdr: null }]));
  // Harga
  if (orRes.status === 'fulfilled') {
    const byId = new Map(orRes.value.map((m) => [m.id, m]));
    let match = 0, differs = 0, missing = 0;
    for (const m of all) {
      const o = byId.get(m.id);
      const c = checked.get(m.id);
      if (!o) { missing++; continue; }
      c.oi = perM(o.pricing?.prompt); c.oo = perM(o.pricing?.completion);
      if (c.oi === r4(m.in) && c.oo === r4(m.out)) { c.price = 'match'; match++; } else { c.price = 'differs'; differs++; }
    }
    const compared = match + differs;
    out.innerHTML = `<div class="score"><span class="big">${int(match)}<span class="of"> of ${int(compared)}</span></span>
        <span class="lbl">${differs ? `prices match · <b class="bad">${int(differs)} differ</b>` : '<b>prices match exactly</b>'}</span></div>
      <dl class="kv" style="margin-top:14px">
        <div><dt>Downloaded from openrouter.ai</dt><dd>${int(orRes.value.length)} models · ${ms} ms</dd></div>
        ${missing ? `<div><dt>Not on OpenRouter's list right now</dt><dd>${int(missing)}<small>our copy refreshes every hour</small></dd></div>` : ''}
        <div><dt>Method</dt><dd>price per token × 1,000,000<small>rounded to 4 decimals on both sides</small></dd></div>
      </dl>
      ${differs ? '<p class="hint" style="margin-top:10px">A difference usually means OpenRouter changed a price in the last hour. You are always billed the exact cost OpenRouter reports for your request. Rows that differ are marked in the table.</p>' : ''}`;
  } else {
    out.innerHTML = `<div class="notice bad" style="margin-top:14px">Your browser could not download OpenRouter's price list (${esc(orRes.reason?.message || 'blocked')}). An ad blocker or strict network can cause this. Open <a class="link" href="${OR_MODELS}" target="_blank" rel="noopener">the list</a> directly: <span class="mono">pricing.prompt × 1,000,000</span> is the input price on this page.</div>`;
  }
  // Daftar ZDR
  const zo = $('#zdr-out');
  if (zdrRes.status === 'fulfilled') {
    const zmap = new Map();
    for (const e of zdrRes.value) {
      if (!zmap.has(e.model_id)) zmap.set(e.model_id, new Set());
      zmap.get(e.model_id).add(e.provider_name);
    }
    let ok = 0, extra = 0;
    for (const m of all) {
      const set = zmap.get(m.id);
      const c = checked.get(m.id);
      c.zdr = !!set?.size;
      if (c.zdr) ok++;
      if (set && (m.zdrProviders || []).some((p) => !set.has(p))) extra++;
    }
    zo.innerHTML = `<div class="score" style="margin-top:0"><span class="big">${int(ok)}<span class="of"> of ${int(all.length)}</span></span>
        <span class="lbl">${ok === all.length ? '<b>every model has a ZDR provider</b>' : `models found · <b class="bad">${int(all.length - ok)} not on the list now</b>`}</span></div>
      <dl class="kv" style="margin-top:14px">
        <div><dt>ZDR endpoints on OpenRouter's list</dt><dd>${int(zdrRes.value.length)}</dd></div>
        ${extra ? `<div><dt>Provider names that differ</dt><dd>${int(extra)} models<small>our copy refreshes every hour</small></dd></div>` : ''}
      </dl>
      <p class="hint" style="margin-top:10px">Even if a list changes, every request carries <span class="mono">provider.zdr: true</span>. OpenRouter then refuses any provider that is not zero-retention.</p>`;
  } else {
    zo.innerHTML = `<div class="notice bad">Your browser could not download the ZDR list (${esc(zdrRes.reason?.message || 'blocked')}). Open <a class="link" href="${ZDR_LIST}" target="_blank" rel="noopener">the list</a> directly and search for a model id.</div>`;
  }
  render();
}

async function init() {
  readUrl();
  try {
    all = await api('/api/models');
    if (!Array.isArray(all)) all = all?.data || [];
  } catch (e) {
    $('#rows').innerHTML = `<tr><td colspan="7"><div class="notice bad">Could not load the catalog (${esc(e.message)}). The GHOSTKEY server may be offline. The raw list lives at <a class="link" href="/api/models">/api/models</a>.</div></td></tr>`;
    $('#cmp').disabled = true;
    return;
  }
  for (const m of all) { m.in = Number(m.in || 0); m.out = Number(m.out || 0); m._lab = labOf(m); m._hay = `${m.name} ${m.id} ${m._lab}`.toLowerCase(); }
  $('#count').textContent = int(all.length);
  $('#nprov').textContent = int(new Set(all.flatMap((m) => m.zdrProviders || [])).size || 0);
  $('#fetched').innerHTML = `loaded ${new Date().toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })} · <a href="/api/models" target="_blank" rel="noopener" class="link">raw JSON</a>`;
  renderLabs();
  bind();
  render();
  if (location.hash === '#compare') document.getElementById('compare')?.scrollIntoView();
}

chrome();
init();
