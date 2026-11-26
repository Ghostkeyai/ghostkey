// Panel "Creator fees, live": saldo fee $GHOST di curve Pons + escrow (on-chain) dan total yang sudah dibagi 25/75.
// Sumber tunggal: /api/fees (server membaca chain + tabel harvests, cache 60 dtk). Disegarkan tiap 60 dtk.
// mountFees(el)               → panel lengkap (halaman $GHOST)
// mountFees(el, { compact })  → satu baris ringkas (landing)
import { api, esc, usd, addrUrl, txUrl, ago } from '/js/common.js';

const ETH = (wei, d = 5) => {
  if (wei == null) return '—';
  const n = Number(BigInt(wei)) / 1e18;
  return (n === 0 ? '0' : n < 10 ** -d ? '<' + (10 ** -d).toFixed(d) : n.toFixed(d)) + ' ETH';
};
const $usd = (v) => (v == null ? '' : `≈ ${usd(v, { max: 2 })}`);

function bar(holdersWei, teamWei, holdersUsd, teamUsd, label) {
  const h = Number(BigInt(holdersWei || '0')), t = Number(BigInt(teamWei || '0'));
  const pct = h + t > 0 ? (h / (h + t)) * 100 : 25;
  return `<div class="fz-split">
    <div class="fz-split-h"><span class="label">${esc(label)}</span></div>
    <div class="fz-bar" aria-hidden="true"><i style="width:${pct.toFixed(2)}%"></i><u></u></div>
    <div class="fz-legs">
      <div class="leg mint"><b>25% · Ghost Credit for holders</b><span class="num">${ETH(holdersWei)}</span><small>${$usd(holdersUsd)}</small></div>
      <div class="leg gold"><b>75% · team wallet</b><span class="num">${ETH(teamWei)}</span><small>${$usd(teamUsd)}</small></div>
    </div>
  </div>`;
}

// ---------- Jam berjalan: satu jam UTC, klaim fee di :50, Ghost Credit jam sebelumnya di :05 ----------
// Hanya hitungan jam lokal (UTC) — tidak menebak status server. "Pembagian terakhir" diambil dari /api/stats.
const pad = (n) => String(n).padStart(2, '0');
const mmss = (sec) => `${Math.floor(sec / 60)}:${pad(sec % 60)}`;
function untilMinute(now, minute) {           // detik sampai menit `minute` berikutnya (UTC)
  const s = now.getUTCMinutes() * 60 + now.getUTCSeconds();
  let d = minute * 60 - s; if (d <= 0) d += 3600; return d;
}
function clockHtml(d) {
  const claim = d.harvestMinute ?? 50, credit = d.creditMinute ?? 5;
  const marks = [[credit, 'credit', 'Credit out'], [15, 'read', ':15'], [30, 'read', ':30'], [45, 'read', ':45'], [claim, 'claim', 'Fee claim'], [60, 'read', ':60']];
  return `<div class="fz-clock" data-claim="${claim}" data-credit="${credit}">
    <div class="fz-clock-h"><span class="label"><i class="fz-dot" aria-hidden="true"></i>This hour, live</span><span class="fz-now num" data-now>--:--:-- UTC</span></div>
    <div class="fz-ruler" aria-hidden="true"><i data-fill></i>${marks.map(([m, k, t]) => `<span class="mk ${k}" style="left:${(m / 60) * 100}%" data-m="${m}"><em>${t}</em></span>`).join('')}</div>
    <div class="fz-cd">
      <div><span class="label gold">Next fee claim · :${pad(claim)}</span><b class="num" data-claim-in>—</b><small>Escrow is claimed and split 25 / 75, each part its own transaction.</small></div>
      <div><span class="label mint">Next Ghost Credit · :${pad(credit)}</span><b class="num" data-credit-in>—</b><small data-credit-for>Credit for the hour that just closed goes to holders.</small></div>
      <div><span class="label">Last payout to holders</span><b class="num" data-last>—</b><small data-last-sub>Reading the ledger</small></div>
    </div>
  </div>`;
}
function tickClock(root) {
  const c = root.querySelector('.fz-clock'); if (!c) return;
  const now = new Date(), claim = +c.dataset.claim, credit = +c.dataset.credit;
  const sec = now.getUTCMinutes() * 60 + now.getUTCSeconds();
  c.querySelector('[data-now]').textContent = `${pad(now.getUTCHours())}:${pad(now.getUTCMinutes())}:${pad(now.getUTCSeconds())} UTC`;
  c.querySelector('[data-fill]').style.width = `${(sec / 3600) * 100}%`;
  for (const mk of c.querySelectorAll('.mk')) mk.classList.toggle('past', +mk.dataset.m * 60 <= sec);
  const ci = untilMinute(now, claim), cr = untilMinute(now, credit);
  // jendela 2 menit sesudah menit target: proses sedang berjalan
  c.querySelector('[data-claim-in]').textContent = 3600 - ci < 120 ? 'Claiming now' : `in ${mmss(ci)}`;
  c.querySelector('[data-credit-in]').textContent = 3600 - cr < 120 ? 'Sending now' : `in ${mmss(cr)}`;
  const h = new Date(now.getTime() + cr * 1000 - 3600_000);   // jam yang dibayar di :05 berikutnya = jam sebelumnya
  c.querySelector('[data-credit-for]').textContent = `At ${pad(new Date(now.getTime() + cr * 1000).getUTCHours())}:${pad(credit)} UTC: credit for ${pad(h.getUTCHours())}:00–${pad((h.getUTCHours() + 1) % 24)}:00 UTC.`;
}
async function lastPayout(root) {
  const c = root.querySelector('.fz-clock'); if (!c) return;
  try {
    const s = await api('/api/stats'); const L = s.lastHour;
    if (!L) { c.querySelector('[data-last-sub]').textContent = 'No hour posted yet.'; return; }
    const st = new Date(L.startsAt), a = pad(st.getUTCHours()), b = pad((st.getUTCHours() + 1) % 24);
    c.querySelector('[data-last]').textContent = usd(L.distributedUsd, { max: 2 });
    c.querySelector('[data-last-sub]').innerHTML = `${a}:00–${b}:00 UTC · ${L.entries} wallet${L.entries === 1 ? '' : 's'}${L.txHash ? ` · <a class="link" href="${txUrl(L.txHash)}" target="_blank" rel="noopener">root tx</a>` : ''} · ${usd(s.holderCreditPaidUsd, { max: 2 })} paid in all`;
  } catch { c.querySelector('[data-last-sub]').textContent = 'Ledger unavailable right now.'; }
}

function full(d) {
  const p = d.pending, c = d.claimed;
  if (!d.token) return '<p class="hint">Creator fees appear here once $GHOST is live.</p>';
  const lastTx = c.last?.claimTx;
  return `${clockHtml(d)}<div class="fz-cells">
      <div><span class="label">In the Pons curve</span><b class="num">${p ? ETH(p.inCurveWei) : '—'}</b><small>${p ? $usd(Number(BigInt(p.inCurveWei)) / 1e18 * (d.ethUsd || 0)) : 'chain unavailable'}</small>
        ${d.curve ? `<a class="proof-link" href="${addrUrl(d.curve)}" target="_blank" rel="noopener">Curve contract</a>` : ''}</div>
      <div><span class="label">Ready in escrow</span><b class="num">${p ? ETH(p.inEscrowWei) : '—'}</b><small>${p && p.inEscrowWei != null ? $usd(Number(BigInt(p.inEscrowWei)) / 1e18 * (d.ethUsd || 0)) : ''}</small>
        ${d.feeWallet ? `<a class="proof-link" href="${addrUrl(d.feeWallet)}" target="_blank" rel="noopener">Fee wallet</a>` : ''}</div>
      <div><span class="label">Claimed and split so far</span><b class="num">${ETH(c.wei)}</b><small>${c.count ? `≈ ${usd(c.usd, { max: 2 })} · ${c.count} claim${c.count === 1 ? '' : 's'}` : 'no claims yet'}</small>
        ${lastTx ? `<a class="proof-link" href="${txUrl(lastTx)}" target="_blank" rel="noopener">Last claim tx</a>` : ''}</div>
    </div>
    ${p ? bar(p.holdersWei, p.teamWei, p.holdersUsd, p.teamUsd, `Waiting now (${ETH(p.totalWei)}) — split at the next claim`) : ''}
    ${c.count ? bar(c.holdersWei, c.teamWei, c.holdersUsd, c.teamUsd, 'Already claimed and sent') : ''}
    <p class="hint fz-note">Pons moves fees from the curve to escrow on its own schedule. Our server claims escrow at minute :${String(d.harvestMinute ?? 50).padStart(2, '0')} every hour and sends 25% to the Ghost Credit pool and 75% to the team wallet, each as its own transaction. Read live from Robinhood Chain · updated ${ago(d.updatedAt)} · <a class="link" href="/api/fees" target="_blank" rel="noopener">/api/fees</a></p>`;
}

function compact(d) {
  const p = d.pending, c = d.claimed;
  if (!d.token || !p) return '';
  return `<span class="fz-dot" aria-hidden="true"></span><span class="label">Live</span>
    <span>Waiting to be claimed: <b class="num">${ETH(p.totalWei, 4)}</b> ${p.totalUsd != null ? `<span class="dim">(${usd(p.totalUsd, { max: 2 })})</span>` : ''}</span>
    <span class="mint">25% holders ${p.holdersUsd != null ? usd(p.holdersUsd, { max: 2 }) : ETH(p.holdersWei, 4)}</span>
    <span class="gold">75% team ${p.teamUsd != null ? usd(p.teamUsd, { max: 2 }) : ETH(p.teamWei, 4)}</span>
    ${c.count ? `<span class="dim">Claimed so far ${usd(c.usd, { max: 2 })}</span>` : ''}
    <a class="proof-link" href="/token#fees">Details</a>`;
}

export function mountFees(el, opts = {}) {
  if (!el) return;
  const draw = async () => {
    try {
      const d = await api('/api/fees'); el.innerHTML = opts.compact ? compact(d) : full(d); el.hidden = opts.compact && !el.innerHTML.trim();
      if (!opts.compact) { tickClock(el); lastPayout(el); }
    } catch { if (!opts.compact) el.innerHTML = '<p class="hint">Could not read fees right now. Try again in a minute.</p>'; }
  };
  draw();
  setInterval(() => { if (!document.hidden) draw(); }, 60_000);
  if (!opts.compact) setInterval(() => { if (!document.hidden) tickClock(el); }, 1000);
}
