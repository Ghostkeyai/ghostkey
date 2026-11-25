// Halaman roadmap: isi statis di HTML; bagian ini hanya menyalakan status yang bisa dibaca langsung
// (CA $GHOST dari /api/config, Ghost Credit dari /api/stats) supaya tanda "selesai" tidak pernah dikarang.
import { api, chrome, getConfig, esc, pix, short, copy, tokenUrl, sourcifyUrl, usd } from '/js/common.js';

const $ = (s, el = document) => el.querySelector(s);
const done = (el) => { el.classList.remove('wip'); el.classList.add('done'); $('.st', el).innerHTML = pix('check', 14); };
const wip = (el) => { el.classList.remove('done'); el.classList.add('wip'); $('.st', el).innerHTML = ''; };

function counts() {
  for (const ph of ['shipped', 'now', 'next', 'later']) {
    const items = document.querySelectorAll(`[data-phase="${ph}"] .item`);
    const d = [...items].filter((i) => i.classList.contains('done')).length;
    const t = $(`[data-count="${ph}"]`);
    if (t) t.textContent = d ? `${d} of ${items.length} done` : `${items.length} items`;
  }
}

async function main() {
  chrome();
  $('.rm-ghost').innerHTML = pix('ghost', 36);
  // centang untuk item yang memang sudah selesai di HTML
  for (const el of document.querySelectorAll('.item.done')) done(el);
  const cfg = await getConfig();
  const L = cfg.links || {};

  // GhostLedger → sumber terverifikasi
  if (cfg.ledger) $('#lnk-ledger').href = sourcifyUrl(cfg.ledger), $('#lnk-ledger').target = '_blank', $('#lnk-ledger').rel = 'noopener';
  // Telegram → grup
  if (L.telegram) Object.assign($('#lnk-tg'), { href: L.telegram, target: '_blank', rel: 'noopener', textContent: 'Ask it in the group' });

  // $GHOST: selesai hanya bila CA benar-benar ada
  const tok = $('#it-token');
  if (cfg.ghostToken) {
    done(tok);
    $('#tok-line').innerHTML = `Launched with a fixed 2% creator tax. Contract: <span class="mono">${esc(cfg.ghostToken)}</span>`;
    const pons = L.pons || `https://ponsfamily.com/launchpad/${cfg.ghostToken.toLowerCase()}`;
    $('#tok-links').innerHTML = `<a class="proof-link" href="${esc(pons)}" target="_blank" rel="noopener">Pons</a><a class="proof-link" href="${tokenUrl(cfg.ghostToken)}" target="_blank" rel="noopener">Blockscout</a><button class="chip ok" type="button" id="tok-copy">Copy CA</button>`;
    $('#tok-copy').onclick = () => copy(cfg.ghostToken, 'Contract address copied');
  } else wip(tok);

  // Ghost Credit pertama: selesai bila /api/stats mencatat kredit terbayar
  const cr = $('#it-credit');
  try {
    const s = await api('/api/stats');
    const paid = Number(s.holderCreditPaidUsd || 0);
    if (paid > 0) {
      done(cr);
      $('#credit-note').className = 'live-note ok';
      $('#credit-note').textContent = `${usd(paid)} paid · ${s.hoursPosted} hour${s.hoursPosted === 1 ? '' : 's'} on-chain`;
    } else {
      wip(cr);
      $('#credit-note').textContent = 'In progress · live from /api/stats';
    }
  } catch { wip(cr); }

  // fase "sekarang" juga bertanda berjalan kecuali semuanya sudah selesai
  counts();
  const ask = [];
  if (L.telegram) ask.push(`<a class="btn small" href="${esc(L.telegram)}" target="_blank" rel="noopener">Telegram</a>`);
  if (L.x) ask.push(`<a class="btn small ghost" href="${esc(L.x)}" target="_blank" rel="noopener">X</a>`);
  $('#ask-links').innerHTML = ask.join('');
}
main();
