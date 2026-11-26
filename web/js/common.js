// GHOSTKEY — modul bersama untuk semua halaman: API, format angka, navigasi/footer, dompet, ikon piksel.
export const EXPLORER = 'https://robinhoodchain.blockscout.com';
export const RPC_URLS = ['https://rpc.mainnet.chain.robinhood.com', 'https://robinhood-rpc.publicnode.com'];
export const CHAIN = {
  chainId: '0x1237', chainName: 'Robinhood Chain',
  nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  rpcUrls: RPC_URLS,
  blockExplorerUrls: [EXPLORER],
};
export const ZDR_LIST = 'https://openrouter.ai/api/v1/endpoints/zdr';
export const OR_MODELS = 'https://openrouter.ai/api/v1/models';

// ---------- API ----------
export async function api(path, { method = 'GET', body, signal } = {}) {
  const r = await fetch(path, {
    method, signal, credentials: 'same-origin',
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  let j = null;
  try { j = await r.json(); } catch {}
  if (!r.ok) { const e = new Error(j?.message || j?.error || `HTTP ${r.status}`); e.status = r.status; e.body = j; throw e; }
  return j;
}

let _config = null;
export async function getConfig() {
  if (!_config) _config = api('/api/config').catch(() => ({}));
  return _config;
}

// ID browser untuk jatah pesan gratis (bukan pelacak; hanya disimpan di browser ini)
export function clientId() {
  try {
    let id = localStorage.getItem('gk_cid');
    if (!id) { id = 'c' + crypto.randomUUID().replace(/-/g, ''); localStorage.setItem('gk_cid', id); }
    return id;
  } catch { return 'c' + Math.random().toString(36).slice(2).padEnd(24, '0'); }
}

// ---------- Format ----------
export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
export function usd(n, { min = 2, max } = {}) {
  if (n == null || Number.isNaN(Number(n))) return '—';
  const v = Number(n);
  const m = max ?? (Math.abs(v) < 0.01 && v !== 0 ? 6 : Math.abs(v) < 1 ? 4 : 2);
  return (v < 0 ? '−$' : '$') + Math.abs(v).toLocaleString('en-US', { minimumFractionDigits: Math.min(min, m), maximumFractionDigits: m });
}
export const int = (n) => (n == null ? '—' : Number(n).toLocaleString('en-US'));
export function compact(n) {
  if (n == null) return '—';
  return Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 }).format(n);
}
export const short = (a, l = 6, r = 4) => (a ? `${a.slice(0, l)}…${a.slice(-r)}` : '');
export const pct = (bps) => `${(Number(bps || 0) / 100).toFixed(bps % 100 ? 1 : 0)}%`;
export const ago = (t) => {
  const s = Math.max(1, Math.round((Date.now() - new Date(t).getTime()) / 1000));
  if (s < 60) return `${s}s ago`; if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`; return `${Math.round(s / 86400)}d ago`;
};
// Tanggal singkat dalam UTC (situs global: tanpa zona lokal tertentu)
export function when(t) {
  const d = new Date(t);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleString('en-GB', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'UTC' }) + ' UTC';
}
// Jam ke-n (floor(unix/3600)) → "25 Nov 14:00–15:00 UTC"
export function hourLabel(h) {
  const d = new Date(Number(h) * 3600_000);
  const day = d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', timeZone: 'UTC' });
  const hh = String(d.getUTCHours()).padStart(2, '0');
  const nx = String((d.getUTCHours() + 1) % 24).padStart(2, '0');
  return `${day} ${hh}:00–${nx}:00 UTC`;
}
// Harga per 1 juta token: ≥ $1 → 2 desimal; di bawahnya sampai 4 desimal tanpa nol berlebih
export function rate(v) {
  if (v == null || Number.isNaN(Number(v))) return '—';
  v = Number(v);
  if (v === 0) return '$0';
  if (v >= 1) return '$' + v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  let s = v.toFixed(4).replace(/0+$/, '');
  if ((s.split('.')[1] || '').length < 2) s = v.toFixed(2);
  return '$' + s;
}
// Nama lab yang rapi dari awalan id OpenRouter (tanpa "~" untuk alias *-latest)
const LABS = {
  openai: 'OpenAI', anthropic: 'Anthropic', google: 'Google', 'x-ai': 'xAI', deepseek: 'DeepSeek', 'meta-llama': 'Meta', meta: 'Meta',
  mistralai: 'Mistral', qwen: 'Qwen', moonshotai: 'Moonshot', 'z-ai': 'Z.ai', minimax: 'MiniMax', cohere: 'Cohere', nvidia: 'NVIDIA',
  perplexity: 'Perplexity', microsoft: 'Microsoft', amazon: 'Amazon', tencent: 'Tencent', baidu: 'Baidu', thinkingmachines: 'Thinking Machines',
};
export function labOf(m) {
  const k = String(m?.id || '').split('/')[0].replace(/^~/, '');
  const raw = String(m?.lab || k || '').replace(/^~/, '');
  return LABS[k] || raw.charAt(0).toUpperCase() + raw.slice(1);
}
export const txUrl = (h) => `${EXPLORER}/tx/${h}`;
export const addrUrl = (a) => `${EXPLORER}/address/${a}`;
export const tokenUrl = (a) => `${EXPLORER}/token/${a}`;
export const blockUrl = (n) => `${EXPLORER}/block/${n}`;
export const sourcifyUrl = (a) => `https://repo.sourcify.dev/contracts/full_match/4663/${a}/`;
export const isAddr = (s) => /^0x[0-9a-fA-F]{40}$/.test(String(s || '').trim());
export const isHash = (s) => /^0x[0-9a-fA-F]{64}$/.test(String(s || '').trim());

export function toast(msg, ms = 2600) {
  let t = document.querySelector('.toast');
  if (!t) { t = document.createElement('div'); t.className = 'toast'; t.setAttribute('role', 'status'); document.body.appendChild(t); }
  t.textContent = msg; t.classList.add('show');
  clearTimeout(t._h); t._h = setTimeout(() => t.classList.remove('show'), ms);
}
export async function copy(text, label = 'Copied') {
  try { await navigator.clipboard.writeText(text); toast(label); } catch { prompt('Copy:', text); }
}
// Unduh objek sebagai berkas JSON (dibuat di browser, tanpa server)
export function downloadJson(obj, name) {
  const blob = new Blob([JSON.stringify(obj, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob); a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}

// ---------- Ikon piksel (SVG crispEdges dari peta karakter) ----------
// '#' = warna teks, 'o' = gelap (mata), 'b' = rona pipi, 'g' = emas
const PAL = { '#': 'currentColor', o: '#0d1411', b: '#ff9db2', g: '#ffd27a', m: '#9ff0c8' };
function pixPaths(rows) {
  const by = {};
  rows.forEach((row, y) => {
    let x = 0;
    while (x < row.length) {
      const c = row[x];
      if (!PAL[c]) { x++; continue; }
      let w = 1; while (row[x + w] === c) w++;
      (by[c] ||= []).push(`M${x} ${y}h${w}v1h-${w}z`);
      x += w;
    }
  });
  return Object.entries(by).map(([c, d]) => `<path fill="${PAL[c]}" d="${d.join('')}"/>`).join('');
}
const SPRITES = {
  check: ['........', '.......#', '......##', '#....##.', '##..##..', '.####...', '..##....', '........'],
  cross: ['........', '.##..##.', '..####..', '...##...', '..####..', '.##..##.', '........', '........'],
  copy: ['..#####.', '..#...#.', '#####.#.', '#...#.#.', '#...###.', '#...#...', '#####...', '........'],
  ext: ['...#####', '.....###', '....##.#', '...##..#', '..##....', '.##.....', '##......', '........'],
  arrow: ['........', '....#...', '....##..', '#######.', '#######.', '....##..', '....#...', '........'],
  lock: ['..####..', '.#....#.', '.#....#.', '########', '###..###', '###..###', '########', '........'],
  eye: ['........', '..####..', '.#....#.', '#..##..#', '#..##..#', '.#....#.', '..####..', '........'],
  shield: ['########', '#......#', '#.#..#.#', '#..##..#', '#......#', '.#....#.', '..####..', '........'],
  down: ['...##...', '...##...', '...##...', '.######.', '..####..', '...##...', '........', '########'],
  trash: ['..####..', '########', '.#....#.', '.#.#.##.', '.#.#.##.', '.#.#.##.', '.######.', '........'],
  key: ['.###....', '#...#...', '#...#####', '#...#.#.#', '.###.....', '.........', '.........', '.........'],
  chat: ['########', '#......#', '#.####.#', '#......#', '#.###..#', '########', '.##.....', '.#......'],
  coin: ['..####..', '.#....#.', '#..##..#', '#.#..#.#', '#..##..#', '#....#.#', '.#....#.', '..####..'],
  search: ['.####...', '#....#..', '#....#..', '#....#..', '.####...', '.....##.', '......##', '.......#'],
  plus: ['........', '...##...', '...##...', '.######.', '.######.', '...##...', '...##...', '........'],
  clock: ['..####..', '.#....#.', '#...#..#', '#...#..#', '#...###.', '#......#', '.#....#.', '..####..'],
  warn: ['...##...', '...##...', '..#..#..', '..#..#..', '.#.##.#.', '.#....#.', '#..##..#', '########'],
  doc: ['#####...', '#...##..', '#....##.', '#.###.#.', '#......#', '#.####.#', '#......#', '########'],
  link: ['........', '.###....', '#...#...', '#..###..', '.###..#.', '....#..#', '....###.', '........'],
  menu: ['........', '########', '........', '########', '........', '########', '........', '........'],
  // maskot GHOSTKEY: kepala bulat, mata bulat berkilau, senyum, pipi merona, kunci emas di tangan kanan
  ghost: [
    '.....####.......',
    '...########.....',
    '..##########....',
    '.############...',
    '.###oo###oo##...',
    '.##o#o##o#o##...',
    '.###oo###oo##.gg',
    '.#b###oo###b#g.g',
    '##############gg',
    '.############.g.',
    '.############.g.',
    '.############.gg',
    '.############...',
    '.#####.####.##..',
    '..###...##...#..',
  ],
};
export function pix(name, size = 16, cls = 'pix') {
  const rows = SPRITES[name];
  if (!rows) return '';
  const w = Math.max(...rows.map((r) => r.length)), h = rows.length;
  return `<svg class="${cls}" viewBox="0 0 ${w} ${h}" width="${size}" height="${Math.round((size * h) / w)}" shape-rendering="crispEdges" aria-hidden="true">${pixPaths(rows)}</svg>`;
}

// Ganti elemen bertanda data-pix="nama" dengan ikon; bila elemen berisi teks, ikon disisipkan di depannya
export function paintIcons(root = document, size = 14) {
  for (const el of root.querySelectorAll('[data-pix]')) {
    const svg = pix(el.dataset.pix, Number(el.dataset.size) || size);
    if (el.textContent.trim()) { el.insertAdjacentHTML('afterbegin', svg); el.removeAttribute('data-pix'); }
    else el.outerHTML = svg;
  }
}

// Logo: hantu piksel memegang kunci emas (sama dengan foto profil X), ukuran asli 44×36 → tajam tanpa blur
export const MARK = '<img class="mark" src="/img/ghost.svg" width="44" height="36" alt="" aria-hidden="true">';

// Favicon hantu bila halaman belum memasang sendiri
function ensureFavicon() {
  if (document.querySelector('link[rel~="icon"]')) return;
  const l = document.createElement('link');
  l.rel = 'icon'; l.type = 'image/svg+xml'; l.href = '/img/favicon.svg';
  document.head.appendChild(l);
}

// ---------- Navigasi & footer ----------
const NAV = [
  ['/app', 'Chat'], ['/models', 'Models'], ['/privacy', 'Privacy'], ['/token', '$GHOST'], ['/proof', 'Proof'], ['/roadmap', 'Roadmap'], ['/docs', 'Docs'],
];

export async function chrome() {
  ensureFavicon();
  const here = location.pathname.replace(/\.html$/, '').replace(/\/$/, '') || '/';
  // latar piksel hidup (bukan di halaman chat supaya fokus)
  if (!here.startsWith('/app')) import('./pxbg.js').then((m) => m.mountPixelBg()).catch(() => {});
  const head = document.getElementById('nav');
  if (head) {
    head.classList.add('nav');
    head.innerHTML = `<div class="wrap">
      <a class="brand" href="/" aria-label="GHOSTKEY home">${MARK}<b>GHOSTKEY</b></a>
      <nav class="nav-links" aria-label="Main">${NAV.map(([h, t]) => `<a href="${h}"${h === '/token' ? ' class="nav-ghost"' : ''}${here.startsWith(h) ? ' aria-current="page"' : ''}>${t}</a>`).join('')}</nav>
      <div class="nav-right"><span id="nav-soc" class="nav-soc"></span><span id="nav-ca"></span><span id="nav-acct"></span></div>
      <button class="nav-burger" aria-label="Menu" aria-expanded="false"><span></span><span></span><span></span></button>
    </div>`;
    const burger = head.querySelector('.nav-burger');
    burger.onclick = () => { const o = head.classList.toggle('open'); burger.setAttribute('aria-expanded', String(o)); };
  }
  const foot = document.getElementById('foot');
  const cfg = await getConfig();
  const L = cfg.links || {};
  if (head) {
    // Tautan sosial (ikon X & Telegram) — hanya bila diisi di config
    const ic = {
      x: '<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M17.75 3h3.07l-6.7 7.66L22 21h-6.17l-4.83-6.32L5.47 21H2.4l7.17-8.2L2 3h6.33l4.37 5.78L17.75 3Zm-1.08 16.2h1.7L7.4 4.73H5.58L16.67 19.2Z"/></svg>',
      tg: '<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M21.94 4.3 18.9 19.1c-.23 1.03-.84 1.29-1.7.8l-4.7-3.46-2.27 2.18c-.25.25-.46.46-.94.46l.34-4.8 8.73-7.89c.38-.34-.08-.53-.59-.19L6.98 13.04 2.33 11.6c-1.01-.32-1.03-1.01.21-1.5l18.17-7c.84-.31 1.58.2 1.23 1.2Z"/></svg>',
      gh: '<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M12 2a10 10 0 0 0-3.16 19.49c.5.09.68-.22.68-.48v-1.7c-2.78.6-3.37-1.34-3.37-1.34-.45-1.16-1.11-1.47-1.11-1.47-.91-.62.07-.6.07-.6 1 .07 1.53 1.03 1.53 1.03.9 1.52 2.34 1.08 2.91.83.09-.65.35-1.08.63-1.33-2.22-.25-4.55-1.11-4.55-4.94 0-1.09.39-1.98 1.03-2.68-.1-.25-.45-1.27.1-2.65 0 0 .84-.27 2.75 1.02a9.6 9.6 0 0 1 5 0c1.91-1.29 2.75-1.02 2.75-1.02.55 1.38.2 2.4.1 2.65.64.7 1.03 1.59 1.03 2.68 0 3.84-2.34 4.68-4.57 4.93.36.31.68.92.68 1.85v2.74c0 .27.18.58.69.48A10 10 0 0 0 12 2Z"/></svg>',
    };
    head.querySelector('#nav-soc').innerHTML =
      (L.x ? `<a href="${esc(L.x)}" target="_blank" rel="noopener" aria-label="GHOSTKEY on X" title="X">${ic.x}</a>` : '') +
      (L.telegram ? `<a href="${esc(L.telegram)}" target="_blank" rel="noopener" aria-label="GHOSTKEY on Telegram" title="Telegram">${ic.tg}</a>` : '') +
      (L.github ? `<a href="${esc(L.github)}" target="_blank" rel="noopener" aria-label="GHOSTKEY source code on GitHub" title="Source code on GitHub">${ic.gh}</a>` : '');
    // Chip CA: sesudah launch alamat + salin; sebelumnya status jujur "belum terbit"
    if (cfg.ghostToken) {
      head.querySelector('#nav-ca').innerHTML = `<button class="ca-chip" title="Copy $GHOST contract address"><span>CA</span><b>${short(cfg.ghostToken)}</b><span class="copy">Copy</span></button>`;
      head.querySelector('.ca-chip').onclick = () => copy(cfg.ghostToken, 'Contract address copied');
    } else {
      head.querySelector('#nav-ca').innerHTML = `<span class="ca-chip pending" title="The $GHOST contract address is posted here at launch"><span>CA</span><b>$GHOST · at launch</b></span>`;
    }
    renderAccount();
  }
  if (foot) {
    const ext = (href, t) => (href ? `<a href="${esc(href)}" target="_blank" rel="noopener">${t}</a>` : '');
    foot.classList.add('footer');
    foot.innerHTML = `<div class="wrap">
      <div class="cols">
        <div>
          <a class="brand" href="/">${MARK}<b>GHOSTKEY</b></a>
          <p class="foot-about">200+ AI models. None of you. One balance at OpenRouter's price, with your wallet, IP and device removed before any model sees your question. Robinhood Chain.</p>
          ${cfg.ghostToken ? `<p class="foot-ca mono">$GHOST <a class="link" href="${tokenUrl(cfg.ghostToken)}" target="_blank" rel="noopener">${cfg.ghostToken}</a></p>` : `<p class="foot-ca mono dim">$GHOST contract: not launched yet</p>`}
        </div>
        <div><h4>Product</h4><a href="/app">Chat</a><a href="/models">Models &amp; prices</a><a href="/privacy">Privacy inspector</a><a href="/account">Balance &amp; API key</a></div>
        <div><h4>Verify</h4><a href="/proof">Proof</a><a href="/token">Ghost Credit ledger</a><a href="/report">Fee report</a><a href="/roadmap">Roadmap</a><a href="/api/stats" target="_blank" rel="noopener">/api/stats</a><a href="/v1/models" target="_blank" rel="noopener">/v1/models</a></div>
        <div><h4>Community</h4>${ext(L.x, 'X')}${ext(L.telegram, 'Telegram')}${ext(L.github, 'GitHub')}${ext(L.pons, '$GHOST on Pons')}<a href="/docs">Docs</a><a href="/llms.txt">llms.txt</a></div>
      </div>
      <div class="legal"><span>Your GHOSTKEY balance is prepaid AI credit held by the GHOSTKEY server. It is not a deposit, an investment or a token.</span><span><a href="/docs#terms">Terms</a> · <a href="/docs#privacy">Privacy</a></span></div>
    </div>`;
  }
}

// ---------- Akun ----------
let _me;                      // Promise hasil /api/me (satu permintaan dipakai bersama semua pemanggil)
export function me(force = false) {
  if (_me === undefined || force) _me = api('/api/me').catch(() => null);
  return _me;
}

export async function renderAccount() {
  const slot = document.getElementById('nav-acct');
  if (!slot) return;
  const m = await me();
  if (m) {
    slot.innerHTML = `<a class="btn small ghost acct-btn" href="/account" title="Your account"><span class="num">${usd(m.balanceUsd)}</span><span class="dim">·</span><span class="mono">${short(m.wallet, 4, 4)}</span></a>`;
  } else {
    slot.innerHTML = `<button class="btn small" id="nav-connect">Sign in</button>`;
    slot.querySelector('#nav-connect').onclick = () => signIn().then(() => location.reload()).catch((e) => e?.message && toast(e.message));
  }
}

// ---------- Dompet (EIP-6963 + window.ethereum) ----------
const found = new Map();      // rdns → { info, provider }
window.addEventListener('eip6963:announceProvider', (ev) => {
  const d = ev.detail;        // jangan dimutasi: objeknya dibekukan oleh spesifikasi
  if (d?.info?.rdns && d.provider) found.set(d.info.rdns, d);
});
window.dispatchEvent(new Event('eip6963:requestProvider'));

let activeProvider = null;
export const provider = () => activeProvider;

function pickWallet() {
  return new Promise((resolve, reject) => {
    window.dispatchEvent(new Event('eip6963:requestProvider'));
    setTimeout(() => {
      const list = [...found.values()];
      if (!list.length && window.ethereum) return resolve(window.ethereum);
      if (list.length === 1) return resolve(list[0].provider);
      if (!list.length) return reject(new Error('No wallet found. Install MetaMask, Rabby or Phantom.'));
      const back = document.createElement('div');
      back.className = 'modal-back open';
      back.innerHTML = `<div class="modal" role="dialog" aria-modal="true" aria-label="Connect a wallet"><h3>Connect a wallet</h3><p class="muted">Signing in is free. It sends no transaction.</p>
        <div class="wallet-list">${list.map((w, i) => `<button data-i="${i}"><img src="${esc(w.info.icon)}" alt=""><span>${esc(w.info.name)}</span></button>`).join('')}</div>
        <button class="btn small ghost" style="margin-top:16px" data-x>Cancel</button></div>`;
      document.body.appendChild(back);
      back.onclick = (e) => {
        const b = e.target.closest('button');
        if (e.target === back || b?.hasAttribute('data-x')) { back.remove(); reject(new Error('')); }
        else if (b?.dataset.i) { back.remove(); resolve(list[Number(b.dataset.i)].provider); }
      };
    }, 180);
  });
}

export async function connect() {
  const p = await pickWallet();
  const accts = await p.request({ method: 'eth_requestAccounts' });
  if (!accts?.length) throw new Error('No account selected');
  activeProvider = p;
  return accts[0];
}

const toHex = (s) => '0x' + Array.from(new TextEncoder().encode(s), (b) => b.toString(16).padStart(2, '0')).join('');

// Masuk: tanda tangan pesan (gratis, tanpa gas, tanpa pindah jaringan)
export async function signIn() {
  const wallet = await connect();
  const { message } = await api(`/api/auth/nonce?wallet=${wallet}`);
  const signature = await activeProvider.request({ method: 'personal_sign', params: [toHex(message), wallet] });
  await api('/api/auth/verify', { method: 'POST', body: { wallet, signature } });
  _me = undefined;
  return me(true);
}

export async function signOut() {
  await api('/api/auth/logout', { method: 'POST' }).catch(() => {});
  _me = undefined; location.reload();
}

// Pastikan dompet di Robinhood Chain sebelum transaksi
export async function ensureChain() {
  if (!activeProvider) await connect();
  const p = activeProvider;
  const cur = await p.request({ method: 'eth_chainId' });
  if (cur === CHAIN.chainId) return;
  try {
    await p.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: CHAIN.chainId }] });
  } catch (e) {
    if (e?.code === 4001) throw new Error('Network switch was rejected.');
    try { await p.request({ method: 'wallet_addEthereumChain', params: [CHAIN] }); }
    catch {
      if (p.isPhantom) throw new Error('In Phantom: Settings → Active Networks → turn on Robinhood Chain, then try again.');
      throw new Error('Please add Robinhood Chain (chain 4663) to your wallet.');
    }
  }
}

export async function sendTx(tx) {
  await ensureChain();
  const [from] = await activeProvider.request({ method: 'eth_accounts' });
  return activeProvider.request({ method: 'eth_sendTransaction', params: [{ from, ...tx }] });
}

// Kirim ETH atau USDG ke alamat tertentu (dipakai halaman isi saldo)
export const USDG = '0x5fc5360d0400a0fd4f2af552add042d716f1d168';
export async function payEth(to, wei) {
  return sendTx({ to, value: '0x' + BigInt(wei).toString(16) });
}
export async function payUsdg(to, amountMicro) {
  const data = '0xa9059cbb' + to.toLowerCase().replace(/^0x/, '').padStart(64, '0') + BigInt(amountMicro).toString(16).padStart(64, '0');
  return sendTx({ to: USDG, data, value: '0x0' });
}

// Panggilan baca on-chain langsung dari browser (tanpa dompet): coba RPC satu per satu
export async function ethCall(to, data) {
  let last;
  for (const url of RPC_URLS) {
    try {
      const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_call', params: [{ to, data }, 'latest'] }) });
      const j = await r.json();
      if (j.error) throw new Error(j.error.message || 'RPC error');
      return { result: j.result, rpc: url };
    } catch (e) { last = e; }
  }
  throw last || new Error('RPC unreachable');
}
