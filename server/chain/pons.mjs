// Pons V2 (launchpad bonding curve) di Robinhood Chain — baca saja: statistik token, saldo, alamat sistem Pons.
// $GHOST diluncurkan sekali lewat Pons dengan creatorFeeRecipient = dompet fee HD milik server (indeks 0).
import { Contract, Interface, ZeroAddress, getAddress, isAddress, formatUnits } from 'ethers';
import { chainConfig } from './config.mjs';
import { provider } from './rpc.mjs';
import { ethUsd } from './prices.mjs';
import { FACTORY_ABI, CURVE_ABI, ERC20_ABI } from './abi.mjs';

const curveIface = new Interface(CURVE_ABI);

function factory() {
  return new Contract(chainConfig().factory, FACTORY_ABI, provider());
}
function curve(addr) {
  return new Contract(addr, CURVE_ABI, provider());
}
function erc20(addr) {
  return new Contract(addr, ERC20_ABI, provider());
}

// Alamat "sistem" Pons yang memegang $GHOST tapi bukan pemegang sungguhan → dikecualikan dari Ghost Credit.
// → [{ address, label }] (huruf kecil). Dibaca on-chain dari factory; yang gagal dibaca dilewati.
export async function ponsSystemAddresses(token) {
  const cfg = chainConfig();
  const f = factory();
  const out = [
    { address: cfg.factory, label: 'Pons launch factory' },
    { address: cfg.feeEscrow, label: 'Pons fee escrow' },
  ];
  try {
    const info = await f.getLaunchedToken(token);
    if (info.exists) out.push({ address: info.curve, label: 'Pons bonding curve' });
  } catch { /* token belum terbaca */ }
  for (const [fn, label] of [['poolManager', 'Uniswap v4 PoolManager'], ['positionManager', 'Uniswap v4 PositionManager'],
    ['locker', 'Pons LP locker'], ['buybackVault', 'Pons buyback vault'], ['graduationExecutor', 'Pons graduation executor'],
    ['memeHook', 'Pons pool hook'], ['launchDeployer', 'Pons launch deployer']]) {
    try { const a = await f[fn](); if (a && a !== ZeroAddress) out.push({ address: a, label }); } catch { /* lewati */ }
  }
  return out.map((x) => ({ address: x.address.toLowerCase(), label: x.label }));
}

// Harga dari DexScreener (token sudah graduasi / pasangan bukan ETH). null kalau tidak ada.
async function dariDexScreener(token) {
  try {
    const res = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${token}`, {
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return null;
    const j = await res.json();
    const pasangan = (j?.pairs || []).filter(
      (x) => x.chainId === 'robinhood' && x.baseToken?.address?.toLowerCase() === token.toLowerCase() && x.priceUsd
    );
    pasangan.sort((a, b) => Number(b.liquidity?.usd || 0) - Number(a.liquidity?.usd || 0));
    return pasangan[0] || null;
  } catch {
    return null;
  }
}

// { priceEth, priceUsd, marketCapUsd, graduated, holders } (+ info tambahan: source, blockNumber, dll)
// Angka null = tidak tersedia; tidak pernah dikarang.
export async function tokenStats(token) {
  if (!isAddress(token)) throw new Error('tokenStats: alamat tidak sah');
  const cfg = chainConfig();
  const p = provider();
  const hasil = {
    token: getAddress(token),
    priceEth: null,
    priceUsd: null,
    marketCapUsd: null,
    marketCapEth: null,
    graduated: null,
    holders: null, // butuh indexer (Blockscout diblokir dari server) → tidak diisi
    curve: null,
    pairToken: null,
    progress: null, // ETH nyata di kurva ÷ ambang graduasi (0..1)
    source: null,
    blockNumber: null,
    updatedAt: new Date().toISOString(),
  };

  const info = await factory().getLaunchedToken(token);
  if (!info.exists) {
    hasil.source = 'not_pons';
    return hasil;
  }
  hasil.curve = getAddress(info.curve);
  hasil.pairToken = getAddress(info.pairToken);
  const native = info.pairToken.toLowerCase() === ZeroAddress;

  const c = curve(info.curve);
  const blockNumber = await p.getBlockNumber();
  hasil.blockNumber = blockNumber;
  const tag = { blockTag: blockNumber };
  const graduated = await c.graduated(tag);
  hasil.graduated = graduated;

  if (!graduated && native) {
    const [[qRes, tRes], supply, tracked, quoteFee, creatorTax, threshold, desimal] = await Promise.all([
      c.getReserves(tag),
      erc20(token).totalSupply(tag),
      c.trackedQuote(tag),
      c.quoteFeeBalance(tag),
      c.creatorTaxBalance(tag),
      c.graduationThreshold(tag),
      erc20(token).decimals(tag),
    ]);
    if (tRes > 0n) {
      // harga spot = cadangan kutipan (phantom + ETH nyata − fee) ÷ cadangan token
      const priceEth = Number(formatUnits(qRes, 18)) / Number(formatUnits(tRes, desimal));
      hasil.priceEth = priceEth;
      hasil.marketCapEth = priceEth * Number(formatUnits(supply, desimal));
      hasil.source = 'curve';
      const nyata = tracked - quoteFee - creatorTax;
      if (threshold > 0n) hasil.progress = Math.min(1, Number(nyata) / Number(threshold));
      try {
        const usd = await ethUsd();
        hasil.priceUsd = priceEth * usd;
        hasil.marketCapUsd = hasil.marketCapEth * usd;
      } catch {
        /* harga ETH tidak tersedia → kolom USD tetap null */
      }
    }
    return hasil;
  }

  // Sudah graduasi (atau pasangan bukan ETH): pakai DexScreener bila ada.
  const ds = await dariDexScreener(token);
  if (ds) {
    hasil.source = 'dexscreener';
    hasil.priceUsd = Number(ds.priceUsd) || null;
    hasil.marketCapUsd = Number(ds.marketCap ?? ds.fdv) || null;
    if (ds.quoteToken?.address?.toLowerCase() === cfg.weth.toLowerCase()) {
      hasil.priceEth = Number(ds.priceNative) || null;
    } else if (hasil.priceUsd) {
      try {
        hasil.priceEth = hasil.priceUsd / (await ethUsd());
      } catch {
        /* biarkan null */
      }
    }
    if (hasil.priceEth && hasil.marketCapUsd && !hasil.marketCapEth && hasil.priceUsd) {
      hasil.marketCapEth = hasil.marketCapUsd * (hasil.priceEth / hasil.priceUsd);
    }
  } else {
    hasil.source = null;
  }
  return hasil;
}

// bigint — saldo mentah ERC-20
export async function erc20Balance(token, wallet) {
  return erc20(token).balanceOf(wallet);
}

export { curveIface };
