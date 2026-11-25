// Fee kreator Pons: baca saldo di FeeEscrow, klaim, lalu bagi ke penerima.
// Prinsip keamanan claimAndSplit:
//   - tidak jalan tanpa GHOST_MNEMONIC;
//   - satu proses klaim per index pada satu waktu (kunci di memori);
//   - jumlah dibagi dihitung dari ETH yang BENAR-BENAR masuk (selisih saldo sekitar blok klaim,
//     dibatasi juga oleh event Claimed), dikurangi cadangan gas untuk transfer;
//   - tiap tx ditandatangani sekali (hash tetap); siaran ulang ke titik RPC lain memakai raw yang sama,
//     jadi tidak mungkin terkirim dua kali; tiap tx ditunggu receipt-nya sebelum lanjut;
//   - kalau satu langkah gagal, proses BERHENTI (tidak ada coba-kirim ulang) dan error membawa
//     err.partial berisi semua tx yang sudah terkirim.
import { Contract, Interface, getAddress, isAddress, keccak256, ZeroAddress } from 'ethers';
import { chainConfig, CHAIN_ID } from './config.mjs';
import { provider, rpcCall } from './rpc.mjs';
import { feeWallet, gasWallet } from './wallets.mjs';
import { FEE_ESCROW_ABI } from './abi.mjs';

const escrowIface = new Interface(FEE_ESCROW_ABI);
const DATA_CLAIM = escrowIface.encodeFunctionData('claim()', []);
const TOPIC_CLAIMED = escrowIface.getEvent('Claimed').topicHash;

const tidur = (ms) => new Promise((r) => setTimeout(r, ms));

// bigint wei yang bisa diklaim `address` dari FeeEscrow
export async function escrowBalance(address) {
  const escrow = new Contract(chainConfig().feeEscrow, FEE_ESCROW_ABI, provider());
  return escrow.balanceOf(address);
}

// ---------------------------------------------------------------------------
// Aritmetika murni (diuji unit): pembagian dari jumlah yang diterima.
// claimedWei − transferCostWei = distributable; tiap bagian = floor(distributable × bps / 10000);
// sisa pembulatan + bagian tanpa pemilik = remainder (ke TREASURY bila diset).
// ---------------------------------------------------------------------------
export function validateSplits(splits) {
  if (!Array.isArray(splits)) throw new Error('splits harus array');
  let total = 0;
  const hasil = splits.map((s, i) => {
    if (!s || !isAddress(s.to) || s.to.toLowerCase() === ZeroAddress) throw new Error(`splits[${i}].to tidak sah`);
    const bps = Number(s.bps);
    if (!Number.isInteger(bps) || bps < 0 || bps > 10000) throw new Error(`splits[${i}].bps tidak sah`);
    total += bps;
    return { to: getAddress(s.to), bps };
  });
  if (total > 10000) throw new Error(`jumlah bps ${total} > 10000`);
  return hasil;
}

export function planSplit({ claimedWei, transferCostWei, splits }) {
  const bersih = validateSplits(splits);
  const claimed = BigInt(claimedWei);
  const biaya = BigInt(transferCostWei);
  if (claimed <= 0n) return { distributableWei: 0n, parts: bersih.map((s) => ({ ...s, wei: 0n })), remainderWei: 0n, reserveWei: 0n };
  if (claimed <= biaya) {
    // terlalu kecil untuk dibagi: semua tetap di dompet fee (jadi cadangan gas berikutnya)
    return { distributableWei: 0n, parts: bersih.map((s) => ({ ...s, wei: 0n })), remainderWei: 0n, reserveWei: claimed };
  }
  const distributable = claimed - biaya;
  const parts = bersih.map((s) => ({ ...s, wei: (distributable * BigInt(s.bps)) / 10000n }));
  const terbagi = parts.reduce((a, p) => a + p.wei, 0n);
  return { distributableWei: distributable, parts, remainderWei: distributable - terbagi, reserveWei: biaya };
}

// ---------------------------------------------------------------------------
// Adaptor chain (produksi). Tes memakai adaptor tiruan dengan bentuk yang sama.
// ---------------------------------------------------------------------------
function adaptorProduksi(index) {
  const cfg = chainConfig();
  const fee = feeWallet(index); // melempar kalau GHOST_MNEMONIC kosong
  const gas = gasWallet();
  const p = provider();
  const signers = { [fee.address.toLowerCase()]: fee.signer, [gas.address.toLowerCase()]: gas.signer };
  return {
    feeAddress: fee.address,
    gasAddress: gas.address,
    escrow: getAddress(cfg.feeEscrow),
    treasury: cfg.treasury && isAddress(cfg.treasury) ? getAddress(cfg.treasury) : null,
    balance: (addr, blockTag = 'latest') => p.getBalance(addr, blockTag),
    escrowBalance: (addr) => escrowBalance(addr),
    estimateGas: (req) => p.estimateGas(req),
    async feeData() {
      const fd = await p.getFeeData();
      const maxPriorityFeePerGas = fd.maxPriorityFeePerGas ?? 0n;
      const maxFeePerGas = fd.maxFeePerGas ?? (fd.gasPrice ?? 0n) * 2n;
      return { maxFeePerGas, maxPriorityFeePerGas };
    },
    nonce: (addr) => p.getTransactionCount(addr, 'pending'),
    // Tandatangani SEKALI, siarkan raw yang sama (hash tetap) → aman terhadap rotasi RPC.
    async send(fromAddr, req) {
      const signer = signers[fromAddr.toLowerCase()];
      if (!signer) throw new Error('signer tidak dikenal');
      const raw = await signer.signTransaction({
        type: 2,
        chainId: CHAIN_ID,
        to: req.to,
        value: req.value ?? 0n,
        data: req.data ?? '0x',
        gasLimit: req.gasLimit,
        nonce: req.nonce,
        maxFeePerGas: req.maxFeePerGas,
        maxPriorityFeePerGas: req.maxPriorityFeePerGas,
      });
      const hash = keccak256(raw);
      try {
        await rpcCall('eth_sendRawTransaction', [raw]);
      } catch (e) {
        const m = String(e.message || '');
        if (/already known|known transaction|already imported/i.test(m)) return hash; // sudah tersiar
        if (/nonce too low/i.test(m)) {
          // mungkin siaran sebelumnya (lewat titik lain) sudah tertambang
          const ada = await p.getTransaction(hash).catch(() => null);
          if (ada) return hash;
        }
        e.txHash = hash;
        throw e;
      }
      return hash;
    },
    async waitReceipt(hash, batasMs = 180_000) {
      const mulai = Date.now();
      while (Date.now() - mulai < batasMs) {
        const r = await p.getTransactionReceipt(hash).catch(() => null);
        if (r && r.blockNumber != null) {
          return { status: r.status, blockNumber: r.blockNumber, gasUsed: r.gasUsed, gasPrice: r.gasPrice, logs: r.logs };
        }
        await tidur(1500);
      }
      const err = new Error(`receipt tidak muncul dalam ${batasMs / 1000} dtk: ${hash}`);
      err.txHash = hash;
      throw err;
    },
  };
}

const kunci = new Set(); // index yang sedang diproses

// { index, splits:[{to,bps}] } → { claimedWei, sent:[{to,bps,wei,txHash}], keptWei, txs:[{kind,txHash}], ... }
// Parameter kedua hanya untuk tes (adaptor tiruan); server cukup memanggil claimAndSplit({ index, splits }).
export async function claimAndSplit({ index, splits }, _adaptor) {
  if (!chainConfig().mnemonic.trim()) throw new Error('GHOST_MNEMONIC belum diisi — claimAndSplit ditolak');
  const bagian = validateSplits(splits || []);
  const k = String(index);
  if (kunci.has(k)) throw new Error(`claim untuk index ${k} sedang berjalan`);
  kunci.add(k);

  const hasil = {
    index: Number(index),
    feeWallet: null,
    claimedWei: 0n,
    sent: [],
    keptWei: 0n,
    keptInFeeWalletWei: 0n,
    gasTopUpWei: 0n,
    gasReserveWei: 0n,
    txs: [],
  };
  try {
    const a = _adaptor || adaptorProduksi(index);
    hasil.feeWallet = a.feeAddress;

    // 1) ada yang bisa diklaim?
    const diEscrow = await a.escrowBalance(a.feeAddress);
    if (diEscrow === 0n) return hasil;

    // 2) pastikan gas untuk claim (isi dari gasWallet hanya kalau kurang)
    let fd = await a.feeData();
    const gasClaim = ((await a.estimateGas({ from: a.feeAddress, to: a.escrow, data: DATA_CLAIM })) * 13n) / 10n;
    const biayaClaim = gasClaim * fd.maxFeePerGas;
    // terlalu kecil: klaim + transfer akan memakan sebagian besar hasil → lewati dulu
    const jumlahTransfer = BigInt(bagian.filter((s) => s.bps > 0).length + (a.treasury ? 1 : 0));
    if (diEscrow < biayaClaim * (5n + jumlahTransfer * 2n)) {
      hasil.skipped = 'too_small';
      hasil.escrowWei = diEscrow;
      return hasil;
    }
    const saldoFee = await a.balance(a.feeAddress);
    if (saldoFee < biayaClaim) {
      const isi = biayaClaim * 2n - saldoFee; // isi sampai 2× kebutuhan claim
      const gasIsi = ((await a.estimateGas({ from: a.gasAddress, to: a.feeAddress, value: isi })) * 12n) / 10n;
      const saldoGas = await a.balance(a.gasAddress);
      if (saldoGas < isi + gasIsi * fd.maxFeePerGas) throw new Error('gasWallet kekurangan saldo untuk isi gas');
      const hIsi = await a.send(a.gasAddress, {
        to: a.feeAddress,
        value: isi,
        gasLimit: gasIsi,
        nonce: await a.nonce(a.gasAddress),
        ...fd,
      });
      hasil.txs.push({ kind: 'gas_topup', txHash: hIsi });
      const rIsi = await a.waitReceipt(hIsi);
      if (rIsi.status !== 1) throw new Error(`tx isi gas gagal: ${hIsi}`);
      hasil.gasTopUpWei = isi;
      // tunggu sampai saldo terlihat (titik RPC bisa sedikit tertinggal)
      for (let i = 0; i < 15 && (await a.balance(a.feeAddress)) < biayaClaim; i++) await tidur(1000);
    }

    // 3) claim() — sekali saja
    let nonceFee = await a.nonce(a.feeAddress);
    const hClaim = await a.send(a.feeAddress, { to: a.escrow, data: DATA_CLAIM, value: 0n, gasLimit: gasClaim, nonce: nonceFee, ...fd });
    nonceFee += 1;
    hasil.txs.push({ kind: 'claim', txHash: hClaim });
    const rClaim = await a.waitReceipt(hClaim);
    if (rClaim.status !== 1) throw new Error(`tx claim gagal: ${hClaim}`);

    // 4) ETH yang benar-benar masuk: selisih saldo antara blok sebelum & blok klaim + gas yang dibayar,
    //    dibatasi jumlah di event Claimed (ambil yang lebih kecil).
    const [sebelum, sesudah] = await Promise.all([
      a.balance(a.feeAddress, rClaim.blockNumber - 1),
      a.balance(a.feeAddress, rClaim.blockNumber),
    ]);
    const gasDibayar = BigInt(rClaim.gasUsed) * BigInt(rClaim.gasPrice);
    let diterima = sesudah - sebelum + gasDibayar;
    const logClaimed = rClaim.logs.find(
      (l) =>
        l.address.toLowerCase() === a.escrow.toLowerCase() &&
        l.topics[0] === TOPIC_CLAIMED &&
        ('0x' + l.topics[1].slice(26)).toLowerCase() === a.feeAddress.toLowerCase()
    );
    if (logClaimed) {
      const dariEvent = BigInt(logClaimed.data);
      if (dariEvent < diterima) diterima = dariEvent;
    }
    if (diterima <= 0n) return hasil;
    hasil.claimedWei = diterima;

    // 5) rencanakan transfer; cadangan gas = perkiraan biaya semua transfer (dipotong dari hasil klaim)
    fd = await a.feeData();
    const tujuan = bagian.filter((s) => s.bps > 0).map((s) => s.to);
    if (a.treasury) tujuan.push(a.treasury);
    const gasPer = {};
    let biayaTransfer = 0n;
    for (const to of tujuan) {
      const g = ((await a.estimateGas({ from: a.feeAddress, to, value: 1n })) * 12n) / 10n;
      gasPer[to.toLowerCase()] = g;
      biayaTransfer += g * fd.maxFeePerGas;
    }
    const rencana = planSplit({ claimedWei: diterima, transferCostWei: biayaTransfer, splits: bagian });
    hasil.gasReserveWei = rencana.reserveWei;

    // 6) kirim bagian satu per satu, tunggu receipt tiap tx
    for (const part of rencana.parts) {
      if (part.wei === 0n) continue;
      const h = await a.send(a.feeAddress, {
        to: part.to,
        value: part.wei,
        gasLimit: gasPer[part.to.toLowerCase()],
        nonce: nonceFee,
        ...fd,
      });
      nonceFee += 1;
      hasil.txs.push({ kind: 'split', txHash: h });
      const r = await a.waitReceipt(h);
      if (r.status !== 1) throw new Error(`transfer ke ${part.to} gagal: ${h}`);
      hasil.sent.push({ to: part.to, bps: part.bps, wei: part.wei, txHash: h });
    }

    // 7) sisa → TREASURY (kalau diset); kalau tidak, tetap di dompet fee
    hasil.keptWei = rencana.remainderWei;
    if (rencana.remainderWei > 0n && a.treasury) {
      const h = await a.send(a.feeAddress, {
        to: a.treasury,
        value: rencana.remainderWei,
        gasLimit: gasPer[a.treasury.toLowerCase()],
        nonce: nonceFee,
        ...fd,
      });
      nonceFee += 1;
      hasil.txs.push({ kind: 'treasury', txHash: h });
      const r = await a.waitReceipt(h);
      if (r.status !== 1) throw new Error(`transfer sisa ke treasury gagal: ${h}`);
      hasil.sent.push({ to: a.treasury, bps: null, wei: rencana.remainderWei, txHash: h, treasury: true });
    } else {
      hasil.keptInFeeWalletWei = rencana.remainderWei;
    }
    // klaim yang terlalu kecil untuk dibagi tetap di dompet fee sebagai cadangan gas
    if (rencana.distributableWei === 0n) hasil.keptInFeeWalletWei = diterima;
    return hasil;
  } catch (e) {
    e.partial = hasil; // tx yang sudah terkirim — server WAJIB mencatatnya, jangan ulangi otomatis
    throw e;
  } finally {
    kunci.delete(k);
  }
}
