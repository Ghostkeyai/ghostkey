// Panen creator fee $GHOST dari Pons FeeEscrow tiap jam (dompet fee indeks 0), lalu bagi:
//   HOLDER_SHARE_BPS (25%) → TREASURY = pool Ghost Credit jam itu (nilai USD saat klaim)
//   sisanya (75%)          → OWNER_WALLET
// Semua hash tx dicatat di tabel harvests. Pool jam n = jumlah bagian pemegang yang diklaim selama jam n.
// Dijalankan di menit ke-HARVEST_MINUTE (bawaan 50) supaya selesai sebelum mesin kredit jalan di menit ke-5.
import { config, usdToMicro } from './config.mjs';
import { q, now } from './db.mjs';
import { hourOf } from './credit.mjs';

let running = false;
export const isHarvesting = () => running;

export function harvesterReady() {
  const missing = [];
  if (!process.env.GHOST_MNEMONIC) missing.push('GHOST_MNEMONIC');
  if (!config.ownerWallet) missing.push('OWNER_WALLET');
  if (!config.treasury) missing.push('TREASURY_ADDRESS');
  if (!config.ghostToken) missing.push('GHOST_TOKEN');
  return missing;
}

export const splitPlan = () => [
  { to: config.ownerWallet, bps: 10000 - config.holderShareBps },
  { to: config.treasury, bps: config.holderShareBps },
];

async function defaultDeps() {
  const { escrowBalance, claimAndSplit } = await import('./chain/fees.mjs');
  const { feeWallet } = await import('./chain/wallets.mjs');
  const { ethUsd } = await import('./chain/prices.mjs');
  return { escrowBalance, claimAndSplit, ethUsd, feeAddress: feeWallet(0).address, now: Date.now };
}

/**
 * Satu panen. deps opsional (tes): { escrowBalance, claimAndSplit, ethUsd, feeAddress, now }.
 * → null (tidak ada/terlalu kecil) | { hour, claimedWei, usdMicro, holderMicro, ownerMicro, txs }
 */
export async function harvestOnce(depsIn, opts = {}) {
  if (running) return null;
  running = true;
  try {
    const d = depsIn || (await defaultDeps());
    const startedAt = (d.now || Date.now)();
    const pending = await d.escrowBalance(d.feeAddress);
    // Panen terjadwal menunggu minimal harvestMinWei; tarik manual (opts.minWei) boleh lebih kecil
    const min = opts.minWei !== undefined ? BigInt(opts.minWei) : config.harvestMinWei;
    if (BigInt(pending) < min || BigInt(pending) === 0n) return null;

    let r;
    try { r = await d.claimAndSplit({ index: 0, splits: splitPlan() }); }
    catch (e) {
      // Gagal di tengah: simpan jejak tx yang sudah terkirim untuk diurus manual, jangan kirim ulang otomatis
      q.run('INSERT INTO kv(k,v) VALUES(?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v', `harvest_partial:${startedAt}`,
            JSON.stringify({ error: e.message, partial: e.partial ?? null }, (k, v) => (typeof v === 'bigint' ? v.toString() : v)));
      throw e;
    }
    if (r.skipped || !BigInt(r.claimedWei || 0)) return null;

    const price = await d.ethUsd();
    const claimedWei = BigInt(r.claimedWei);
    const sumTo = (addr) => r.sent.filter((x) => x.to.toLowerCase() === addr.toLowerCase()).reduce((s, x) => s + BigInt(x.wei), 0n);
    const holderWei = sumTo(config.treasury);       // bagian resmi + sisa pembulatan ke treasury
    const ownerWei = sumTo(config.ownerWallet);
    const toMicro = (w) => usdToMicro((Number(w) / 1e18) * price);
    const out = {
      hour: hourOf(startedAt),
      claimedWei: claimedWei.toString(),
      ethUsd: price,
      usdMicro: toMicro(claimedWei),
      holderWei: holderWei.toString(), holderMicro: toMicro(holderWei),
      ownerWei: ownerWei.toString(), ownerMicro: toMicro(ownerWei),
      claimTx: r.txs?.find((t) => t.kind === 'claim')?.txHash ?? null,
      txs: [
        ...(r.txs || []).filter((t) => t.kind === 'claim' || t.kind === 'gas_topup').map((t) => ({ kind: t.kind, txHash: t.txHash })),
        ...r.sent.map((x) => ({ kind: x.to.toLowerCase() === config.treasury.toLowerCase() ? 'to_treasury' : 'to_owner',
          txHash: x.txHash, to: x.to, wei: String(x.wei) })),
      ],
    };
    q.run(`INSERT INTO harvests(hour,claimed_wei,eth_usd,usd_micro,holder_wei,holder_micro,owner_wei,owner_micro,claim_tx,txs,created_at)
           VALUES(?,?,?,?,?,?,?,?,?,?,?)`,
          out.hour, out.claimedWei, price, out.usdMicro, out.holderWei, out.holderMicro, out.ownerWei, out.ownerMicro,
          out.claimTx, JSON.stringify(out.txs), now());
    console.log('[panen]', JSON.stringify({ hour: out.hour, usd: out.usdMicro / 1e6, holderUsd: out.holderMicro / 1e6 }));
    import('./fees-live.mjs').then((m) => m.invalidateFees()).catch(() => {});   // angka /api/fees langsung segar
    return out;
  } finally { running = false; }
}

export function recentHarvests(limit = 24) {
  return q.all('SELECT * FROM harvests ORDER BY id DESC LIMIT ?', limit).map((h) => ({
    hour: h.hour, at: h.created_at, claimedWei: h.claimed_wei, ethUsd: h.eth_usd,
    usd: h.usd_micro / 1e6, holderUsd: h.holder_micro / 1e6, ownerUsd: h.owner_micro / 1e6,
    claimTx: h.claim_tx, txs: JSON.parse(h.txs || '[]'),
  }));
}

export function startHarvester() {
  const missing = harvesterReady();
  if (missing.length) { console.log('[panen] nonaktif — belum ada:', missing.join(', ')); return; }
  let lastHour = null;
  setInterval(() => {
    const d = new Date();
    const h = hourOf(d.getTime());
    if (d.getUTCMinutes() >= config.harvestMinute && lastHour !== h) {
      lastHour = h;
      harvestOnce().catch((e) => console.warn('[panen]', e.message));
    }
  }, 30_000);
  console.log(`[panen] aktif: tiap jam menit ke-${config.harvestMinute}`);
}
