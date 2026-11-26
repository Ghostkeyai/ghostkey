// Saldo creator fee $GHOST yang bisa dilihat publik (/api/fees), dibaca langsung on-chain + dari tabel harvests.
//   1. di curve  : fee yang masih menumpuk di bonding curve Pons (pajak kreator + jatah kreator dari fee dasar)
//   2. di escrow : fee yang sudah dipindah Pons ke FeeEscrow atas nama dompet fee GHOSTKEY, siap diklaim
//   3. diklaim   : total panen yang sudah dibagi 25% pemegang / 75% tim, dengan hash tx
// Pratinjau pembagian = (curve + escrow) × HOLDER_SHARE_BPS. Angka on-chain yang gagal dibaca → null, tidak dikarang.
import { Contract } from 'ethers';
import { config } from './config.mjs';
import { q } from './db.mjs';
import { feeWalletAddress } from './public.mjs';

const TTL = 60_000;
let cache = null, inflight = null;
let curveAddr = null;

const sumWei = (col) => q.all(`SELECT ${col} v FROM harvests`).reduce((s, r) => s + BigInt(r.v || '0'), 0n);
const split = (wei) => {
  const holders = (wei * BigInt(config.holderShareBps)) / 10000n;
  return { holdersWei: holders.toString(), teamWei: (wei - holders).toString() };
};
const usdOf = (wei, px) => (px == null || wei == null ? null : Number((BigInt(wei) * BigInt(Math.round(px * 1e6))) / 10n ** 18n) / 1e6);

function claimedTotals() {
  const n = q.one('SELECT COUNT(*) n, COALESCE(SUM(usd_micro),0) u, COALESCE(SUM(holder_micro),0) h, COALESCE(SUM(owner_micro),0) o FROM harvests');
  const last = q.one('SELECT claim_tx, created_at, txs FROM harvests ORDER BY id DESC LIMIT 1');
  return {
    count: n.n,
    wei: sumWei('claimed_wei').toString(),
    holdersWei: sumWei('holder_wei').toString(),
    teamWei: sumWei('owner_wei').toString(),
    usd: n.u / 1e6, holdersUsd: n.h / 1e6, teamUsd: n.o / 1e6,     // nilai USD saat masing-masing klaim
    last: last ? { at: last.created_at, claimTx: last.claim_tx, txs: JSON.parse(last.txs || '[]') } : null,
  };
}

async function readChain() {
  const { provider } = await import('./chain/rpc.mjs');
  const { chainConfig } = await import('./chain/config.mjs');
  const { FACTORY_ABI, CURVE_ABI } = await import('./chain/abi.mjs');
  const { escrowBalance } = await import('./chain/fees.mjs');
  const p = provider();
  const cfg = chainConfig();
  if (!curveAddr) curveAddr = (await new Contract(cfg.factory, FACTORY_ABI, p).getLaunchedToken(config.ghostToken)).curve;
  const c = new Contract(curveAddr, CURVE_ABI, p);
  const fee = await feeWalletAddress();
  const [tax, quoteFee, buyback, graduated, protoBps, escrow] = await Promise.all([
    c.creatorTaxBalance(), c.quoteFeeBalance(), c.buybackQuoteBalance().catch(() => 0n), c.graduated().catch(() => false),
    c.protocolFeeShareBps().catch(() => 3000n), fee ? escrowBalance(fee) : Promise.resolve(null),
  ]);
  // jatah kreator di curve = fee dasar − bagian protokol − sisihan buyback + seluruh pajak kreator (sama dengan _sweepFees)
  const creatorBucket = BigInt(quoteFee) - (BigInt(quoteFee) * BigInt(protoBps)) / 10000n;
  const inCurve = BigInt(tax) + (creatorBucket > BigInt(buyback) ? creatorBucket - BigInt(buyback) : 0n);
  return { curve: curveAddr, feeWallet: fee, inCurve, inEscrow: escrow == null ? null : BigInt(escrow), graduated: !!graduated,
    taxWei: BigInt(tax).toString(), baseFeeShareWei: (inCurve - BigInt(tax)).toString() };
}

async function build() {
  const out = { token: config.ghostToken || null, holderShareBps: config.holderShareBps, harvestMinute: config.harvestMinute, creditMinute: config.creditMinute,
    claimed: claimedTotals(), pending: null, ethUsd: null, updatedAt: Date.now() };
  if (!config.ghostToken) return out;
  let px = null;
  try { const { ethUsd } = await import('./chain/prices.mjs'); px = await ethUsd(); } catch {}
  out.ethUsd = px;
  try {
    const ch = await readChain();
    const total = ch.inCurve + (ch.inEscrow ?? 0n);
    out.curve = ch.curve; out.feeWallet = ch.feeWallet; out.graduated = ch.graduated;
    out.pending = {
      inCurveWei: ch.inCurve.toString(), inEscrowWei: ch.inEscrow == null ? null : ch.inEscrow.toString(),
      taxWei: ch.taxWei, baseFeeShareWei: ch.baseFeeShareWei,
      totalWei: total.toString(), totalUsd: usdOf(total, px),
      ...split(total),
    };
    out.pending.holdersUsd = usdOf(out.pending.holdersWei, px);
    out.pending.teamUsd = usdOf(out.pending.teamWei, px);
  } catch (e) { out.error = 'chain_unavailable'; }
  return out;
}

export async function feesData() {
  if (cache && Date.now() - cache.updatedAt < TTL) return cache;
  if (!inflight) inflight = build().then((v) => (cache = v)).finally(() => (inflight = null));
  return inflight;
}
// panggil sesudah panen supaya angka "diklaim" langsung segar
export const invalidateFees = () => { cache = null; };
