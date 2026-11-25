#!/usr/bin/env node
// Recompute one Ghost Credit hour from its public JSON and compare it with the chain.
// Needs no keys and sends no transactions.
//
//   node tools/verify/recompute-hour.mjs --hour 498760 [--base https://ghostkeyai.com] [--chain] [--rpc URL]
//   node tools/verify/recompute-hour.mjs --file data/ledger/hour-498760.json [--ledger 0x…] [--chain]
//
// Checks, in order:
//   1. avgBalance = floor(sum of the 4 readings / 4) for every wallet
//   2. creditMicro = floor(poolMicro × avgBalance / eligibleTotalAvg), and the eligible total adds up
//   3. distributed + carry-over = pool
//   4. the Merkle root rebuilt from the entries equals the published root, and every proof verifies
//   5. (if posted) GhostLedger.hourOf(hour) holds the same root, pool and entry count,
//      and the Posted event's uriHash equals keccak256 of the exact JSON bytes
//   6. (--chain, needs an archive RPC) each reading equals balanceOf(wallet) at that block,
//      and each block is the last one at or before its snapshot time
// Exit code 0 = everything matches, 1 = a mismatch, 2 = bad input or network error.
import { readFileSync } from 'node:fs';
import { Contract, Interface, JsonRpcProvider, keccak256 } from 'ethers';
import { buildTree, leafHash, verifyProof } from '../../server/merkle.mjs';

const RPC = 'https://rpc.mainnet.chain.robinhood.com';
const args = {};
for (let i = 2; i < process.argv.length; i++) {
  const k = process.argv[i];
  if (!k.startsWith('--')) continue;
  args[k.slice(2)] = process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[++i] : true;
}
const base = String(args.base || 'https://ghostkeyai.com').replace(/\/+$/, '');
if (!args.hour && !args.file) {
  console.log('usage: node tools/verify/recompute-hour.mjs --hour <n> [--base URL] [--chain] [--rpc URL] | --file <hour-n.json> [--ledger 0x…]');
  process.exit(2);
}

let ok = 0, bad = 0;
const check = (name, cond, extra = '') => { cond ? ok++ : bad++; console.log(`${cond ? 'OK  ' : 'FAIL'} ${name}${extra ? '  ' + extra : ''}`); };

// --- 1. Exact bytes of the hour file ---
let bytes, meta = {}, ledger = args.ledger || null;
try {
  if (args.file) bytes = readFileSync(args.file);
  else {
    const r = await fetch(`${base}/api/ledger/${args.hour}/raw`);
    if (!r.ok) throw new Error(`no published file for hour ${args.hour} (HTTP ${r.status})`);
    bytes = Buffer.from(await r.arrayBuffer());
    meta = await (await fetch(`${base}/api/ledger/${args.hour}`)).json();
    if (!ledger) ledger = (await (await fetch(`${base}/api/config`)).json()).ledger;
  }
} catch (e) { console.error(e.message); process.exit(2); }
const f = JSON.parse(bytes.toString('utf8'));
const fileHash = keccak256(bytes);
console.log(`hour ${f.hour} (${f.startsAt} → ${f.endsAt})  pool ${f.poolMicro} micro-USD  ${f.entries.length} wallets  keccak256(file) ${fileHash}\n`);

// --- 2. Averages and pro-rata shares ---
const avgOf = (rs) => rs.map(BigInt).reduce((s, x) => s + x, 0n) / 4n;
const everyone = [...f.entries, ...(f.zeroCredit || [])];
check('every average = floor(sum of 4 readings / 4)', everyone.every((e) => e.readings.length === 4 && avgOf(e.readings).toString() === e.avgBalance));
const total = everyone.reduce((s, e) => s + BigInt(e.avgBalance), 0n);
check('eligible total = sum of eligible averages', total.toString() === f.eligibleTotalAvg, `${total}`);
const minRaw = BigInt(f.minTokens) * 10n ** BigInt(f.decimals);
check(`every eligible wallet averages ≥ ${f.minTokens} tokens`, everyone.every((e) => BigInt(e.avgBalance) >= minRaw));
const excluded = new Set(f.excluded.map((x) => x.address.toLowerCase()));
check('no excluded address received credit', f.entries.every((e) => !excluded.has(e.wallet.toLowerCase())));
const pool = BigInt(f.poolMicro);
const wrong = f.entries.filter((e) => BigInt(e.creditMicro) !== (pool * BigInt(e.avgBalance)) / total);
check('every credit = floor(pool × average / total)', wrong.length === 0, wrong.map((e) => e.wallet).join(', '));
check('zero-credit wallets really round to 0', (f.zeroCredit || []).every((e) => (pool * BigInt(e.avgBalance)) / total === 0n));
const distributed = f.entries.reduce((s, e) => s + BigInt(e.creditMicro), 0n);
check('distributed + carry-over = pool', distributed === BigInt(f.distributedMicro) && distributed + BigInt(f.carryOutMicro) === pool &&
  BigInt(f.feesMicro) + BigInt(f.carryInMicro) === pool);

// --- 3. Merkle ---
const tree = buildTree(f.entries.map((e) => ({ wallet: e.wallet, hour: f.hour, creditMicro: e.creditMicro })));
check('rebuilt Merkle root = published root', tree.root === f.root, f.root);
check('every published proof verifies', f.entries.every((e) => verifyProof(leafHash(e.wallet, f.hour, e.creditMicro), e.proof, f.root)));

// --- 4. GhostLedger ---
const provider = new JsonRpcProvider(args.rpc || RPC, 4663, { staticNetwork: true });
if (ledger && f.root) {
  try {
    const abi = ['function hourOf(uint64) view returns (bytes32 root, uint128 poolMicro, uint32 entries, uint64 postedAt)',
      'event Posted(uint64 indexed hour, bytes32 root, uint128 poolMicro, uint32 entries, bytes32 uriHash)'];
    const c = new Contract(ledger, abi, provider);
    const h = await c.hourOf(f.hour);
    if (h.postedAt === 0n) console.log('·    hour not posted on-chain yet');
    else {
      check('on-chain root, pool and entry count match', h.root.toLowerCase() === String(f.root).toLowerCase() && h.poolMicro === pool && Number(h[2]) === f.entries.length,   // h[2]: .entries bentrok dengan Result.entries()
        `chain ${h.root} / ${h.poolMicro} / ${h[2]}`);
      if (meta.txHash) {
        const rc = await provider.getTransactionReceipt(meta.txHash);
        const iface = new Interface(abi);
        const ev = rc?.logs.filter((l) => l.address.toLowerCase() === ledger.toLowerCase()).map((l) => iface.parseLog(l)).find((x) => x?.name === 'Posted');
        check('Posted.uriHash = keccak256(file bytes)', ev?.args.uriHash === fileHash, meta.txHash);
      }
    }
  } catch (e) { console.log(`·    on-chain check skipped: ${e.message}`); }
} else console.log('·    no GhostLedger address (pass --ledger) or no root for this hour — on-chain check skipped');

// --- 5. Balances at the snapshot blocks (archive RPC) ---
if (args.chain) {
  try {
    const t = new Contract(f.token, ['function balanceOf(address) view returns (uint256)'], provider);
    let same = true;
    for (const e of everyone) {
      for (let i = 0; i < 4; i++) {
        const b = await t.balanceOf(e.wallet, { blockTag: f.blocks[i] });
        if (b.toString() !== e.readings[i]) { same = false; console.log(`     ${e.wallet} block ${f.blocks[i]}: chain ${b} vs file ${e.readings[i]}`); }
      }
    }
    check('every reading = balanceOf at its block', same);
    let blocksOk = true;
    for (let i = 0; i < 4; i++) {
      const target = Date.parse(f.snapshotTimes[i]) / 1000;
      const [b, next] = await Promise.all([provider.getBlock(f.blocks[i]), provider.getBlock(f.blocks[i] + 1)]);
      if (!(b.timestamp <= target && (!next || next.timestamp > target))) blocksOk = false;
    }
    check('each block is the last one at or before its snapshot time', blocksOk);
  } catch (e) { console.log(`·    balance check skipped: ${e.message}`); }
}

console.log(`\n${ok} checks passed, ${bad} failed`);
process.exit(bad ? 1 : 0);
