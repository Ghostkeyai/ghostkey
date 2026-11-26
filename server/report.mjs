// Laporan fee bulanan — dibangun HANYA dari tabel harvests (klaim + 2 transfer per klaim), ledger_hours (satu baris
// per jam Ghost Credit), credits, dan berkas jam data/ledger/hour-<n>.json. Tidak ada angka ketikan tangan.
// Dipakai oleh /report (HTML tanpa JS wajib), /api/report[/<bulan>] (JSON) dan /api/report/<bulan>.csv.
// Skrip tools/verify/month-report.mjs mengulang semua pemeriksaan di bawah dari JSON publik + berkas jam + rantai.
import { existsSync, readFileSync } from 'node:fs';
import { keccak256 } from 'ethers';
import { config, codeUrl } from './config.mjs';
import { q } from './db.mjs';
import { hourFilePath } from './credit.mjs';

const MONTH_RE = /^(\d{4})-(0[1-9]|1[0-2])$/;
const H = 3_600_000;
const monthOfHour = (h) => new Date(h * H).toISOString().slice(0, 7);
export const currentMonth = () => new Date().toISOString().slice(0, 7);

export function monthRange(month) {
  const m = MONTH_RE.exec(String(month || ''));
  if (!m) return null;
  const y = Number(m[1]), mo = Number(m[2]);
  return { fromHour: Date.UTC(y, mo - 1, 1) / H, toHour: Date.UTC(y, mo, 1) / H, days: new Date(Date.UTC(y, mo, 0)).getUTCDate() };
}

// Bulan yang punya data (klaim atau jam kredit), terbaru dulu
export function reportMonths() {
  const r = q.one('SELECT MIN(h) a, MAX(h) b FROM (SELECT hour h FROM harvests UNION ALL SELECT hour h FROM ledger_hours)');
  if (r?.a == null) return [];
  const out = [];
  for (let m = monthOfHour(r.a); m <= monthOfHour(r.b);) {
    out.unshift(m);
    const [y, mo] = m.split('-').map(Number);
    m = new Date(Date.UTC(y, mo, 1)).toISOString().slice(0, 7);
  }
  return out;
}

const eth = (wei) => {
  const w = BigInt(wei), neg = w < 0n, a = neg ? -w : w;
  const s = (a / 10n ** 18n).toString() + '.' + (a % 10n ** 18n).toString().padStart(18, '0');
  return (neg ? '-' : '') + s.replace(/0+$/, '').replace(/\.$/, '');
};
const sumBig = (rows, k) => rows.reduce((s, r) => s + BigInt(r[k] || 0), 0n);
const sumNum = (rows, k) => rows.reduce((s, r) => s + Number(r[k] || 0), 0);

const cache = new Map();   // bulan → { at, data }; laporan dihitung ulang paling sering tiap 60 detik

export function monthReport(month) {
  const range = monthRange(month);
  if (!range) return null;
  const hit = cache.get(month);
  if (hit && Date.now() - hit.at < 60_000) return hit.data;
  const { fromHour, toHour } = range;
  const ownerBps = 10000 - config.holderShareBps;

  // --- klaim fee (harvests) ---
  const claims = q.all('SELECT * FROM harvests WHERE hour>=? AND hour<? ORDER BY id', fromHour, toHour).map((h) => {
    const holderWei = BigInt(h.holder_wei), ownerWei = BigInt(h.owner_wei), claimedWei = BigInt(h.claimed_wei);
    return {
      hour: h.hour, at: new Date(h.created_at).toISOString(), ethUsd: h.eth_usd,
      claimedWei: claimedWei.toString(), holderWei: holderWei.toString(), ownerWei: ownerWei.toString(),
      gasKeptWei: (claimedWei - holderWei - ownerWei).toString(),
      usdMicro: h.usd_micro, holderMicro: h.holder_micro, ownerMicro: h.owner_micro,
      txs: JSON.parse(h.txs || '[]').map((t) => ({ kind: t.kind, txHash: t.txHash, ...(t.to ? { to: t.to, wei: String(t.wei) } : {}) })),
    };
  });

  // --- jam Ghost Credit (ledger_hours) + jumlah dari tabel credits ---
  const credRows = q.all('SELECT hour, COUNT(*) n, SUM(credit_micro) s FROM credits WHERE hour>=? AND hour<? GROUP BY hour', fromHour, toHour);
  const credBy = new Map(credRows.map((r) => [r.hour, r]));
  const hours = q.all('SELECT * FROM ledger_hours WHERE hour>=? AND hour<? ORDER BY hour', fromHour, toHour).map((r) => ({
    hour: r.hour, status: r.status, feesMicro: r.fees_micro, carryInMicro: r.carry_in_micro, poolMicro: r.pool_micro,
    distributedMicro: r.distributed_micro, carryOutMicro: r.carry_out_micro, entries: r.entries,
    root: r.root, uriHash: r.uri_hash, txHash: r.tx_hash,
    creditRows: credBy.get(r.hour)?.n || 0, creditSumMicro: credBy.get(r.hour)?.s || 0,
  }));
  const prev = q.one('SELECT carry_out_micro c FROM ledger_hours WHERE hour<? ORDER BY hour DESC LIMIT 1', fromHour);
  const wallets = q.one('SELECT COUNT(DISTINCT wallet) n FROM credits WHERE hour>=? AND hour<?', fromHour, toHour).n;

  // --- total ---
  const claimedWei = sumBig(claims, 'claimedWei'), holderWei = sumBig(claims, 'holderWei'), ownerWei = sumBig(claims, 'ownerWei');
  const gasKeptWei = claimedWei - holderWei - ownerWei;
  const totals = {
    claims: claims.length,
    claimedWei: claimedWei.toString(), claimedEth: eth(claimedWei), claimedMicro: sumNum(claims, 'usdMicro'),
    holderWei: holderWei.toString(), holderEth: eth(holderWei), holderMicro: sumNum(claims, 'holderMicro'),
    ownerWei: ownerWei.toString(), ownerEth: eth(ownerWei), ownerMicro: sumNum(claims, 'ownerMicro'),
    gasKeptWei: gasKeptWei.toString(), gasKeptEth: eth(gasKeptWei),
    hoursProcessed: hours.length,
    hoursPosted: hours.filter((h) => h.status === 'posted').length,
    hoursPending: hours.filter((h) => h.status === 'pending').length,
    hoursNoFees: hours.filter((h) => h.status === 'no_fees' || h.status === 'no_holders').length,
    creditFeesMicro: sumNum(hours, 'feesMicro'),
    carryInMicro: hours[0]?.carryInMicro ?? 0,
    distributedMicro: sumNum(hours, 'distributedMicro'),
    carryOutMicro: hours.at(-1)?.carryOutMicro ?? 0,
    creditPayouts: sumNum(hours, 'creditRows'),
    walletsCredited: wallets,
  };

  // --- per hari (UTC) ---
  const days = [];
  for (let d = 0; d < range.days; d++) {
    const a = fromHour + d * 24, b = a + 24;
    const dc = claims.filter((c) => c.hour >= a && c.hour < b), dh = hours.filter((h) => h.hour >= a && h.hour < b);
    days.push({
      day: new Date(a * H).toISOString().slice(0, 10),
      claims: dc.length, claimedMicro: sumNum(dc, 'usdMicro'), holderMicro: sumNum(dc, 'holderMicro'), ownerMicro: sumNum(dc, 'ownerMicro'),
      claimedWei: sumBig(dc, 'claimedWei').toString(),
      distributedMicro: sumNum(dh, 'distributedMicro'), hoursPosted: dh.filter((h) => h.status === 'posted').length,
      wallets: q.one('SELECT COUNT(DISTINCT wallet) n FROM credits WHERE hour>=? AND hour<?', a, b).n,
    });
  }

  // --- pemeriksaan (skrip publik mengulang yang sama) ---
  const checks = [];
  const add = (id, label, bad, detail = '') => checks.push({ id, label, ok: bad.length === 0, detail: bad.length ? bad.slice(0, 5).join(', ') : detail });
  add('split', `Every claim: team share = floor(sent × ${ownerBps / 100}%), holders get the rest`,
    claims.filter((c) => {
      const sent = BigInt(c.holderWei) + BigInt(c.ownerWei);
      return BigInt(c.ownerWei) !== (sent * BigInt(ownerBps)) / 10000n;
    }).map((c) => `hour ${c.hour}`), `${claims.length} claims`);
  add('gas', 'Every claim: holders + team + gas kept = amount claimed, gas kept ≥ 0',
    claims.filter((c) => BigInt(c.gasKeptWei) < 0n).map((c) => `hour ${c.hour}`), `${eth(gasKeptWei)} ETH kept for transfer gas`);
  add('transfers', 'Every claim lists one transfer to the treasury and one to the owner wallet, matching the shares',
    claims.filter((c) => {
      const to = (k) => c.txs.filter((t) => t.kind === k).reduce((s, t) => s + BigInt(t.wei || 0), 0n);
      return to('to_treasury') !== BigInt(c.holderWei) || to('to_owner') !== BigInt(c.ownerWei);
    }).map((c) => `hour ${c.hour}`));
  const holderByHour = new Map();
  for (const c of claims) holderByHour.set(c.hour, (holderByHour.get(c.hour) || 0) + c.holderMicro);
  add('fees-in', "Each hour's Ghost Credit fees = the holder shares claimed in that hour",
    hours.filter((h) => h.feesMicro !== (holderByHour.get(h.hour) || 0)).map((h) => `hour ${h.hour}`)
      // klaim jam yang belum diproses mesin kredit (jam berjalan) bukan kesalahan; hanya yang terlewat di tengah
      .concat([...holderByHour.keys()].filter((k) => k <= (hours.at(-1)?.hour ?? -1) && !hours.some((h) => h.hour === k)).map((k) => `hour ${k} not processed`)));
  add('pool', 'Each hour: pool = fees + carry-in, and paid out + carry-out = pool',
    hours.filter((h) => h.poolMicro !== h.feesMicro + h.carryInMicro || h.distributedMicro + h.carryOutMicro !== h.poolMicro).map((h) => `hour ${h.hour}`));
  add('carry', 'Carry-over chains: each hour starts with the cents the previous hour could not split',
    hours.filter((h, i) => h.carryInMicro !== (i ? hours[i - 1].carryOutMicro : (prev?.c ?? 0))).map((h) => `hour ${h.hour}`));
  add('credits', 'Each hour: wallet credits add up to the amount paid out, one row per wallet',
    hours.filter((h) => h.creditSumMicro !== h.distributedMicro || h.creditRows !== h.entries).map((h) => `hour ${h.hour}`));
  const fileBad = [];
  for (const h of hours) {
    if (!h.uriHash) continue;
    const p = hourFilePath(h.hour);
    if (!existsSync(p)) { fileBad.push(`hour ${h.hour} file missing`); continue; }
    const buf = readFileSync(p);
    const f = JSON.parse(buf.toString('utf8'));
    if (keccak256(buf) !== h.uriHash || f.root !== h.root || String(f.distributedMicro) !== String(h.distributedMicro)) fileBad.push(`hour ${h.hour}`);
  }
  add('files', 'Each hour file hashes to the uriHash sent on-chain, with the same root and payout', fileBad,
    `${hours.filter((h) => h.uriHash).length} files`);
  add('posted', 'Every hour with payouts has its root posted to GhostLedger',
    hours.filter((h) => h.entries > 0 && h.status !== 'posted').map((h) => `hour ${h.hour} (${h.status})`));

  const endsAt = new Date(toHour * H).toISOString();
  const data = {
    month, from: new Date(fromHour * H).toISOString(), to: endsAt, fromHour, toHour,
    complete: Date.now() >= toHour * H, generatedAt: new Date().toISOString(),
    chainId: config.chainId, ledger: config.ledgerAddress || null, treasury: config.treasury || null, owner: config.ownerWallet || null,
    split: { holderShareBps: config.holderShareBps, ownerShareBps: ownerBps },
    usdNote: 'USD values use the ETH price at the moment each claim was made. ETH amounts are exact.',
    totals, days, checks, claims, hours,
    script: codeUrl('tools/verify/month-report.mjs'),
  };
  cache.set(month, { at: Date.now(), data });
  return data;
}

// ---------- CSV: satu baris per klaim ----------
const cell = (v) => { const t = String(v ?? ''); return /[",\n]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t; };
export function reportCsv(d) {
  const lines = [['hour', 'claimed_at_utc', 'claimed_eth', 'holders_eth', 'team_eth', 'gas_kept_eth', 'eth_usd', 'claimed_usd', 'holders_usd', 'team_usd',
    'claim_tx', 'treasury_tx', 'owner_tx'].join(',')];
  for (const c of d.claims) {
    const tx = (k) => c.txs.filter((t) => t.kind === k).map((t) => t.txHash).join(' ');
    lines.push([c.hour, c.at, eth(c.claimedWei), eth(c.holderWei), eth(c.ownerWei), eth(c.gasKeptWei), c.ethUsd,
      (c.usdMicro / 1e6).toFixed(6), (c.holderMicro / 1e6).toFixed(6), (c.ownerMicro / 1e6).toFixed(6), tx('claim'), tx('to_treasury'), tx('to_owner')].map(cell).join(','));
  }
  return lines.join('\n') + '\n';
}

// ---------- HTML ----------
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const usd = (micro) => '$' + (Number(micro || 0) / 1e6).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const ethShort = (wei, dp = 4) => Number(eth(wei)).toLocaleString('en-US', { minimumFractionDigits: dp, maximumFractionDigits: dp });
const int = (n) => Number(n || 0).toLocaleString('en-US');
const monthName = (m) => new Date(m + '-01T00:00:00Z').toLocaleString('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' });
const txUrl = (h) => `${config.blockscout}/tx/${h}`;
const ext = (href, text) => `<a class="proof-link" href="${esc(href)}" target="_blank" rel="noopener">${text}</a>`;

// Grafik batang bertumpuk per hari: pemegang (bawah) + tim (atas). SVG murni; tooltip dihidupkan skrip kecil di bawah.
function dayChart(d) {
  const W = 1000, Hh = 240, padL = 8, padR = 8, padT = 14, padB = 26;
  const n = d.days.length, slot = (W - padL - padR) / n, bw = Math.max(6, Math.min(22, slot - 6));
  const max = Math.max(1, ...d.days.map((x) => x.holderMicro + x.ownerMicro));
  const y = (v) => (v / max) * (Hh - padT - padB);
  const base = Hh - padB;
  const today = new Date().toISOString().slice(0, 10);
  const bar = (x, top, h, color, rTop) => {
    if (h <= 0) return '';
    const r = rTop ? Math.min(4, h) : 0;
    return r ? `<path d="M${x},${top + h}V${top + r}q0,-${r} ${r},-${r}h${bw - 2 * r}q${r},0 ${r},${r}V${top + h}Z" fill="${color}"/>`
      : `<rect x="${x}" y="${top}" width="${bw}" height="${h}" fill="${color}"/>`;
  };
  const marks = d.days.map((x, i) => {
    const cx = padL + slot * i + (slot - bw) / 2;
    const hh = y(x.holderMicro), ho = y(x.ownerMicro);
    const gap = hh > 0 && ho > 0 ? 2 : 0;
    const future = x.day > today;
    const label = `${x.day}: ${usd(x.claimedMicro)} claimed in ${x.claims} claim${x.claims === 1 ? '' : 's'}. Holders ${usd(x.holderMicro)}, team ${usd(x.ownerMicro)}. Ghost Credit paid ${usd(x.distributedMicro)} to ${x.wallets} wallets.`;
    const tick = (i % 5 === 0 || i === n - 1) ? `<text x="${cx + bw / 2}" y="${Hh - 8}" text-anchor="middle">${Number(x.day.slice(8))}</text>` : '';
    return `<g class="day${future ? ' fut' : ''}" data-tip="${esc(future ? `${x.day}: not reached yet` : label)}">
      <rect class="hit" x="${padL + slot * i}" y="0" width="${slot}" height="${Hh}" fill="transparent"/>
      ${future || (!hh && !ho) ? `<rect x="${cx}" y="${base - 2}" width="${bw}" height="2" fill="var(--line-2)"/>` : ''}
      ${bar(cx, base - hh, hh, 'var(--c-holders)', ho <= 0)}
      ${bar(cx, base - hh - gap - ho, ho, 'var(--c-team)', true)}
      ${tick}</g>`;
  }).join('');
  const grid = [0.5, 1].map((f) => `<line x1="0" x2="${W}" y1="${base - (Hh - padT - padB) * f}" y2="${base - (Hh - padT - padB) * f}" class="grid"/>
    <text class="gl" x="${W}" y="${base - (Hh - padT - padB) * f - 5}" text-anchor="end">${usd(max * f)}</text>`).join('');
  return `<figure class="rp-chart">
    <figcaption><span class="lg"><i style="background:var(--c-holders)"></i>Holders · ${d.split.holderShareBps / 100}%</span><span class="lg"><i style="background:var(--c-team)"></i>Team · ${d.split.ownerShareBps / 100}%</span><span class="dim">Fees claimed per UTC day, in USD at claim time</span></figcaption>
    <div class="plot"><svg viewBox="0 0 ${W} ${Hh}" preserveAspectRatio="none" role="img" aria-label="Fees claimed per day in ${esc(monthName(d.month))}, split into holders and team. The table below has the same numbers.">
      ${grid}<line x1="0" x2="${W}" y1="${base}" y2="${base}" class="axis"/>${marks}</svg><div class="tip" id="tip" hidden></div></div>
  </figure>`;
}

export function renderReport(month, months) {
  const d = monthReport(month);
  const t = d.totals;
  const allOk = d.checks.every((c) => c.ok);
  const sent = BigInt(t.holderWei) + BigInt(t.ownerWei);
  const pctOf = (w) => (sent > 0n ? Number((BigInt(w) * 10000n) / BigInt(t.claimedWei || 1)) / 100 : 0);
  const tabs = months.map((m) => `<a href="/report?m=${m}"${m === month ? ' aria-current="page"' : ''}>${esc(monthName(m))}</a>`).join('');
  const stat = (k, v, sub, cls = '') => `<div class="card rp-stat ${cls}"><p class="kicker">${k}</p><p class="v px">${v}</p><p class="sub">${sub}</p></div>`;

  const flow = `<div class="rp-flow" aria-label="Where the claimed fees went">
    <div class="bar">
      <span style="flex:${pctOf(t.holderWei) || 0.0001};background:var(--c-holders)"></span>
      <span style="flex:${pctOf(t.ownerWei) || 0.0001};background:var(--c-team)"></span>
      <span style="flex:${Math.max(pctOf(t.gasKeptWei), 0.4)};background:var(--faint)"></span>
    </div>
    <div class="keys">
      <p><i style="background:var(--c-holders)"></i><b>${ethShort(t.holderWei)} ETH</b> to the treasury for holders <span class="dim">${usd(t.holderMicro)}</span></p>
      <p><i style="background:var(--c-team)"></i><b>${ethShort(t.ownerWei)} ETH</b> to the owner wallet for the team <span class="dim">${usd(t.ownerMicro)}</span></p>
      <p><i style="background:var(--faint)"></i><b>${ethShort(t.gasKeptWei, 6)} ETH</b> kept in the fee wallet to pay transfer gas</p>
    </div>
  </div>`;

  const credit = `<div class="rp-credit">
    <div><p class="kicker">Holder share in</p><p class="px v2">${usd(t.creditFeesMicro)}</p></div>
    <div class="op">+</div>
    <div><p class="kicker">Carried in</p><p class="px v2">${usd(t.carryInMicro)}</p></div>
    <div class="op">=</div>
    <div><p class="kicker">Ghost Credit paid</p><p class="px v2 mint">${usd(t.distributedMicro)}</p><p class="sub">${int(t.creditPayouts)} payouts · ${int(t.walletsCredited)} wallets</p></div>
    <div class="op">+</div>
    <div><p class="kicker">Carried out</p><p class="px v2">${usd(t.carryOutMicro)}</p><p class="sub">cents too small to split</p></div>
  </div>`;

  const dayRows = d.days.filter((x) => x.claims || x.distributedMicro || x.hoursPosted).map((x) => `<tr><td>${x.day}</td><td>${int(x.claims)}</td><td>${ethShort(x.claimedWei)}</td><td>${usd(x.claimedMicro)}</td><td>${usd(x.holderMicro)}</td><td>${usd(x.ownerMicro)}</td><td>${usd(x.distributedMicro)}</td><td>${int(x.wallets)}</td><td>${int(x.hoursPosted)}</td></tr>`).join('');
  const checks = `<ul class="rp-checks">${d.checks.map((c) => `<li class="${c.ok ? 'ok' : 'bad'}"><span class="chip ${c.ok ? 'ok' : 'bad'}">${c.ok ? 'Matches' : 'Mismatch'}</span><span>${esc(c.label)}${c.detail ? `<em>${esc(c.detail)}</em>` : ''}</span></li>`).join('')}</ul>`;
  const claimRows = d.claims.slice().reverse().map((c) => {
    const tx = (k) => c.txs.filter((x) => x.kind === k).map((x) => `<a class="proof-link mono" href="${txUrl(x.txHash)}" target="_blank" rel="noopener">${x.txHash.slice(0, 8)}…</a>`).join(' ') || '<span class="dim">—</span>';
    return `<tr><td>${c.at.slice(0, 16).replace('T', ' ')}</td><td>${ethShort(c.claimedWei, 5)}</td><td>${usd(c.usdMicro)}</td><td>${usd(c.holderMicro)}</td><td>${usd(c.ownerMicro)}</td><td>${tx('claim')}</td><td>${tx('to_treasury')}</td><td>${tx('to_owner')}</td></tr>`;
  }).join('');
  const cmd = `node tools/verify/month-report.mjs --month ${month} --chain`;
  const navLinks = [['/app', 'Chat'], ['/models', 'Models'], ['/privacy', 'Privacy'], ['/token', '$GHOST'], ['/proof', 'Proof'], ['/roadmap', 'Roadmap'], ['/docs', 'Docs']];

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Fee report, ${esc(monthName(month))} · GHOSTKEY</title>
<meta name="description" content="$GHOST creator fees for ${esc(monthName(month))}: claimed, sent to holders as Ghost Credit, sent to the team. Built from the hourly files and on-chain roots, with a script that re-checks every number.">
<meta property="og:title" content="Fee report, ${esc(monthName(month))} · GHOSTKEY">
<meta property="og:description" content="Fees in, Ghost Credit out, team share out. Every number re-checkable.">
<meta property="og:image" content="${esc(config.publicUrl)}/img/og.png">
<link rel="icon" href="/img/favicon.svg" type="image/svg+xml">
<link rel="stylesheet" href="/css/base.css">
<link rel="stylesheet" href="/css/chrome.css">
<style>
  .rp { --c-holders: #2fa97a; --c-team: #c98022; }
  .rp main { padding: 56px 0 96px; }
  .rp .dim { color: var(--faint); }
  .sr-only { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; }
  .rp-hero { display: grid; gap: 14px; margin-bottom: 28px; }
  .rp-hero .h2 { margin: 4px 0 0; }
  .rp-tabs { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 6px; }
  .rp-tabs a { font: 400 11px/1 var(--font-pixel); text-transform: uppercase; padding: 9px 12px; border: 1px solid var(--line-2); color: var(--dim); text-decoration: none; }
  .rp-tabs a[aria-current] { color: var(--bg); background: var(--mint); border-color: var(--mint); }
  .rp-state { display: flex; flex-wrap: wrap; gap: 10px 16px; align-items: center; color: var(--dim); font-size: 14px; }
  .chip.ok { color: var(--mint); border-color: #9ff0c855; }
  .chip.bad { color: var(--bad); border-color: #ff8a7a66; }
  .rp-sec { margin-top: 64px; }
  .rp-sec > .h3 { margin: 10px 0 16px; }
  .rp-sec > p.lead { margin: -4px 0 18px; font-size: 15.5px; }
  .rp-stats { display: grid; grid-template-columns: repeat(4, 1fr); gap: 12px; }
  .rp-stat { padding: 18px; }
  .rp-stat .v { font-size: 30px; margin-top: 10px; }
  .rp-stat .sub { color: var(--dim); font-size: 13px; margin-top: 6px; }
  .rp-stat.h .v { color: #6fdcaa; } .rp-stat.t .v { color: #e7ab55; }
  .rp-flow { margin-top: 12px; padding: 20px; background: var(--bg-2); border: 1px solid var(--line); display: grid; gap: 16px; }
  .rp-flow .bar { display: flex; gap: 2px; height: 16px; }
  .rp-flow .bar span:first-child { border-radius: 4px 0 0 4px; } .rp-flow .bar span:last-child { border-radius: 0 4px 4px 0; }
  .rp-flow .keys { display: grid; gap: 8px; font-size: 14px; color: var(--dim); }
  .rp-flow .keys b { color: var(--ink); font-weight: 500; font-family: var(--font-mono); }
  .rp-flow i, .rp-chart i { display: inline-block; width: 10px; height: 10px; border-radius: 2px; margin-right: 8px; vertical-align: -1px; }
  .rp-chart { margin: 0; padding: 18px; background: var(--bg-2); border: 1px solid var(--line); }
  .rp-chart figcaption { display: flex; flex-wrap: wrap; gap: 8px 20px; font-size: 13px; color: var(--dim); margin-bottom: 12px; }
  .rp-chart .lg { color: var(--ink); }
  .rp-chart .plot { position: relative; }
  .rp-chart svg { width: 100%; height: 240px; display: block; overflow: visible; }
  .rp-chart svg text { font: 400 11px var(--font-mono); fill: var(--faint); }
  .rp-chart .grid { stroke: var(--line); stroke-dasharray: 2 4; } .rp-chart .axis { stroke: var(--line-2); }
  .rp-chart .day:hover path, .rp-chart .day:hover rect:not(.hit) { filter: brightness(1.2); }
  .rp-chart .tip { position: absolute; z-index: 2; max-width: 280px; padding: 10px 12px; background: var(--bg-3); border: 1px solid var(--line-2); font-size: 12.5px; line-height: 1.5; color: var(--ink); pointer-events: none; transform: translate(-50%, calc(-100% - 10px)); }
  .rp-credit { display: grid; grid-template-columns: 1fr auto 1fr auto 1.3fr auto 1fr; gap: 12px; align-items: center; padding: 20px; background: var(--bg-2); border: 1px solid var(--line); }
  .rp-credit .v2 { font-size: 24px; margin-top: 8px; } .rp-credit .mint { color: var(--mint); }
  .rp-credit .op { font: 400 22px var(--font-pixel); color: var(--faint); }
  .rp-credit .sub { color: var(--dim); font-size: 12.5px; margin-top: 4px; }
  .table-scroll { overflow-x: auto; border: 1px solid var(--line); background: var(--bg-2); }
  .rp-table { width: 100%; border-collapse: collapse; font-size: 13.5px; }
  .rp-table th, .rp-table td { text-align: left; padding: 12px 14px; border-bottom: 1px solid var(--line); white-space: nowrap; }
  .rp-table thead th { font: 400 10.5px/1 var(--font-pixel); text-transform: uppercase; color: var(--dim); }
  .rp-checks { list-style: none; display: grid; gap: 8px; }
  .rp-checks li { display: flex; gap: 14px; align-items: flex-start; padding: 13px 16px; background: var(--bg-2); border: 1px solid var(--line); font-size: 14.5px; }
  .rp-checks li .chip { flex: none; min-width: 84px; justify-content: center; }
  .rp-checks em { display: block; font-style: normal; color: var(--faint); font-size: 12.5px; margin-top: 3px; font-family: var(--font-mono); }
  .rp-run { margin-top: 14px; padding: 16px 18px; background: #0d0f0e; border: 1px solid var(--line-2); font: 400 13px/1.6 var(--font-mono); color: var(--mint); overflow-x: auto; white-space: nowrap; }
  .rp-dl { display: flex; flex-wrap: wrap; gap: 10px 20px; margin-top: 14px; }
  .rp-foot { margin-top: 56px; color: var(--faint); font-size: 13px; }
  @media (max-width: 860px) {
    .rp-stats { grid-template-columns: 1fr 1fr; }
    .rp-stat .v { font-size: 22px; }
    .rp-credit { grid-template-columns: 1fr 1fr; }
    .rp-credit .op { display: none; }
    .rp-chart svg { height: 180px; }
  }
</style>
</head>
<body class="rp">
<header id="nav" class="nav"><div class="wrap">
  <a class="brand" href="/" aria-label="GHOSTKEY home"><b>GHOSTKEY</b></a>
  <nav class="nav-links">${navLinks.map(([h, x]) => `<a href="${h}">${x}</a>`).join('')}</nav>
</div></header>
<main><div class="wrap">
  <section class="rp-hero">
    <p class="kicker">Fee report</p>
    <h1 class="h2">${esc(monthName(month))}: fees in, Ghost Credit out.</h1>
    <p class="lead">Every $GHOST creator fee we claimed this month, where each share went, and what holders received. Built from the hourly files and the roots on GhostLedger. A script re-checks every number.</p>
    <div class="rp-state">
      <span class="chip ${allOk ? 'ok' : 'bad'}">${allOk ? `All ${d.checks.length} checks match` : `${d.checks.filter((c) => !c.ok).length} check${d.checks.filter((c) => !c.ok).length === 1 ? '' : 's'} failed`}</span>
      <span>${d.complete ? 'Month closed' : `Month to date, updated ${esc(d.generatedAt.slice(0, 16).replace('T', ' '))} UTC`}</span>
    </div>
    ${months.length > 1 ? `<nav class="rp-tabs" aria-label="Months">${tabs}</nav>` : ''}
  </section>

  <section aria-labelledby="sum-h">
    <h2 class="sr-only" id="sum-h">Totals</h2>
    <div class="rp-stats">
      ${stat('Fees claimed', `${ethShort(t.claimedWei)} ETH`, `${usd(t.claimedMicro)} · ${int(t.claims)} claims`)}
      ${stat(`Holders · ${d.split.holderShareBps / 100}%`, usd(t.holderMicro), `${ethShort(t.holderWei)} ETH to the treasury`, 'h')}
      ${stat(`Team · ${d.split.ownerShareBps / 100}%`, usd(t.ownerMicro), `${ethShort(t.ownerWei)} ETH to the owner wallet`, 't')}
      ${stat('Hours on-chain', `${int(t.hoursPosted)}`, `of ${int(t.hoursProcessed)} hours processed${t.hoursNoFees ? `, ${int(t.hoursNoFees)} without fees` : ''}`)}
    </div>
    ${flow}
  </section>

  <section class="rp-sec" aria-labelledby="day-h">
    <p class="kicker">Per day</p><h2 class="h3" id="day-h">Fees claimed each day</h2>
    ${dayChart(d)}
    <div class="table-scroll" style="margin-top:12px"><table class="rp-table">
      <thead><tr><th scope="col">Day (UTC)</th><th scope="col">Claims</th><th scope="col">ETH</th><th scope="col">USD</th><th scope="col">Holders</th><th scope="col">Team</th><th scope="col">Ghost Credit paid</th><th scope="col">Wallets</th><th scope="col">Hours posted</th></tr></thead>
      <tbody>${dayRows || '<tr><td colspan="9" class="dim">No fees claimed this month yet.</td></tr>'}</tbody></table></div>
  </section>

  <section class="rp-sec" aria-labelledby="cr-h">
    <p class="kicker">Ghost Credit</p><h2 class="h3" id="cr-h">From the holder share to wallets</h2>
    <p class="lead">Each hour the holder share becomes that hour's pool. It is split by average balance, and the cents that cannot be split carry to the next hour.</p>
    ${credit}
  </section>

  <section class="rp-sec" aria-labelledby="ck-h">
    <p class="kicker">Checks</p><h2 class="h3" id="ck-h">What the server checked before showing this page</h2>
    ${checks}
    <p class="lead" style="margin-top:22px">Run the same checks yourself. The script reads the public JSON and every hour file, and with <code>--chain</code> it also reads each transfer and each GhostLedger root from Robinhood Chain.</p>
    <div class="rp-run">${esc(cmd)}</div>
    <div class="rp-dl">${ext(`/api/report/${month}`, 'Report JSON')}${ext(`/api/report/${month}.csv`, 'Claims CSV')}${d.script ? ext(d.script, 'Script source') : ''}${ext('/proof#ledger', 'Hourly ledger')}</div>
  </section>

  <section class="rp-sec" aria-labelledby="cl-h">
    <p class="kicker">Claims</p><h2 class="h3" id="cl-h">Every claim and its two transfers</h2>
    <div class="table-scroll"><table class="rp-table">
      <thead><tr><th scope="col">Claimed (UTC)</th><th scope="col">ETH</th><th scope="col">USD</th><th scope="col">Holders</th><th scope="col">Team</th><th scope="col">Claim tx</th><th scope="col">To treasury</th><th scope="col">To owner</th></tr></thead>
      <tbody>${claimRows || '<tr><td colspan="8" class="dim">No claims yet.</td></tr>'}</tbody></table></div>
  </section>

  <p class="rp-foot">${esc(d.usdNote)} Rendered by the server; this page works without JavaScript.</p>
</div></main>
<footer id="foot"></footer>
<script type="module">import { chrome } from '/js/common.js'; chrome();
const plot = document.querySelector('.rp-chart .plot'), tip = document.getElementById('tip');
if (plot && tip) {
  const show = (g, x, y) => { const r = plot.getBoundingClientRect(); tip.textContent = g.dataset.tip; tip.hidden = false;
    tip.style.left = Math.min(Math.max(x - r.left, 140), r.width - 140) + 'px'; tip.style.top = (y - r.top) + 'px'; };
  plot.addEventListener('pointermove', (e) => { const g = e.target.closest('.day'); if (g) show(g, e.clientX, e.clientY); else tip.hidden = true; });
  plot.addEventListener('pointerleave', () => { tip.hidden = true; });
}
</script>
</body>
</html>`;
}
