#!/usr/bin/env node
// Re-check a GHOSTKEY monthly fee report from public data. Needs no keys and sends no transactions.
//
//   node tools/verify/month-report.mjs --month 2026-11 [--base https://ghostkeyai.com] [--chain] [--rpc URL]
//
// Without --chain it re-adds every total from the listed claims and hours, re-runs the split and carry-over
// arithmetic, downloads every hour file, hashes it, rebuilds its Merkle root and re-sums its credits.
// With --chain it also reads Robinhood Chain: every claim, treasury and owner transfer (recipient, amount, success),
// and every GhostLedger root, pool and entry count.
// Exit code 0 = everything matches, 1 = a mismatch, 2 = bad input or network error.
import { Contract, JsonRpcProvider, keccak256 } from 'ethers';
import { buildTree } from '../../server/merkle.mjs';

const args = {};
for (let i = 2; i < process.argv.length; i++) {
  const k = process.argv[i];
  if (k.startsWith('--')) args[k.slice(2)] = process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[++i] : true;
}
const base = String(args.base || 'https://ghostkeyai.com').replace(/\/+$/, '');
const month = args.month || new Date().toISOString().slice(0, 7);
if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) { console.log('usage: node tools/verify/month-report.mjs --month YYYY-MM [--base URL] [--chain] [--rpc URL]'); process.exit(2); }

let ok = 0, bad = 0;
const check = (name, cond, extra = '') => { cond ? ok++ : bad++; console.log(`${cond ? 'OK  ' : 'FAIL'} ${name}${extra ? '  ' + extra : ''}`); };
const B = (x) => BigInt(x ?? 0);
const sum = (xs, f) => xs.reduce((s, x) => s + B(f(x)), 0n);
// Batasi permintaan paralel supaya situs dan RPC tidak dibanjiri
async function each(list, n, fn) { const out = []; let i = 0; await Promise.all(Array.from({ length: n }, async () => { while (i < list.length) { const k = i++; out[k] = await fn(list[k], k); } })); return out; }

let d;
try {
  const r = await fetch(`${base}/api/report/${month}`);
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  d = await r.json();
} catch (e) { console.error(`could not load ${base}/api/report/${month}: ${e.message}`); process.exit(2); }
const t = d.totals, C = d.claims, Hs = d.hours;
console.log(`${month}: ${C.length} claims, ${Hs.length} hours, split ${d.split.holderShareBps / 100}% holders / ${d.split.ownerShareBps / 100}% team\n`);

// --- 1. Totals re-added from the rows ---
check('claimed total = sum of claims', sum(C, (c) => c.claimedWei) === B(t.claimedWei) && sum(C, (c) => c.usdMicro) === B(t.claimedMicro));
check('holder total = sum of holder shares', sum(C, (c) => c.holderWei) === B(t.holderWei) && sum(C, (c) => c.holderMicro) === B(t.holderMicro));
check('team total = sum of team shares', sum(C, (c) => c.ownerWei) === B(t.ownerWei) && sum(C, (c) => c.ownerMicro) === B(t.ownerMicro));
check('Ghost Credit paid = sum of hourly payouts', sum(Hs, (h) => h.distributedMicro) === B(t.distributedMicro));

// --- 2. Split per claim ---
const ownerBps = B(d.split.ownerShareBps);
check(`every claim: team = floor((holders + team) × ${d.split.ownerShareBps / 100}%)`, C.every((c) => B(c.ownerWei) === ((B(c.holderWei) + B(c.ownerWei)) * ownerBps) / 10000n));
check('every claim: holders + team + gas kept = claimed, gas kept ≥ 0', C.every((c) => B(c.gasKeptWei) >= 0n && B(c.holderWei) + B(c.ownerWei) + B(c.gasKeptWei) === B(c.claimedWei)));
const sentTo = (c, k) => c.txs.filter((x) => x.kind === k).reduce((s, x) => s + B(x.wei), 0n);
check('every claim: listed transfers carry exactly the two shares', C.every((c) => sentTo(c, 'to_treasury') === B(c.holderWei) && sentTo(c, 'to_owner') === B(c.ownerWei)));

// --- 3. Hourly pool and carry-over ---
const byHour = new Map();
for (const c of C) byHour.set(c.hour, (byHour.get(c.hour) || 0n) + B(c.holderMicro));
check("each hour's fees = holder shares claimed in that hour", Hs.every((h) => B(h.feesMicro) === (byHour.get(h.hour) || 0n)));
check('each hour: pool = fees + carry-in, paid + carry-out = pool', Hs.every((h) => B(h.poolMicro) === B(h.feesMicro) + B(h.carryInMicro) && B(h.distributedMicro) + B(h.carryOutMicro) === B(h.poolMicro)));
check('carry-over chains from hour to hour', Hs.every((h, i) => !i || B(h.carryInMicro) === B(Hs[i - 1].carryOutMicro)));

// --- 4. Hour files ---
const withFile = Hs.filter((h) => h.uriHash);
const fileRes = await each(withFile, 4, async (h) => {
  try {
    const r = await fetch(`${base}/api/ledger/${h.hour}/raw`);
    if (!r.ok) return `hour ${h.hour}: HTTP ${r.status}`;
    const buf = Buffer.from(await r.arrayBuffer());
    if (keccak256(buf) !== h.uriHash) return `hour ${h.hour}: hash`;
    const f = JSON.parse(buf.toString('utf8'));
    if (f.root !== h.root) return `hour ${h.hour}: root`;
    if (buildTree(f.entries.map((e) => ({ wallet: e.wallet, hour: f.hour, creditMicro: e.creditMicro }))).root !== h.root) return `hour ${h.hour}: rebuilt root`;
    if (sum(f.entries, (e) => e.creditMicro) !== B(h.distributedMicro) || f.entries.length !== h.entries) return `hour ${h.hour}: credits`;
    return null;
  } catch (e) { return `hour ${h.hour}: ${e.message}`; }
});
const fileBad = fileRes.filter(Boolean);
check(`every hour file: keccak256 = uriHash, rebuilt root = root, credits add up (${withFile.length} files)`, fileBad.length === 0, fileBad.slice(0, 5).join(', '));

// --- 5. Robinhood Chain ---
if (args.chain) {
  // RPC resmi dulu; kalau jaringan menolak, pindah ke RPC publik kedua (atau pakai --rpc sendiri)
  const rpcs = args.rpc ? [args.rpc] : ['https://rpc.mainnet.chain.robinhood.com', 'https://robinhood-rpc.publicnode.com'];
  let provider = null;
  for (const url of rpcs) {
    const p = new JsonRpcProvider(url, d.chainId || 4663, { staticNetwork: true });
    try { await p.getBlockNumber(); provider = p; console.log(`·    reading Robinhood Chain via ${url}`); break; }
    catch { p.destroy(); console.log(`·    could not reach ${url}`); }
  }
  if (!provider) { console.error('no RPC reachable; pass --rpc <url>'); process.exit(2); }
  const txList = C.flatMap((c) => c.txs.map((x) => ({ ...x, hour: c.hour })));
  const txBad = (await each(txList, 4, async (x) => {
    try {
      const [tx, rc] = await Promise.all([provider.getTransaction(x.txHash), provider.getTransactionReceipt(x.txHash)]);
      if (!tx || !rc || rc.status !== 1) return `${x.kind} ${x.txHash.slice(0, 10)}: missing or failed`;
      if (x.kind === 'to_treasury' || x.kind === 'to_owner') {
        const want = x.kind === 'to_treasury' ? d.treasury : d.owner;
        if (tx.to?.toLowerCase() !== String(x.to).toLowerCase() || (want && tx.to.toLowerCase() !== want.toLowerCase())) return `${x.kind} ${x.txHash.slice(0, 10)}: recipient`;
        if (tx.value !== B(x.wei)) return `${x.kind} ${x.txHash.slice(0, 10)}: amount`;
      }
      return null;
    } catch (e) { return `${x.txHash.slice(0, 10)}: ${e.message}`; }
  })).filter(Boolean);
  check(`every transaction succeeded; transfers went to the treasury and owner with the listed amounts (${txList.length} txs)`, txBad.length === 0, txBad.slice(0, 5).join(', '));

  if (d.ledger) {
    const L = new Contract(d.ledger, ['function hourOf(uint64) view returns (bytes32 root, uint128 poolMicro, uint32 entries, uint64 postedAt)'], provider);
    const posted = Hs.filter((h) => h.status === 'posted');
    const lBad = (await each(posted, 4, async (h) => {
      try {
        const r = await L.hourOf(h.hour);
        return r.root.toLowerCase() === String(h.root).toLowerCase() && r.poolMicro === B(h.poolMicro) && Number(r[2]) === h.entries ? null : `hour ${h.hour}`;
      } catch (e) { return `hour ${h.hour}: ${e.message}`; }
    })).filter(Boolean);
    check(`GhostLedger holds the same root, pool and entry count (${posted.length} hours)`, lBad.length === 0, lBad.slice(0, 5).join(', '));
  }
} else console.log('·    add --chain to also check every transaction and GhostLedger root on Robinhood Chain');

console.log(`\n${ok} checks passed, ${bad} failed`);
process.exit(bad ? 1 : 0);
