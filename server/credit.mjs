// Mesin Ghost Credit per jam (25% fee $GHOST → kredit AI untuk pemegang).
// Jam ke-n = floor(unix/3600). Pada menit ke-5 tiap jam, jam sebelumnya (n) diproses:
//   1. pool = bagian pemegang dari panen selama jam n (tabel harvests) + sisa pembulatan jam sebelumnya
//   2. snapshot saldo $GHOST di 4 blok (:15, :30, :45, :60), daftar pemegang dari event Transfer
//   3. kecualikan alamat sistem/tim; layak bila rata-rata ≥ HOLDER_MIN_TOKENS
//   4. bagian = floor(pool × rata-rata / total rata-rata layak) dalam mikro-USD; sisa → jam berikutnya
//   5. pohon Merkle (leaf = keccak256(abi.encode(wallet, uint64 hour, uint128 creditMicro)))
//   6. tulis data/ledger/hour-<n>.json (berkas tetap; uriHash = keccak256 isi berkas)
//   7. kreditkan saldo akun (akun 'pending' dibuat otomatis), lalu GhostLedger.post(...) bila dikonfigurasi
// Idempoten: satu baris ledger_hours per jam; jam 'pending' hanya dicoba posting ulang.
import { writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { keccak256, toUtf8Bytes } from 'ethers';
import { config, microToUsd } from './config.mjs';
import { q, tx, now as dbNow, kvGet, kvSet } from './db.mjs';
import { ensureAccount } from './auth.mjs';

export const SNAPSHOT_OFFSETS = [900, 1800, 2700, 3600];   // detik sejak awal jam: :15 :30 :45 :60
export const LEAF_ENCODING = 'keccak256(abi.encode(address wallet, uint64 hour, uint128 creditMicro))';
const ZERO = '0x0000000000000000000000000000000000000000';
const DEAD = '0x000000000000000000000000000000000000dead';

export const hourOf = (ms = Date.now()) => Math.floor(ms / 3_600_000);
export const LEDGER_DIR = () => join(config.dataDir, 'ledger');
export const hourFilePath = (hour) => join(LEDGER_DIR(), `hour-${hour}.json`);

// ---------- Ketergantungan bawaan (bisa diganti di tes) ----------
async function defaultDeps(over = {}) {
  const d = { now: Date.now, ...over };
  if (!d.merkle) d.merkle = await import('./merkle.mjs');
  if (d.ledger === undefined && config.ledgerAddress) {
    try { d.ledger = await import('./chain/ledger.mjs'); } catch (e) { console.warn('[credit] ledger.mjs tidak tersedia:', e.message); d.ledger = null; }
  }
  const { hasMnemonic, gasWallet, feeWallet } = await import('./chain/wallets.mjs');
  if (d.signer === undefined) d.signer = hasMnemonic() ? gasWallet().signer : null;
  if (d.feeWallet === undefined) d.feeWallet = hasMnemonic() ? feeWallet(0).address : (config.feeWalletOverride || null);
  if (!d.tokenReader && config.ghostToken) {
    const { createTokenReader } = await import('./chain/token.mjs');
    d.tokenReader = createTokenReader(config.ghostToken, {
      deployBlock: config.tokenDeployBlock, store: { get: (k) => kvGet(`tok:${k}`), set: (k, v) => kvSet(`tok:${k}`, v) },
    });
  }
  return d;
}

// Daftar pengecualian: sistem Pons + 0x0 + 0x…dEaD + dompet fee + TREASURY + OWNER + TEAM
export async function exclusionList({ tokenReader, feeWallet }) {
  const list = [{ address: ZERO, label: 'Zero address' }, { address: DEAD, label: 'Burn address' }];
  if (tokenReader?.systemExclusions) list.push(...(await tokenReader.systemExclusions()));
  if (feeWallet) list.push({ address: feeWallet, label: 'GHOSTKEY fee wallet' });
  if (config.treasury) list.push({ address: config.treasury, label: 'GHOSTKEY treasury' });
  if (config.ownerWallet) list.push({ address: config.ownerWallet, label: 'Owner wallet (75% of fees)' });
  for (const t of config.teamWallets) list.push({ address: t, label: 'Team wallet' });
  const seen = new Set();
  return list.map((x) => ({ address: x.address.toLowerCase(), label: x.label }))
    .filter((x) => (seen.has(x.address) ? false : seen.add(x.address)));
}

// Alokasi murni (diuji): pool × avg / total, dibulatkan ke bawah. → { entries:[{wallet, avg, creditMicro}], distributed }
export function allocate(poolMicro, holders) {
  const total = holders.reduce((s, h) => s + h.avg, 0n);
  if (total === 0n || poolMicro <= 0) return { entries: [], zero: [], total, distributed: 0 };
  const pool = BigInt(poolMicro);
  const all = holders.map((h) => ({ ...h, creditMicro: Number((pool * h.avg) / total) }));
  const entries = all.filter((e) => e.creditMicro > 0);
  // Layak tapi bagiannya dibulatkan ke 0 → tidak masuk pohon, tetap dipublikasikan supaya total bisa dihitung ulang
  const zero = all.filter((e) => e.creditMicro === 0);
  return { entries, zero, total, distributed: entries.reduce((s, e) => s + e.creditMicro, 0) };
}

// Bagian pemegang dari panen jam n + daftar tx-nya
function feesForHour(hour) {
  const rows = q.all('SELECT holder_micro, txs FROM harvests WHERE hour=? ORDER BY id', hour);
  const feeTxs = [];
  for (const r of rows) for (const t of JSON.parse(r.txs || '[]')) if (t.txHash) feeTxs.push(t.txHash);
  return { feesMicro: rows.reduce((s, r) => s + r.holder_micro, 0), feeTxs };
}

const carryInFor = (hour) => q.one('SELECT carry_out_micro c FROM ledger_hours WHERE hour < ? ORDER BY hour DESC LIMIT 1', hour)?.c ?? 0;

function proofAt(tree, i, e) {
  const p = tree.proofs;
  if (Array.isArray(p)) return p[i];
  if (p instanceof Map) return p.get(e.wallet) ?? p.get(tree.leaves?.[i]);
  return p?.[e.wallet] ?? p?.[tree.leaves?.[i]] ?? [];
}

/**
 * Proses satu jam. deps opsional: { tokenReader, ledger, merkle, signer, feeWallet, now }.
 * → baris ringkas { hour, status, poolMicro, entries, root, txHash, ... }
 */
export async function runHour(hour, depsIn = {}) {
  hour = Number(hour);
  if (!Number.isInteger(hour) || hour <= 0) throw new Error('bad_hour');
  const deps = await defaultDeps(depsIn);
  const nowMs = deps.now();
  if (nowMs < (hour + 1) * 3_600_000 + 30_000) return { hour, status: 'too_early' };

  const existing = q.one('SELECT * FROM ledger_hours WHERE hour=?', hour);
  if (existing) {
    if (existing.status === 'pending') await tryPost(hour, deps);
    return summary(q.one('SELECT * FROM ledger_hours WHERE hour=?', hour));
  }

  const { feesMicro, feeTxs } = feesForHour(hour);
  const carryIn = carryInFor(hour);
  const poolMicro = feesMicro + carryIn;
  const base = { hour, fees_micro: feesMicro, carry_in_micro: carryIn, pool_micro: poolMicro, fee_txs: JSON.stringify(feeTxs) };

  if (poolMicro <= 0) {
    insertRow({ ...base, status: 'no_fees', carry_out_micro: 0 });
    return summary(q.one('SELECT * FROM ledger_hours WHERE hour=?', hour));
  }
  const tr = deps.tokenReader;
  if (!tr) throw new Error('no_token_reader');

  // --- Snapshot 4 blok ---
  const startTs = hour * 3600;
  const decimals = await tr.decimals();
  const blocks = [];
  for (const off of SNAPSHOT_OFFSETS) blocks.push(await tr.blockAt(startTs + off, blocks.at(-1) || 0));
  const excluded = await exclusionList({ tokenReader: tr, feeWallet: deps.feeWallet });
  const exSet = new Set(excluded.map((x) => x.address));
  const seen = (await tr.holders(blocks[3])).map((a) => a.toLowerCase());
  const candidates = [...new Set(seen)].filter((a) => !exSet.has(a)).sort();
  const readings = [];
  for (const b of blocks) readings.push(await tr.balancesAt(candidates, b));
  const minRaw = BigInt(config.holderMinTokens) * 10n ** BigInt(decimals);
  const holders = [];
  let belowMin = 0;
  for (const w of candidates) {
    const r = readings.map((m) => m.get(w) ?? 0n);
    const avg = r.reduce((s, x) => s + x, 0n) / 4n;
    if (avg === 0n) continue;
    if (avg < minRaw) { belowMin++; continue; }
    holders.push({ wallet: w, readings: r, avg });
  }

  const { entries, zero, total: eligibleTotal, distributed } = allocate(poolMicro, holders);
  const carryOut = poolMicro - distributed;
  let root = null, tree = null;
  if (entries.length) {
    tree = await deps.merkle.buildTree(entries.map((e) => ({ wallet: e.wallet, hour, creditMicro: e.creditMicro })));
    root = tree.root;
  }

  // --- Berkas publik (tetap; hash-nya dikirim on-chain sebagai uriHash) ---
  const file = {
    version: 1,
    hour,
    startsAt: new Date(startTs * 1000).toISOString(),
    endsAt: new Date((startTs + 3600) * 1000).toISOString(),
    chainId: config.chainId,
    token: tr.token || config.ghostToken,
    decimals,
    blocks,
    snapshotTimes: SNAPSHOT_OFFSETS.map((o) => new Date((startTs + o) * 1000).toISOString()),
    holderShareBps: config.holderShareBps,
    feesMicro, carryInMicro: carryIn, poolMicro, distributedMicro: distributed, carryOutMicro: carryOut,
    feeTxs,
    excluded,
    minTokens: config.holderMinTokens,
    holdersSeen: candidates.length,
    belowMin,
    eligibleCount: holders.length,
    eligibleTotalAvg: eligibleTotal.toString(),       // Σ rata-rata semua pemegang layak (penyebut pro-rata)
    allocation: 'creditMicro = floor(poolMicro * avgBalance / eligibleTotalAvg); avgBalance = floor(sum(readings) / 4)',
    leafEncoding: LEAF_ENCODING,
    entries: entries.map((e, i) => ({
      wallet: e.wallet,
      readings: e.readings.map(String),
      avgBalance: e.avg.toString(),
      creditMicro: e.creditMicro,
      proof: proofAt(tree, i, e),
    })),
    zeroCredit: zero.map((e) => ({ wallet: e.wallet, readings: e.readings.map(String), avgBalance: e.avg.toString() })),
    root,
  };
  const text = JSON.stringify(file, null, 2) + '\n';
  const uriHash = keccak256(toUtf8Bytes(text));
  writeFileSync(hourFilePath(hour), text);

  // --- Kreditkan saldo + catat jam (atomik) ---
  const status = entries.length ? 'pending' : 'no_holders';
  tx(() => {
    if (q.one('SELECT 1 FROM ledger_hours WHERE hour=?', hour)) throw new Error('hour_already_processed');
    insertRow({ ...base, status, distributed_micro: distributed, carry_out_micro: carryOut, entries: entries.length,
      root, uri_hash: uriHash, file: `hour-${hour}.json` });
    for (const e of entries) {
      const acc = ensureAccount(e.wallet, 'pending');
      q.run('INSERT INTO credits(hour,wallet,account_id,credit_micro,created_at) VALUES(?,?,?,?,?)', hour, e.wallet, acc.id, e.creditMicro, dbNow());
      q.run('UPDATE accounts SET balance_micro = balance_micro + ? WHERE id=?', e.creditMicro, acc.id);
    }
  });
  if (status === 'pending') await tryPost(hour, deps);
  return summary(q.one('SELECT * FROM ledger_hours WHERE hour=?', hour));
}

function insertRow(r) {
  q.run(`INSERT INTO ledger_hours(hour,status,fees_micro,carry_in_micro,pool_micro,distributed_micro,carry_out_micro,entries,
         root,uri_hash,file,fee_txs,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        r.hour, r.status, r.fees_micro | 0, r.carry_in_micro | 0, r.pool_micro | 0, r.distributed_micro | 0, r.carry_out_micro | 0,
        r.entries | 0, r.root ?? null, r.uri_hash ?? null, r.file ?? null, r.fee_txs ?? '[]', dbNow());
}

// Kirim akar ke GhostLedger (hanya bila LEDGER_ADDRESS + signer poster ada). Gagal → tetap 'pending', dicoba lagi nanti.
async function tryPost(hour, deps) {
  const row = q.one('SELECT * FROM ledger_hours WHERE hour=?', hour);
  if (!row || row.status !== 'pending' || !deps.ledger || !deps.signer) return;
  try {
    // Sudah ada on-chain (mis. proses sebelumnya mati setelah tx terkirim)? → tandai posted, jangan kirim ulang.
    const onChain = await deps.ledger.readHour?.(hour).catch(() => null);
    const rootOnChain = onChain?.root ?? onChain?.[0];
    if (rootOnChain && !/^0x0+$/.test(String(rootOnChain))) {
      const same = String(rootOnChain).toLowerCase() === String(row.root).toLowerCase();
      q.run('UPDATE ledger_hours SET status=?, error=?, posted_at=? WHERE hour=?', same ? 'posted' : 'pending',
            same ? null : 'root_mismatch_on_chain', dbNow(), hour);
      return;
    }
    const r = await deps.ledger.postHour({ hour, root: row.root, poolMicro: row.pool_micro, entries: row.entries, uriHash: row.uri_hash, signer: deps.signer });
    q.run("UPDATE ledger_hours SET status='posted', tx_hash=?, block_number=?, error=NULL, posted_at=? WHERE hour=?",
          r.txHash, r.blockNumber ?? null, dbNow(), hour);
  } catch (e) {
    console.warn(`[credit] posting jam ${hour} gagal:`, e.message);
    q.run('UPDATE ledger_hours SET error=? WHERE hour=?', String(e.message).slice(0, 300), hour);
  }
}

// ---------- Bacaan publik ----------
function summary(r) {
  if (!r) return null;
  return {
    hour: r.hour,
    startsAt: new Date(r.hour * 3_600_000).toISOString(),
    status: r.status,
    feesUsd: microToUsd(r.fees_micro),
    carryInUsd: microToUsd(r.carry_in_micro),
    poolUsd: microToUsd(r.pool_micro),
    distributedUsd: microToUsd(r.distributed_micro),
    carryOutUsd: microToUsd(r.carry_out_micro),
    entries: r.entries,
    root: r.root,
    uriHash: r.uri_hash,
    txHash: r.tx_hash,
    blockNumber: r.block_number,
    feeTxs: JSON.parse(r.fee_txs || '[]'),
  };
}

export function ledgerList(limit = 48) {
  const n = Math.min(500, Math.max(1, Number(limit) || 48));
  return q.all('SELECT * FROM ledger_hours ORDER BY hour DESC LIMIT ?', n).map(summary);
}

export function ledgerHour(hour) {
  const r = q.one('SELECT * FROM ledger_hours WHERE hour=?', Number(hour));
  if (!r) return null;
  const s = summary(r);
  const path = hourFilePath(r.hour);
  if (r.file && existsSync(path)) {
    const text = readFileSync(path, 'utf8');
    return { ...JSON.parse(text), status: s.status, uriHash: s.uriHash, txHash: s.txHash, blockNumber: s.blockNumber, raw: `/api/ledger/${r.hour}/raw` };
  }
  return { hour: s.hour, startsAt: s.startsAt, status: s.status, feesMicro: r.fees_micro, carryInMicro: r.carry_in_micro,
    poolMicro: r.pool_micro, distributedMicro: 0, carryOutMicro: r.carry_out_micro, feeTxs: s.feeTxs, entries: [], root: null, txHash: null };
}

export function ledgerHourRaw(hour) {
  const r = q.one('SELECT file FROM ledger_hours WHERE hour=?', Number(hour));
  const path = r?.file ? hourFilePath(Number(hour)) : null;
  return path && existsSync(path) ? readFileSync(path) : null;
}

// Kredit satu dompet + bukti Merkle (dibaca dari berkas jam)
export function holderCredits(wallet, limit = 168) {
  const rows = q.all(`SELECT c.hour, c.credit_micro, h.root, h.tx_hash, h.status FROM credits c JOIN ledger_hours h ON h.hour=c.hour
                      WHERE c.wallet=? ORDER BY c.hour DESC LIMIT ?`, wallet, limit);
  return rows.map((r) => {
    let proof = null;
    try { proof = JSON.parse(readFileSync(hourFilePath(r.hour), 'utf8')).entries.find((e) => e.wallet === wallet)?.proof ?? null; } catch {}
    return { hour: r.hour, creditUsd: microToUsd(r.credit_micro), creditMicro: r.credit_micro, proof, root: r.root, txHash: r.tx_hash, status: r.status };
  });
}

export function creditStats() {
  const c = q.one('SELECT COALESCE(SUM(credit_micro),0) s FROM credits').s;
  const posted = q.one("SELECT COUNT(*) n FROM ledger_hours WHERE status='posted'").n;
  const last = q.one('SELECT * FROM ledger_hours ORDER BY hour DESC LIMIT 1');
  return { holderCreditPaidUsd: microToUsd(c), hoursPosted: posted, lastHour: last ? summary(last) : null };
}

// ---------- Penjadwal ----------
let running = false;
export async function tick(depsIn = {}) {
  if (running) return [];
  running = true;
  const done = [];
  try {
    const nowMs = (depsIn.now || Date.now)();
    const minute = new Date(nowMs).getUTCMinutes();
    const current = hourOf(nowMs);
    const target = minute >= config.creditMinute ? current - 1 : current - 2;
    // Tunggu panen yang sedang berjalan selesai (supaya pool jam itu lengkap)
    const { isHarvesting } = await import('./harvester.mjs');
    if (isHarvesting()) return done;
    const last = q.one('SELECT MAX(hour) h FROM ledger_hours').h;
    // Belum pernah jalan: mulai dari jam panen pertama (kalau ada) supaya fee lama tidak terlewat
    const firstHarvest = q.one('SELECT MIN(hour) h FROM harvests').h;
    const start = Math.max(last != null ? last + 1 : Math.min(target, firstHarvest ?? target), target - 47);
    for (let h = start; h <= target; h++) done.push(await runHour(h, depsIn));
    // Coba ulang posting jam yang masih 'pending'
    for (const p of q.all("SELECT hour FROM ledger_hours WHERE status='pending' ORDER BY hour LIMIT 5")) {
      if (!done.some((d) => d?.hour === p.hour)) done.push(await runHour(p.hour, depsIn));
    }
  } catch (e) {
    console.warn('[credit]', e.message);
  } finally { running = false; }
  return done;
}

export function startCreditScheduler() {
  if (!config.ghostToken) { console.log('[credit] nonaktif — GHOST_TOKEN belum diisi'); return; }
  setInterval(() => tick().catch((e) => console.warn('[credit]', e.message)), 60_000);
  setTimeout(() => tick().catch(() => {}), 15_000);
  console.log(`[credit] aktif: tiap jam menit ke-${config.creditMinute} untuk jam sebelumnya`);
}
