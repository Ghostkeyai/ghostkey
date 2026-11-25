// Halaman /proof — HTML utuh dirender server dari DB + config pada tiap permintaan.
// Bisa dibaca tanpa JavaScript (crawler, penilai AI, curl). Skrip modul di akhir hanya menghidupkan navigasi
// (tombol akun, chip CA); isi halaman tidak bergantung padanya.
import { config } from './config.mjs';
import { schemaColumns } from './db.mjs';
import { proofData, txUrl } from './public.mjs';

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const isHash = (s) => /^0x[0-9a-fA-F]{64}$/.test(String(s || ''));
const short = (s, l = 8, r = 6) => (s ? `${s.slice(0, l)}…${s.slice(-r)}` : '');
const ext = (href, text) => `<a class="proof-link" href="${esc(href)}" target="_blank" rel="noopener">${text}</a>`;
const int = (n) => Number(n || 0).toLocaleString('en-US');
const usd = (v) => {
  const a = Math.abs(Number(v || 0));
  return '$' + a.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: a !== 0 && a < 0.01 ? 6 : 2 });
};
const pct = (bps) => `${Number(bps) / 100}%`;
const hourTime = (h) => new Date(h * 3_600_000).toISOString().slice(0, 16).replace('T', ' ') + ' UTC';
const txLink = (h) => (isHash(h) ? `<a class="proof-link mono" href="${txUrl(h)}" target="_blank" rel="noopener" title="${h}">${short(h)}</a>` : '<span class="dim">—</span>');

// Kartu alamat: alamat penuh + tautan, atau status jujur bila belum ada
function addrCard(label, note, obj, missing, extra = '') {
  const body = obj
    ? `<p class="addr">${esc(obj.address)}</p><p class="links">${ext(obj.url, 'Blockscout')}${extra}</p>`
    : `<p><span class="chip wait">${esc(missing)}</span></p>`;
  return `<div class="card pf-addr"><p class="kicker">${esc(label)}</p><p class="note">${note}</p>${body}</div>`;
}

const STATUS = { posted: ['ok', 'Posted on-chain'], pending: ['wait', 'Credited, on-chain post pending'], no_fees: ['', 'No fees this hour'], no_holders: ['', 'No eligible holders, pool rolls over'] };

export async function renderProof() {
  const d = await proofData();
  const s = d.stats;
  const c = d.code;
  const gh = (url, text) => (url ? ext(url, text) : `<span class="dim">${text} (source link added at launch)</span>`);
  const L = d.contracts.ledger, T = d.contracts.token, W = d.wallets;

  // --- Tabel klaim → cara cek ---
  const rows = [
    ['Same price as OpenRouter. No markup.',
      `Each answer bills the <code>usage.cost</code> that OpenRouter returns for that call. Compare our rates with theirs.`,
      [ext(d.checks.models, 'Our rates (/api/models)'), ext(d.checks.openrouterModels, 'OpenRouter rates'),
        gh(c.comparePrices, 'Script: compare-prices.mjs')]],
    ['No top-up fee.',
      'A $20 top-up gives $20 of balance. The quote shows a fee of 0.',
      [ext(d.checks.depositQuote, 'Live quote'), W.treasury ? ext(W.treasury.url, 'Treasury on Blockscout') : '<span class="dim">Treasury: not set yet</span>']],
    ['Only zero-retention providers.',
      'Zero Data Retention means the provider keeps nothing after answering. Every request forces <code>provider.zdr = true</code>, so OpenRouter only routes to providers on its public ZDR list.',
      [ext(d.checks.zdrList, 'OpenRouter ZDR list'), ext('/privacy', 'Inspector'), gh(c.privacy, 'privacy.mjs')]],
    ['Your wallet, IP and device never reach the model.',
      'The request to OpenRouter is built in one function. It uses our shared key and fixed headers. Paste any request into the inspector to see the exact body we would send.',
      [ext('/privacy', 'Try the inspector'), gh(c.privacy, 'privacy.mjs')]],
    ['We do not store your prompts or answers.',
      'We keep the model name, token count, cost, time and OpenRouter\'s generation ID (so each cost can be checked against OpenRouter\'s own record). There is no column for text anywhere in the database (live list below).',
      [ext(d.checks.export, 'Download your data (/api/me/export)'), gh(c.schema, 'db.mjs schema')]],
    [`${pct(d.split.holderShareBps)} of $GHOST fees become Ghost Credit, every hour.`,
      'Each hour we publish who got what as JSON, and post its Merkle root to the GhostLedger contract. Anyone can recompute it.',
      [L ? ext(L.url, 'GhostLedger on Blockscout') : '<span class="dim">GhostLedger: not deployed yet</span>',
        L ? ext(L.sourcify, 'Verified source (Sourcify)') : '',
        ext(d.checks.ledger, 'Hourly JSON (/api/ledger)'), gh(c.recompute, 'Script: recompute-hour.mjs')]],
    ['Each trade costs 3%: the 1% Pons fee plus a 2% creator tax.',
      'Pons locks the creator tax when the token launches. Nobody can raise it later. The script reads it straight from the Pons factory contract, together with the fee wallet that receives it.',
      [T?.pons ? ext(T.pons, '$GHOST on Pons') : '<span class="dim">$GHOST: launches soon</span>',
        T ? ext(T.url, 'Token on Blockscout') : '', gh(c.feeRecipient, 'Script: fee-recipient.mjs')]],
    [`Fee split: ${pct(d.split.holderShareBps)} holders, ${pct(d.split.ownerShareBps)} team.`,
      'Creator fees go to one fee wallet. Each hour it claims them and sends the two shares on-chain. The transactions are listed below.',
      [W.fee ? ext(W.fee.url, 'Fee wallet') : '<span class="dim">Fee wallet: launches soon</span>',
        W.treasury ? ext(W.treasury.url, 'Treasury (holder share)') : '',
        W.owner ? ext(W.owner.url, 'Owner wallet (team share)') : '', gh(c.harvester, 'harvester.mjs')]],
  ];
  const claimTable = `<div class="table-scroll"><table class="pf-table">
    <thead><tr><th scope="col">Claim</th><th scope="col">How to check it yourself</th></tr></thead>
    <tbody>${rows.map(([claim, how, links]) => `<tr><th scope="row">${claim}</th><td><p>${how}</p><p class="links">${links.filter(Boolean).join('')}</p></td></tr>`).join('')}</tbody>
  </table></div>`;

  // --- Alamat ---
  const addrs = `<div class="pf-grid">
    ${addrCard('$GHOST token', 'The coin. Trading it pays a creator fee.', T, 'Launches soon', T?.pons ? ext(T.pons, 'Pons') : '')}
    ${addrCard('GhostLedger contract', 'Stores each hour\'s Merkle root. No owner, no upgrades.', L, 'Not deployed yet', L ? ext(L.sourcify, 'Sourcify') : '')}
    ${addrCard('Fee wallet', 'Receives the $GHOST creator fee from Pons.', W.fee, 'Launches soon')}
    ${addrCard('Treasury', `Receives top-ups and the ${pct(d.split.holderShareBps)} holder share.`, W.treasury, 'Not set yet')}
    ${addrCard('Owner wallet', `Receives the ${pct(d.split.ownerShareBps)} team share.`, W.owner, 'Not set yet')}
    <div class="card pf-addr"><p class="kicker">Team wallets</p><p class="note">Excluded from Ghost Credit.</p>
      ${W.team.length ? W.team.map((t) => `<p class="addr">${esc(t.address)}</p><p class="links">${ext(t.url, 'Blockscout')}</p>`).join('') : '<p><span class="chip">None listed</span></p>'}
    </div>
  </div>`;

  // --- Jam terakhir ---
  const hours = d.latestHours.length
    ? `<div class="table-scroll"><table class="pf-table num">
      <thead><tr><th scope="col">Hour (UTC)</th><th scope="col">Pool</th><th scope="col">Wallets</th><th scope="col">Status</th><th scope="col">JSON</th><th scope="col">On-chain</th></tr></thead>
      <tbody>${d.latestHours.map((h) => {
        const [cls, label] = STATUS[h.status] || ['', h.status];
        return `<tr><td>${hourTime(h.hour)}</td><td>${usd(h.poolUsd)}</td><td>${int(h.entries)}</td>
          <td><span class="chip ${cls}">${esc(label)}</span></td>
          <td>${h.status === 'no_fees' ? '<span class="dim">—</span>' : ext(`/api/ledger/${h.hour}`, `hour-${h.hour}`)}</td><td>${txLink(h.txHash)}</td></tr>`;
      }).join('')}</tbody></table></div>`
    : '<p class="card pf-empty">No hours posted yet.</p>';

  // --- Panen terakhir ---
  const harvests = d.harvests.length
    ? `<div class="table-scroll"><table class="pf-table num">
      <thead><tr><th scope="col">Hour (UTC)</th><th scope="col">Claimed</th><th scope="col">Holders</th><th scope="col">Team</th><th scope="col">Transactions</th></tr></thead>
      <tbody>${d.harvests.map((h) => `<tr><td>${hourTime(h.hour)}</td><td>${usd(h.usd)}</td><td>${usd(h.holderUsd)}</td><td>${usd(h.ownerUsd)}</td>
        <td class="links">${h.txs.map((x) => `<span class="txk">${esc(x.kind.replace('_', ' '))}</span> ${txLink(x.txHash)}`).join('<br>')}</td></tr>`).join('')}</tbody></table></div>`
    : '<p class="card pf-empty">No fees harvested yet.</p>';

  // --- Skema DB (bukti tanpa kolom isi chat) ---
  const schema = schemaColumns();
  const schemaHtml = `<div class="pf-schema">${Object.entries(schema).map(([t, cols]) =>
    `<div class="card"><p class="kicker">${esc(t)}</p><p class="mono cols">${cols.map(esc).join(', ')}</p></div>`).join('')}</div>`;

  const stat = (k, v) => `<div class="card pf-stat"><p class="kicker">${k}</p><p class="v px">${v}</p></div>`;
  const stats = `<div class="pf-stats">
    ${stat('Messages', int(s.messages))}${stat('Tokens served', int(s.tokensServed))}${stat('Billed at OpenRouter price', usd(s.billedUsd))}
    ${stat('Accounts', int(s.accounts))}${stat('Ghost Credit paid', usd(s.holderCreditPaidUsd))}${stat('Hours posted', int(s.hoursPosted))}
  </div>`;

  const limits = [
    'Privacy covers who you are, not what you write. The model still reads your question to answer it.',
    'Zero Data Retention is the provider\'s policy, listed publicly by OpenRouter. OpenRouter screens for illegal content as the law requires.',
    'Your balance is held by GHOSTKEY\'s server as prepaid credit. It is not a token in your wallet.',
    'We keep your wallet address because top-ups and Ghost Credit need it.',
    'Ghost Credit is platform credit for AI, not money. It depends on how much $GHOST is traded. Nothing here promises a price or profit.',
  ];

  const navLinks = [['/app', 'Chat'], ['/models', 'Models'], ['/privacy', 'Privacy'], ['/token', '$GHOST'], ['/proof', 'Proof'], ['/roadmap', 'Roadmap'], ['/docs', 'Docs']];
  const updated = new Date(d.updatedAt).toISOString().slice(0, 16).replace('T', ' ');

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Proof · GHOSTKEY</title>
<meta name="description" content="Every GHOSTKEY claim next to a way to check it yourself: prices, zero-retention routing, what we store, and the hourly Ghost Credit ledger.">
<meta property="og:title" content="Proof · GHOSTKEY">
<meta property="og:description" content="Every claim next to a way to check it yourself.">
<meta property="og:image" content="${esc(config.publicUrl)}/img/og.png">
<link rel="icon" href="/img/favicon.svg" type="image/svg+xml">
<link rel="stylesheet" href="/css/base.css">
<link rel="stylesheet" href="/css/chrome.css">
<style>
  .pf main { padding: 56px 0 96px; }
  .pf .dim { color: var(--faint); }
  .pf code { font: 400 .9em var(--font-mono); color: var(--mint); }
  .pf-hero { margin-bottom: 48px; }
  .pf-hero .h2 { margin: 16px 0 14px; }
  .pf-sec { margin-top: 72px; }
  .pf-sec > .h3 { margin: 12px 0 18px; }
  .pf-sec > p.lead { margin: -6px 0 20px; font-size: 16px; }
  .table-scroll { overflow-x: auto; border: 1px solid var(--line); background: var(--bg-2); }
  .pf-table { width: 100%; border-collapse: collapse; font-size: 14px; }
  .pf-table th, .pf-table td { text-align: left; vertical-align: top; padding: 16px; border-bottom: 1px solid var(--line); }
  .pf-table thead th { font: 400 11px/1 var(--font-pixel); text-transform: uppercase; letter-spacing: .05em; color: var(--dim); }
  .pf-table tbody th { font-weight: 400; width: 32%; color: var(--ink); }
  .pf-table td p + p { margin-top: 10px; }
  .pf-table.num td { white-space: nowrap; }
  .links { display: flex; flex-wrap: wrap; gap: 8px 18px; }
  td.links { display: table-cell; line-height: 1.9; }
  .txk { font: 400 10px/1 var(--font-pixel); text-transform: uppercase; color: var(--faint); }
  .pf-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(320px, 1fr)); gap: 12px; }
  .pf-addr { padding: 18px; display: grid; gap: 10px; align-content: start; }
  .pf-addr .note { color: var(--dim); font-size: 14px; }
  .pf-stats { display: grid; grid-template-columns: repeat(auto-fill, minmax(180px, 1fr)); gap: 12px; }
  .pf-stat { padding: 18px; }
  .pf-stat .v { font-size: 28px; margin-top: 10px; }
  .pf-schema { display: grid; grid-template-columns: repeat(auto-fill, minmax(260px, 1fr)); gap: 12px; }
  .pf-schema .card { padding: 14px; }
  .pf-schema .cols { margin-top: 8px; font-size: 12px; color: var(--dim); word-break: break-word; }
  .pf-empty { padding: 18px; color: var(--dim); }
  .pf-limits { display: grid; gap: 10px; list-style: none; }
  .pf-limits li { padding: 14px 18px; background: var(--bg-2); border: 1px solid var(--line); color: var(--dim); }
  .pf-foot { margin-top: 56px; color: var(--faint); font-size: 13px; }
  @media (max-width: 640px) {
    .pf-table tbody th { width: auto; }
    .pf-table, .pf-table tbody, .pf-table tr, .pf-table th, .pf-table td { display: block; }
    .pf-table thead { display: none; }
    .pf-table.num td { white-space: normal; }
    .pf-grid { grid-template-columns: 1fr; }
  }
</style>
</head>
<body class="pf">
<header id="nav" class="nav"><div class="wrap">
  <a class="brand" href="/" aria-label="GHOSTKEY home"><b>GHOSTKEY</b></a>
  <nav class="nav-links">${navLinks.map(([h, t]) => `<a href="${h}"${h === '/proof' ? ' aria-current="page"' : ''}>${t}</a>`).join('')}</nav>
</div></header>
<main><div class="wrap">
  <section class="pf-hero">
    <p class="kicker">Proof</p>
    <h1 class="h2">Check every claim yourself.</h1>
    <p class="lead">Each claim has a link next to it. Most checks need no wallet and no account.</p>
  </section>

  <section class="pf-sec" id="claims" aria-labelledby="claims-h">
    <p class="kicker">Claims</p><h2 class="h3" id="claims-h">Claim → how to check it yourself</h2>
    ${claimTable}
  </section>

  <section class="pf-sec" id="addresses" aria-labelledby="addr-h">
    <p class="kicker">On-chain</p><h2 class="h3" id="addr-h">Addresses on Robinhood Chain</h2>
    <p class="lead">Full addresses, linked to Blockscout. Anything not live yet says so.</p>
    ${addrs}
  </section>

  <section class="pf-sec" id="ledger" aria-labelledby="ledger-h">
    <p class="kicker">Ghost Credit</p><h2 class="h3" id="ledger-h">Latest hours</h2>
    <p class="lead">Each hour: the pool, how many wallets got credit, the public JSON and the on-chain post.</p>
    ${hours}
  </section>

  <section class="pf-sec" id="harvests" aria-labelledby="harvest-h">
    <p class="kicker">Fees</p><h2 class="h3" id="harvest-h">Latest fee claims</h2>
    <p class="lead">Each claim and the two transfers that split it.</p>
    ${harvests}
  </section>

  <section class="pf-sec" id="stats" aria-labelledby="stats-h">
    <p class="kicker">Live</p><h2 class="h3" id="stats-h">Numbers from our database</h2>
    ${stats}
  </section>

  <section class="pf-sec" id="schema" aria-labelledby="schema-h">
    <p class="kicker">What we store</p><h2 class="h3" id="schema-h">Every table and column, read live</h2>
    <p class="lead">No table has a column for prompts or answers.</p>
    ${schemaHtml}
  </section>

  <section class="pf-sec" id="limits" aria-labelledby="limits-h">
    <p class="kicker">Limits</p><h2 class="h3" id="limits-h">What this does not cover</h2>
    <ul class="pf-limits">${limits.map((x) => `<li>${esc(x)}</li>`).join('')}</ul>
  </section>

  <p class="pf-foot">Rendered by the server at ${updated} UTC. This page works without JavaScript. Machine-readable: ${ext('/api/proof', '/api/proof')}</p>
</div></main>
<footer id="foot"></footer>
<script type="module">import { chrome } from '/js/common.js'; chrome();</script>
</body>
</html>`;
}
