// Halaman $GHOST: kartu kontrak (jujur sebelum launch), cara kerja Ghost Credit, aturan kelayakan,
// tabel ledger per jam (/api/ledger), rincian jam (/api/ledger/:hour), cek dompet (/api/holder/:wallet),
// dan verifikasi on-chain: GhostLedger.verify(hour, wallet, creditMicro, proof) lewat eth_call langsung dari browser.
import {
  api, chrome, getConfig, esc, usd, int, compact, short, pct, copy, pix, paintIcons, hourLabel, ago,
  addrUrl, txUrl, tokenUrl, blockUrl, sourcifyUrl, isAddr, ethCall, RPC_URLS,
} from '/js/common.js';

const $ = (s, el = document) => el.querySelector(s);
const ETHERS = 'https://cdn.jsdelivr.net/npm/ethers@6.13.4/dist/ethers.min.js';
let cfg = {};
let hours = [];
const hourCache = new Map();
let ethersP = null;
const loadEthers = () => (ethersP ||= import(ETHERS));

// ---------- Kartu alamat ----------
function addrBlock(addr, { token = false, sourcify = false } = {}) {
  return `<div class="addr-row"><span class="addr">${esc(addr)}</span><button class="icon-btn" type="button" data-copy="${esc(addr)}" aria-label="Copy address">${pix('copy', 14)}</button></div>
    <div class="links"><a class="proof-link" href="${token ? tokenUrl(addr) : addrUrl(addr)}" target="_blank" rel="noopener">Blockscout</a>${sourcify ? `<a class="proof-link" href="${sourcifyUrl(addr)}" target="_blank" rel="noopener">Verified source (Sourcify)</a>` : ''}</div>`;
}

function renderContracts() {
  const t = cfg.ghostToken;
  $('#c-token').innerHTML = `<div class="top"><span class="label">$GHOST token</span>${t ? '<span class="chip ok">Live</span>' : '<span class="chip wait">Launches soon</span>'}</div>
    ${t ? `${addrBlock(t, { token: true })}${cfg.links?.pons ? `<div class="links" style="margin-top:8px"><a class="proof-link" href="${esc(cfg.links.pons)}" target="_blank" rel="noopener">Trade on Pons</a></div>` : ''}`
      : '<p>The contract address will be posted here at launch. Until then, any address claiming to be $GHOST is not ours.</p>'}`;
  const l = cfg.ledger;
  $('#c-ledger').innerHTML = `<div class="top"><span class="label">GhostLedger contract</span>${l ? '<span class="chip ok">Deployed</span>' : '<span class="chip wait">Not deployed yet</span>'}</div>
    ${l ? addrBlock(l, { sourcify: true }) : '<p>Contract not deployed yet. It stores one Merkle root per hour. It has no owner and cannot be upgraded.</p>'}`;
  const w = [];
  if (cfg.treasury) w.push(['Treasury · top-ups and holder pool', cfg.treasury]);
  if (cfg.owner) w.push(['Team wallet · 75% share', cfg.owner]);
  $('#c-wallets').innerHTML = `<div class="top"><span class="label">Where fees go</span>${w.length ? '<span class="chip ok">Public</span>' : '<span class="chip wait">Set at launch</span>'}</div>
    ${w.length ? `<div class="wl">${w.map(([lbl, a]) => `<div><span class="label">${esc(lbl)}</span><div class="addr-row"><a class="addr link" href="${addrUrl(a)}" target="_blank" rel="noopener">${esc(a)}</a><button class="icon-btn" type="button" data-copy="${esc(a)}" aria-label="Copy address">${pix('copy', 14)}</button></div></div>`).join('')}</div>`
      : '<p>The treasury and team wallet addresses are published here at launch, with links to every transaction.</p>'}`;
}

// ---------- Aturan + pengecualian ----------
function renderRules() {
  const bps = Number(cfg.holderShareBps ?? 2500);
  $('#sh-holders').textContent = pct(bps);
  $('#sh-team').textContent = pct(10000 - bps);
  $('#sh-bar').style.width = `${bps / 100}%`;
  $('#rule-line').innerHTML = `Hold an average of at least <b>${int(cfg.minTokens ?? 100000)} $GHOST</b> over the hour's 4 readings.`;
  const known = [];
  if (cfg.treasury) known.push(['GHOSTKEY treasury', cfg.treasury]);
  if (cfg.owner) known.push(['Team wallet', cfg.owner]);
  for (const a of cfg.teamWallets || []) known.push(['Team wallet', a]);
  const rows = [
    ['Pons bonding curve and trading pool', null],
    ['Pons fee escrow and pool manager', null],
    ['Our fee wallet', null],
    ...known,
    ['Burn address and zero address', '0x000000000000000000000000000000000000dEaD'],
  ];
  $('#ex-list').innerHTML = rows.map(([lbl, a]) => `<li><span>${esc(lbl)}</span>${a ? `<a class="mono link" href="${addrUrl(a)}" target="_blank" rel="noopener">${esc(short(a, 8, 6))}</a>` : '<span class="mono dim">listed in each hour</span>'}</li>`).join('');
}

// ---------- Statistik ----------
async function loadStats() {
  try {
    const s = await api('/api/stats');
    $('#s-paid').textContent = usd(s.holderCreditPaidUsd ?? 0, { max: 2 });
    $('#s-hours').textContent = int(s.hoursPosted ?? 0);
  } catch { $('#s-paid').textContent = '—'; $('#s-hours').textContent = '—'; }
}

// ---------- Ledger ----------
const STATUS = {
  posted: '<span class="tag ok">Posted</span>',
  no_fees: '<span class="tag">No fees</span>',
  pending: '<span class="tag gold">Pending</span>',
  no_holders: '<span class="tag" title="There were fees, but no wallet qualified. The pool rolls into the next hour.">No holders · rolled over</span>',
};

async function loadLedger() {
  const el = $('#ledger-body');
  try {
    const r = await api('/api/ledger?limit=48');
    hours = Array.isArray(r) ? r : r?.hours || [];
  } catch (e) {
    el.innerHTML = `<div class="notice bad">Could not load the ledger (${esc(e.message)}). The raw list lives at <a class="link" href="/api/ledger" target="_blank" rel="noopener">/api/ledger</a>.</div>`;
    return;
  }
  $('#ledger-meta').textContent = hours.length ? `last ${int(hours.length)} hours · UTC` : '';
  if (!hours.length) {
    el.innerHTML = `<div class="empty">${pix('ghost', 44)}<span>No hours posted yet.${cfg.ghostToken ? ' The first hour appears here a few minutes after it ends.' : ' The ledger starts after $GHOST launches.'}</span></div>`;
    return;
  }
  el.innerHTML = `<div class="table-scroll"><table class="table ledger-tbl"><thead><tr>
      <th>Hour (UTC)</th><th class="r">Holder pool</th><th class="r">Wallets paid</th><th class="hide-m">Merkle root</th><th>Status</th><th>On-chain</th>
    </tr></thead><tbody>${hours.map((h) => `<tr data-hour="${esc(h.hour)}">
      <td class="num">${esc(hourLabel(h.hour))}<span class="sub">#${esc(h.hour)} · ${ago(h.hour * 3600_000 + 3600_000)}</span></td>
      <td class="r num">${usd(h.poolUsd ?? 0, { max: 6 })}</td>
      <td class="r num">${int(h.entries ?? 0)}</td>
      <td class="mono hide-m" style="font-size:12.5px">${h.root ? esc(short(h.root, 10, 6)) : '—'}</td>
      <td>${STATUS[h.status] || `<span class="tag">${esc(h.status || '—')}</span>`}</td>
      <td>${h.txHash ? `<a class="proof-link" href="${txUrl(h.txHash)}" target="_blank" rel="noopener">Tx</a>` : '<span class="dim">—</span>'}</td>
    </tr>`).join('')}</tbody></table></div>`;
  const want = new URLSearchParams(location.search).get('hour');
  if (want && hours.some((h) => String(h.hour) === want)) showHour(want, false);
}

async function getHour(hour) {
  if (!hourCache.has(hour)) hourCache.set(hour, api(`/api/ledger/${encodeURIComponent(hour)}`));
  try { return await hourCache.get(hour); } catch (e) { hourCache.delete(hour); throw e; }
}

async function showHour(hour, scroll = true) {
  for (const tr of document.querySelectorAll('.ledger-tbl tr[data-hour]')) tr.classList.toggle('sel', tr.dataset.hour === String(hour));
  const el = $('#hour-detail');
  el.innerHTML = '<p class="loading-line">Loading this hour</p>';
  if (scroll) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
  let d;
  try { d = await getHour(hour); }
  catch (e) { el.innerHTML = `<div class="notice bad">Could not load hour ${esc(hour)} (${esc(e.message)}).</div>`; return; }
  const row = hours.find((h) => String(h.hour) === String(hour)) || {};
  const entries = d.entries || [];
  const poolUsd = d.poolMicro != null ? Number(d.poolMicro) / 1e6 : row.poolUsd;
  el.innerHTML = `<div class="panel tick">
    <div class="sec-h" style="margin-bottom:0"><div><h2 style="font-size:24px">${esc(hourLabel(d.hour ?? hour))}</h2><p>Hour #${esc(d.hour ?? hour)} · ${STATUS[row.status] || ''}</p></div>
      <div style="display:flex;gap:16px;flex-wrap:wrap"><a class="proof-link" href="/api/ledger/${esc(hour)}/raw" target="_blank" rel="noopener">This hour's raw file</a>${d.root && cfg.ledger ? `<button class="vbtn" type="button" data-rootcheck="${esc(d.hour ?? hour)}" data-root="${esc(d.root)}">Compare root with contract</button><span class="vres"></span>` : ''}</div></div>
    <div class="hd-grid">
      <div><span class="label">Holder pool</span><b>${usd(poolUsd ?? 0, { max: 6 })}</b></div>
      <div><span class="label">Wallets paid</span><b>${int(entries.length)}</b></div>
      <div><span class="label">Minimum average</span><b>${compact(d.minTokens ?? cfg.minTokens)}</b></div>
      <div><span class="label">Excluded wallets</span><b>${int((d.excluded || []).length)}</b></div>
    </div>
    <dl class="kv">
      <div><dt>Merkle root</dt><dd>${d.root ? `${esc(d.root)} <button class="linkbtn" type="button" data-copy="${esc(d.root)}">copy</button>` : '—'}</dd></div>
      <div><dt>Posted to GhostLedger</dt><dd>${row.txHash ? `<a class="link" href="${txUrl(row.txHash)}" target="_blank" rel="noopener">${esc(short(row.txHash, 10, 8))}</a>` : 'not posted'}</dd></div>
      <div><dt>4 balance readings (blocks)</dt><dd><span class="chain-links" style="justify-content:flex-end">${(d.blocks || []).map((b) => `<a href="${blockUrl(b)}" target="_blank" rel="noopener">#${esc(b)}</a>`).join('') || '—'}</span></dd></div>
      <div><dt>Fee claims this hour</dt><dd><span class="chain-links" style="justify-content:flex-end">${(d.feeTxs || row.feeTxs || []).map((h) => `<a href="${txUrl(h)}" target="_blank" rel="noopener">${esc(short(h, 8, 6))}</a>`).join('') || 'none'}</span></dd></div>
      <div><dt>Excluded</dt><dd><span class="chain-links" style="justify-content:flex-end">${(d.excluded || []).map((a) => `<a href="${addrUrl(a)}" target="_blank" rel="noopener">${esc(short(a))}</a>`).join('') || '—'}</span></dd></div>
    </dl>
    <div style="margin-top:20px">${entries.length ? entriesTable(d.hour ?? hour, entries, d.root) : `<div class="empty">${pix('ghost', 36)}<span>No wallet was paid this hour${row.status === 'no_fees' ? ': there were no trading fees' : row.status === 'no_holders' ? ': no wallet qualified, so the pool rolls into the next hour' : ''}.</span></div>`}</div>
  </div>`;
}

function entriesTable(hour, entries, root) {
  const max = 200;
  return `<div class="table-scroll"><table class="table"><thead><tr><th>Wallet</th><th class="r hide-m">Average $GHOST</th><th class="r">Credit</th><th>Check it</th></tr></thead><tbody>
    ${entries.slice(0, max).map((e, i) => `<tr>
      <td><a class="mono link" href="${addrUrl(e.wallet)}" target="_blank" rel="noopener" style="font-size:13px">${esc(short(e.wallet, 8, 6))}</a></td>
      <td class="r num hide-m">${int(Math.floor(Number(e.avgBalance ?? 0)))}</td>
      <td class="r num">${usd(Number(e.creditMicro) / 1e6, { max: 6 })}</td>
      <td><button class="vbtn" type="button" data-verify="${esc(hour)}|${esc(e.wallet)}|${esc(e.creditMicro)}|${i}" data-root="${esc(root || '')}">Verify</button><div class="vres"></div></td>
    </tr>`).join('')}</tbody></table></div>
    ${entries.length > max ? `<p class="hint" style="margin-top:10px">Showing ${max} of ${int(entries.length)}. Use “Check any wallet” below, or download the JSON for the full list.</p>` : ''}`;
}

// ---------- Verifikasi ----------
// 1) di browser: leaf = keccak256(abi.encode(wallet, uint64 hour, uint128 creditMicro)), naik ke akar dengan pasangan tersortir
// 2) on-chain: GhostLedger.verify(...) lewat eth_call (tanpa dompet)
async function localCheck(E, { hour, wallet, creditMicro, proof, root }) {
  if (!root) return null;
  const coder = E.AbiCoder.defaultAbiCoder();
  const enc = coder.encode(['address', 'uint64', 'uint128'], [wallet, BigInt(hour), BigInt(creditMicro)]);
  const fold = (leaf) => proof.reduce((h, p) => {
    const [a, b] = BigInt(h) <= BigInt(p) ? [h, p] : [p, h];
    return E.keccak256(E.concat([a, b]));
  }, leaf);
  const single = E.keccak256(enc);
  if (fold(single).toLowerCase() === root.toLowerCase()) return true;
  // gaya StandardMerkleTree OpenZeppelin (leaf di-hash dua kali) — diterima juga
  return fold(E.keccak256(single)).toLowerCase() === root.toLowerCase();
}

async function chainCheck(E, { hour, wallet, creditMicro, proof }) {
  if (!cfg.ledger) return { state: 'none' };
  const iface = new E.Interface(['function verify(uint64 hour, address wallet, uint128 creditMicro, bytes32[] proof) view returns (bool)']);
  const data = iface.encodeFunctionData('verify', [BigInt(hour), wallet, BigInt(creditMicro), proof]);
  const { result, rpc } = await ethCall(cfg.ledger, data);
  const [ok] = iface.decodeFunctionResult('verify', result);
  return { state: ok ? 'true' : 'false', rpc };
}

async function verifyInto(out, args) {
  out.innerHTML = '<span class="loading-line" style="font-size:12.5px">Checking</span>';
  let E;
  try { E = await loadEthers(); }
  catch { out.innerHTML = '<span class="tag bad">Could not load the checker library</span>'; return; }
  const parts = [];
  try {
    const loc = await localCheck(E, args);
    if (loc != null) parts.push(loc ? `<span class="tag ok" title="Computed in your browser from the proof">${pix('check', 9)}Proof matches root</span>` : '<span class="tag bad">Proof does not match root</span>');
  } catch { parts.push('<span class="tag bad">Bad proof data</span>'); }
  try {
    const c = await chainCheck(E, args);
    if (c.state === 'none') parts.push('<span class="tag gold">Contract not deployed yet</span>');
    else parts.push(`<span class="tag ${c.state === 'true' ? 'solid' : 'bad'}" title="GhostLedger.verify() via ${esc(new URL(c.rpc).host)}">verify() = ${c.state.toUpperCase()}</span><a class="src" href="${addrUrl(cfg.ledger)}?tab=read_contract" target="_blank" rel="noopener">contract ↗</a>`);
  } catch (e) {
    parts.push(`<span class="tag bad" title="${esc(e.message)}">RPC unreachable</span>`);
  }
  out.innerHTML = parts.join('');
}

async function onVerifyClick(btn) {
  const [hour, wallet, creditMicro, idx] = btn.dataset.verify.split('|');
  const out = btn.nextElementSibling;
  btn.disabled = true;
  try {
    let proof = null, root = btn.dataset.root || null;
    if (idx !== '') {
      const d = await getHour(hour);
      const e = (d.entries || [])[Number(idx)];
      if (e && e.wallet.toLowerCase() === wallet.toLowerCase()) { proof = e.proof || []; root = d.root || root; }
    }
    if (!proof) proof = JSON.parse(btn.dataset.proof || '[]');
    await verifyInto(out, { hour, wallet, creditMicro, proof, root });
  } catch (e) {
    out.innerHTML = `<span class="tag bad">${esc(e.message)}</span>`;
  } finally { btn.disabled = false; }
}

// Bandingkan akar di JSON dengan GhostLedger.hourOf(hour).root yang tersimpan on-chain
async function rootCheck(btn) {
  const out = btn.nextElementSibling;
  btn.disabled = true;
  out.innerHTML = '<span class="loading-line" style="font-size:12.5px">Reading the contract</span>';
  try {
    const E = await loadEthers();
    const iface = new E.Interface(['function hourOf(uint64 hour) view returns (bytes32 root, uint128 poolMicro, uint32 entries, uint64 postedAt)']);
    const { result } = await ethCall(cfg.ledger, iface.encodeFunctionData('hourOf', [BigInt(btn.dataset.rootcheck)]));
    const [root] = iface.decodeFunctionResult('hourOf', result);
    const same = String(root).toLowerCase() === btn.dataset.root.toLowerCase();
    out.innerHTML = /^0x0+$/.test(root) ? '<span class="tag gold">Not posted on-chain yet</span>'
      : same ? `<span class="tag solid">${pix('check', 9)}Root matches contract</span>` : '<span class="tag bad">Root differs from contract</span>';
  } catch (e) {
    out.innerHTML = `<span class="tag bad" title="${esc(e.message)}">RPC unreachable</span>`;
  } finally { btn.disabled = false; }
}

// ---------- Cek dompet ----------
async function checkWallet(w, focusHour) {
  const out = $('#check-out');
  if (!isAddr(w)) { out.innerHTML = '<p class="err-line">Enter a wallet address: 0x followed by 40 characters.</p>'; return; }
  out.innerHTML = '<p class="loading-line">Reading the chain and the ledger</p>';
  let r;
  try { r = await api(`/api/holder/${w}`); }
  catch (e) { out.innerHTML = `<p class="err-line">${e.status === 429 ? 'Too many checks. Wait a minute.' : `Could not check this wallet (${esc(e.message)}).`}</p>`; return; }
  const credits = r.credits || [];
  const total = r.totalCreditedUsd ?? credits.reduce((a, c) => a + Number(c.creditUsd || 0), 0);
  out.innerHTML = `<div class="grid-4" style="margin-bottom:16px">
      <div class="panel"><span class="label">Wallet</span><p class="mono" style="margin-top:10px;font-size:13px;overflow-wrap:anywhere"><a class="link" href="${addrUrl(r.wallet || w)}" target="_blank" rel="noopener">${esc(r.wallet || w)}</a></p></div>
      <div class="panel"><span class="label">$GHOST now</span><div class="bignum" style="font-size:28px;margin-top:10px">${cfg.ghostToken && r.balanceNow != null ? int(Math.floor(Number(r.balanceNow))) : '—'}</div>${cfg.ghostToken ? `<a class="src" href="${tokenUrl(cfg.ghostToken)}?tab=holders" target="_blank" rel="noopener">holders on Blockscout ↗</a>` : '<p class="hint">Not launched yet</p>'}</div>
      <div class="panel"><span class="label">Qualifies now</span><div class="bignum" style="font-size:28px;margin-top:10px">${r.eligibleNow == null ? '—' : r.eligibleNow ? 'Yes' : 'No'}</div><p class="hint">min ${compact(cfg.minTokens ?? 100000)} average</p></div>
      <div class="panel"><span class="label">Credit received</span><div class="bignum" style="font-size:28px;margin-top:10px">${usd(total, { max: 2 })}</div><p class="hint">${int(credits.length)} hour${credits.length === 1 ? '' : 's'}</p></div>
    </div>
    ${credits.length ? `<div class="table-scroll"><table class="table"><thead><tr><th>Hour (UTC)</th><th class="r">Credit</th><th class="hide-m">Root</th><th>Posted</th><th>Verify</th></tr></thead><tbody>
      ${credits.map((c) => {
        const micro = c.creditMicro ?? Math.round(Number(c.creditUsd) * 1e6);
        return `<tr${String(c.hour) === String(focusHour) ? ' class="sel"' : ''}>
        <td class="num">${esc(hourLabel(c.hour))}<span class="sub">#${esc(c.hour)}</span></td>
        <td class="r num">${usd(c.creditUsd, { max: 6 })}</td>
        <td class="mono hide-m" style="font-size:12.5px">${esc(short(c.root || '', 10, 6))}</td>
        <td>${c.txHash ? `<a class="proof-link" href="${txUrl(c.txHash)}" target="_blank" rel="noopener">Tx</a>` : '<span class="tag gold">Not yet</span>'}</td>
        <td><button class="vbtn" type="button" data-verify="${esc(c.hour)}|${esc(r.wallet || w)}|${esc(micro)}|" data-proof='${esc(JSON.stringify(c.proof || []))}' data-root="${esc(c.root || '')}">Verify</button><div class="vres"></div></td>
      </tr>`;
      }).join('')}</tbody></table></div>`
    : `<div class="empty">${pix('coin', 32)}<span>No Ghost Credit for this wallet yet.</span></div>`}
    <p class="src" style="margin-top:12px">Source: <a href="/api/holder/${esc(r.wallet || w)}" target="_blank" rel="noopener">/api/holder/${esc(short(r.wallet || w))} ↗</a> · on-chain check via ${esc(new URL(RPC_URLS[0]).host)}</p>`;
  if (focusHour) out.querySelector('tr.sel .vbtn')?.click();
}

// Verifikasi manual
async function manualVerify() {
  const out = $('#v-out');
  const hour = $('#v-hour').value.trim(), wallet = $('#v-wallet').value.trim(), credit = $('#v-credit').value.trim();
  let proof;
  try { proof = JSON.parse($('#v-proof').value.trim() || '[]'); if (!Array.isArray(proof)) throw 0; }
  catch { out.innerHTML = '<span class="err-line">Proof must be a JSON array, like ["0x…","0x…"].</span>'; return; }
  if (!/^\d+$/.test(hour) || !/^\d+$/.test(credit) || !isAddr(wallet)) { out.innerHTML = '<span class="err-line">Fill in hour and credit as whole numbers, and a 0x wallet.</span>'; return; }
  let root = null;
  try { root = (await getHour(hour)).root || null; } catch {}
  verifyInto(out, { hour, wallet, creditMicro: credit, proof, root });
}

async function init() {
  paintIcons(document, 20);
  cfg = await getConfig();
  renderContracts();
  renderRules();
  loadStats();
  loadLedger();
  const gh = cfg.links?.github;
  $('#gh-script').innerHTML = gh ? `<a class="proof-link" href="${esc(gh.replace(/\/$/, ''))}/tree/main/tools/verify" target="_blank" rel="noopener">tools/verify on GitHub</a>` : '<span class="src">Source code: published at launch</span>';

  document.addEventListener('click', (e) => {
    const c = e.target.closest('[data-copy]');
    if (c) { copy(c.dataset.copy, 'Copied'); return; }
    const rc = e.target.closest('[data-rootcheck]');
    if (rc) { rootCheck(rc); return; }
    const v = e.target.closest('[data-verify]');
    if (v) { onVerifyClick(v); return; }
    const tr = e.target.closest('.ledger-tbl tr[data-hour]');
    if (tr && !e.target.closest('a')) showHour(tr.dataset.hour);
  });
  $('#check-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const w = $('#check-in').value.trim();
    const u = new URL(location.href); u.searchParams.set('wallet', w); history.replaceState(null, '', u);
    checkWallet(w);
  });
  $('#v-run').onclick = manualVerify;
  const p = new URLSearchParams(location.search);
  if (p.get('wallet')) { $('#check-in').value = p.get('wallet'); checkWallet(p.get('wallet'), p.get('hour')); }
  if (location.hash) setTimeout(() => document.querySelector(location.hash)?.scrollIntoView(), 50);
}

chrome();
init();
