// Halaman privasi + inspector: kirim contoh permintaan ke POST /api/inspect (gratis, tanpa memanggil model),
// lalu tampilkan berdampingan "You send" vs "OpenRouter receives" dengan kolom yang dibuang/ditambah ditandai.
import { api, chrome, getConfig, esc, int, pix, paintIcons, copy, ZDR_LIST } from '/js/common.js';
import { jsonHtml } from '/js/jsonview.js';

const $ = (s, el = document) => el.querySelector(s);
let cfg = {};
let sampleModel = 'openai/gpt-4o-mini';

const STRIP_LABEL = {
  ip_address: 'IP address', user_agent: 'Device (user agent)', cookies: 'Cookies', wallet_address: 'Wallet address',
  account_id: 'Account ID', user_field: '"user" field', metadata: '"metadata" field',
};

function sample() {
  return JSON.stringify({
    model: sampleModel,
    messages: [
      { role: 'system', content: 'You are a helpful assistant.' },
      { role: 'user', content: 'Summarize my meeting notes in three bullet points.' },
    ],
    user: 'alice@example.com',
    metadata: { wallet: '0x000000000000000000000000000000000000dEaD', plan: 'pro' },
    provider: { zdr: false, data_collection: 'allow' },
    temperature: 0.7,
    max_tokens: 400,
  }, null, 2);
}

// Nilai contoh untuk header yang dikirim browser ke server kami (dan dibuang sebelum ke OpenRouter)
function browserHeaders(notSent) {
  const names = notSent?.length ? notSent : ['x-forwarded-for', 'user-agent', 'cookie', 'accept-language'];
  const out = {};
  for (const n of names) {
    const k = String(n).toLowerCase();
    out[n] = k === 'user-agent' ? navigator.userAgent
      : k === 'cookie' ? 'gk_s=… (your session, if signed in)'
      : /forwarded|real-ip|connecting-ip|^ip/.test(k) ? '(your IP address)'
      : k === 'accept-language' ? (navigator.languages || [navigator.language]).join(',')
      : k === 'host' ? location.host
      : k === 'accept' ? '*/*'
      : k === 'content-type' ? 'application/json'
      : k === 'content-length' ? '(size of your request)'
      : k === 'referer' || k === 'origin' ? location.origin
      : '(added by your browser)';
  }
  return out;
}

async function run() {
  const err = $('#req-err');
  err.hidden = true;
  let req;
  try { req = JSON.parse($('#req').value); }
  catch (e) { err.textContent = `That is not valid JSON: ${e.message}`; err.hidden = false; return; }
  if (!req || typeof req !== 'object' || Array.isArray(req)) { err.textContent = 'Send a JSON object, like the sample.'; err.hidden = false; return; }
  const out = $('#insp-out');
  out.innerHTML = '<p class="loading-line" style="margin-top:20px">Asking the server what it would send</p>';
  let r;
  try { r = await api('/api/inspect', { method: 'POST', body: req }); }
  catch (e) {
    out.innerHTML = `<div class="notice bad" style="margin-top:20px">${e.status && e.status < 500
      ? `The server did not accept this request: ${esc(e.body?.message || e.body?.error?.message || e.message)}`
      : `Could not reach <span class="mono">/api/inspect</span> (${esc(e.message)}). The GHOSTKEY server may be offline. Try again in a minute.`}</div>`;
    return;
  }
  render(req, r);
}

function render(req, r) {
  const ws = r.wouldSend || {};
  const body = ws.body || {};
  const stripped = r.stripped || [];
  const notSent = r.notSent || [];
  // Bandingkan kunci tingkat atas
  const removed = Object.keys(req).filter((k) => !(k in body));
  const replaced = Object.keys(req).filter((k) => k in body && JSON.stringify(req[k]) !== JSON.stringify(body[k]));
  const added = Object.keys(body).filter((k) => !(k in req));

  const left = { headers: browserHeaders(notSent), body: req };
  const leftHtml = jsonHtml(left, {
    maxStr: 300,
    mark: (p) => {
      if (/^headers\.[^.]+$/.test(p)) return { cls: 'rm', note: 'not sent' };
      const k = p.replace(/^body\./, '');
      if (p.startsWith('body.') && !k.includes('.') && !k.includes('[')) {
        if (removed.includes(k)) return { cls: 'rm', note: 'removed' };
        if (k === 'provider' && replaced.includes(k)) return { cls: 'rm', note: 'replaced' };
      }
      return null;
    },
  });
  const rightHtml = jsonHtml({ url: ws.url, headers: ws.headers, body }, {
    maxStr: 300,
    mark: (p) => {
      if (p === 'body.provider') return { cls: 'hl', note: 'forced by GHOSTKEY' };
      if (/^headers\.authorization$/i.test(p)) return { cls: 'hl', note: 'shared key' };
      const k = p.replace(/^body\./, '');
      if (p.startsWith('body.') && !k.includes('.') && !k.includes('[')) {
        if (added.includes(k)) return { cls: 'hl', note: 'added' };
        if (replaced.includes(k) && k !== 'provider') return { cls: 'hl', note: 'changed' };
      }
      return null;
    },
  });
  const zdrOn = body.provider?.zdr === true;
  const dcDeny = body.provider?.data_collection === 'deny';
  const curl = `curl -s ${location.origin}/api/inspect \\\n  -H "Content-Type: application/json" \\\n  -d '${JSON.stringify(req).replace(/'/g, "'\\''")}'`;

  $('#insp-out').innerHTML = `
    <div class="diff-sum">
      <div class="rm"><b>${int(removed.length + notSent.length)}</b>fields and headers removed: ${esc([...notSent, ...removed].join(', ') || 'none')}</div>
      <div class="ad"><b>${zdrOn && dcDeny ? 'ZDR on' : 'ZDR ?'}</b>${zdrOn ? '<span class="mono">provider.zdr: true</span>' : 'provider.zdr missing'}${dcDeny ? ' and <span class="mono">data_collection: "deny"</span>' : ''}, whatever you sent.</div>
      <div><b>${int(stripped.length)}</b>kinds of identity data the server strips on every request: ${esc(stripped.map((s) => STRIP_LABEL[s] || s).join(', '))}.</div>
    </div>
    <div class="legend"><span><i class="l-rm"></i>Removed before it leaves our server</span><span><i class="l-hl"></i>Added or forced by GHOSTKEY</span></div>
    <div class="sides">
      <div>
        <div class="side-h"><h3>${pix('chat', 16)} You send</h3><span class="label">to ghostkey</span></div>
        <pre class="json">${leftHtml}</pre>
      </div>
      <div>
        <div class="side-h"><h3>${pix('shield', 16)} OpenRouter receives</h3><button class="linkbtn" id="cp-right" type="button">Copy JSON</button></div>
        <pre class="json">${rightHtml}</pre>
      </div>
    </div>
    <div class="grid-2" style="margin-top:16px">
      <div class="panel">
        <span class="label">Check the rule yourself</span>
        <p class="body-p" style="margin-top:10px"><code class="inline">zdr: true</code> tells OpenRouter to use only providers on its public Zero Data Retention list. <code class="inline">data_collection: "deny"</code> blocks providers that store or train on prompts.</p>
        <div style="display:flex;gap:16px;flex-wrap:wrap;margin-top:14px"><a class="proof-link" href="${esc(r.zdrList || ZDR_LIST)}" target="_blank" rel="noopener">OpenRouter ZDR list</a><a class="proof-link" href="https://openrouter.ai/docs/features/zdr" target="_blank" rel="noopener">OpenRouter ZDR docs</a></div>
      </div>
      <div class="panel">
        <span class="label">Run it from a terminal</span>
        <div class="code" style="margin-top:10px"><pre>${esc(curl)}</pre><button class="cp" id="cp-curl" type="button">Copy</button></div>
      </div>
    </div>`;
  $('#cp-right').onclick = () => copy(JSON.stringify({ url: ws.url, headers: ws.headers, body }, null, 2), 'JSON copied');
  $('#cp-curl').onclick = () => copy(curl, 'Command copied');
  if (r.code && !$('#code-link').href) setCode(r.code);
}

function setCode(url) {
  if (!url) return;
  const a = $('#code-link');
  a.href = url; a.hidden = false;
  $('#code-none').hidden = true;
}

async function init() {
  paintIcons();
  for (const el of document.querySelectorAll('.flow .who .pix')) el.setAttribute('width', '14');
  cfg = await getConfig();
  const gh = cfg.links?.github;
  if (gh) setCode(`${gh.replace(/\/$/, '')}/blob/main/server/privacy.mjs`);
  // Pakai model yang benar-benar ada di katalog untuk contoh
  try {
    const list = await api('/api/models');
    const arr = Array.isArray(list) ? list : list?.data || [];
    const pick = arr.find((m) => m.id === 'openai/gpt-4o-mini') || arr.find((m) => m.freeEligible) || arr[0];
    if (pick) sampleModel = pick.id;
  } catch {}
  $('#req').value = sample();
  $('#run').onclick = run;
  $('#reset').onclick = () => { $('#req').value = sample(); run(); };
  $('#req').addEventListener('keydown', (e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) run(); });
  run();
}

chrome();
init();
