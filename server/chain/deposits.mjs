// Verifikasi setoran ke treasury: ETH biasa atau USDG (ERC-20, 6 desimal).
// Pencegahan pakai-ulang txHash adalah tugas server (simpan txHash unik di DB).
import { getAddress, Interface, isAddress } from 'ethers';
import { chainConfig } from './config.mjs';
import { provider } from './rpc.mjs';
import { ethUsd, weiToUsdMicro } from './prices.mjs';
import { ERC20_ABI } from './abi.mjs';

const erc20 = new Interface(ERC20_ABI);
const TOPIC_TRANSFER = erc20.getEvent('Transfer').topicHash;

const gagal = (reason, extra = {}) => ({ ok: false, reason, ...extra });

// { txHash, from, treasury } → { ok:true, asset, amountRaw, usdMicro, blockNumber, confirmations } | { ok:false, reason }
export async function verifyDeposit({ txHash, from, treasury }) {
  const cfg = chainConfig();
  if (!/^0x[0-9a-fA-F]{64}$/.test(String(txHash || ''))) return gagal('not_found');
  if (!isAddress(from) || !isAddress(treasury)) throw new Error('verifyDeposit: alamat from/treasury tidak sah');
  const dari = from.toLowerCase();
  const ke = treasury.toLowerCase();
  const usdg = cfg.usdg.toLowerCase();

  const p = provider();
  const tx = await p.getTransaction(txHash);
  if (!tx) return gagal('not_found');
  const receipt = await p.getTransactionReceipt(txHash);
  if (!receipt || receipt.blockNumber == null) return gagal('pending');
  if (receipt.status !== 1) return gagal('failed');

  let asset = null;
  let amountRaw = 0n;

  if (tx.to && tx.to.toLowerCase() === ke && tx.value > 0n) {
    // --- ETH langsung ke treasury ---
    if (tx.from.toLowerCase() !== dari) return gagal('wrong_sender');
    asset = 'ETH';
    amountRaw = tx.value;
  } else {
    // --- USDG: cari log Transfer(from → treasury) milik kontrak USDG di receipt ---
    const keTreasury = receipt.logs.filter(
      (l) =>
        l.address.toLowerCase() === usdg &&
        l.topics.length === 3 &&
        l.topics[0] === TOPIC_TRANSFER &&
        ('0x' + l.topics[2].slice(26)).toLowerCase() === ke
    );
    if (keTreasury.length === 0) return gagal('wrong_recipient');
    const milikPengirim = keTreasury.filter((l) => ('0x' + l.topics[1].slice(26)).toLowerCase() === dari);
    if (milikPengirim.length === 0) return gagal('wrong_sender');
    asset = 'USDG';
    amountRaw = milikPengirim.reduce((s, l) => s + BigInt(l.data), 0n);
    if (amountRaw === 0n) return gagal('wrong_recipient');
  }

  const terbaru = await p.getBlockNumber();
  const confirmations = Math.max(0, terbaru - receipt.blockNumber + 1);
  if (confirmations < cfg.minConfirmations) return gagal('too_few_confirmations', { confirmations });

  // USDG 6 desimal → 1 unit mentah = 1 mikro-dolar (USDG dianggap $1).
  let usdMicro;
  if (asset === 'USDG') {
    usdMicro = amountRaw * 10n ** 6n / 10n ** BigInt(cfg.usdgDecimals);
  } else {
    usdMicro = weiToUsdMicro(amountRaw, await ethUsd());
  }

  return {
    ok: true,
    asset,
    amountRaw,
    usdMicro,
    blockNumber: receipt.blockNumber,
    confirmations,
    from: getAddress(from),
    to: getAddress(treasury),
  };
}
