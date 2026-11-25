// Harga ETH/USD: Coinbase spot → cadangan DexScreener (WETH/USDG di Robinhood Chain,
// lalu WETH mainnet Ethereum). Cache 60 detik. Tidak pernah mengarang angka.
import { chainConfig } from './config.mjs';

const CACHE_MS = 60_000;
const BASI_MAKS_MS = 10 * 60_000; // kalau semua sumber gagal, harga ≤10 menit masih boleh dipakai

let cache = null; // { harga, waktu, sumber }
let sedangAmbil = null;

async function ambilJson(url) {
  const res = await fetch(url, {
    headers: { accept: 'application/json', 'user-agent': 'ghostkey-server/1.0' },
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${url}`);
  return res.json();
}

function wajar(x) {
  return Number.isFinite(x) && x > 10 && x < 1_000_000;
}

async function dariCoinbase() {
  const j = await ambilJson('https://api.coinbase.com/v2/prices/ETH-USD/spot');
  const x = Number(j?.data?.amount);
  if (!wajar(x)) throw new Error('coinbase: angka tidak wajar');
  return x;
}

// Ambil pasangan WETH dengan kutipan stablecoin ASLI (alamat persis), likuiditas terbesar.
async function dariDexScreener() {
  const { weth, usdg } = chainConfig();
  const j = await ambilJson(`https://api.dexscreener.com/latest/dex/tokens/${weth}`);
  const pasangan = (j?.pairs || []).filter(
    (p) =>
      p.chainId === 'robinhood' &&
      p.baseToken?.address?.toLowerCase() === weth.toLowerCase() &&
      p.quoteToken?.address?.toLowerCase() === usdg.toLowerCase() &&
      Number(p.liquidity?.usd) > 50_000
  );
  pasangan.sort((a, b) => Number(b.liquidity.usd) - Number(a.liquidity.usd));
  const x = Number(pasangan[0]?.priceUsd);
  if (wajar(x)) return x;
  // cadangan kedua: WETH di Ethereum mainnet melawan USDC/USDT
  const STABIL = ['0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48', '0xdac17f958d2ee523a2206206994597c13d831ec7'];
  const j2 = await ambilJson('https://api.dexscreener.com/latest/dex/tokens/0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2');
  const p2 = (j2?.pairs || []).filter(
    (p) => p.chainId === 'ethereum' && STABIL.includes(p.quoteToken?.address?.toLowerCase()) && Number(p.liquidity?.usd) > 1_000_000
  );
  p2.sort((a, b) => Number(b.liquidity.usd) - Number(a.liquidity.usd));
  const y = Number(p2[0]?.priceUsd);
  if (!wajar(y)) throw new Error('dexscreener: tidak ada pasangan WETH/stable yang wajar');
  return y;
}

async function segarkan() {
  let harga = null;
  let sumber = null;
  try {
    harga = await dariCoinbase();
    sumber = 'coinbase';
  } catch {
    try {
      harga = await dariDexScreener();
      sumber = 'dexscreener';
    } catch {
      /* lanjut ke cache basi di bawah */
    }
  }
  if (harga != null) {
    cache = { harga, waktu: Date.now(), sumber };
    return harga;
  }
  if (cache && Date.now() - cache.waktu < BASI_MAKS_MS) return cache.harga;
  throw new Error('eth_usd_unavailable');
}

// number — USD per 1 ETH
export async function ethUsd() {
  if (cache && Date.now() - cache.waktu < CACHE_MS) return cache.harga;
  if (!sedangAmbil) sedangAmbil = segarkan().finally(() => (sedangAmbil = null));
  return sedangAmbil;
}

// Info tambahan untuk diagnosa/tes (sumber terakhir & umur cache).
export function ethUsdInfo() {
  return cache ? { harga: cache.harga, sumber: cache.sumber, umurMs: Date.now() - cache.waktu } : null;
}

// Konversi wei → mikro-dolar (bigint) memakai harga number, tanpa pecahan float pada jumlah.
export function weiToUsdMicro(wei, hargaEthUsd) {
  const hargaMikro = BigInt(Math.round(hargaEthUsd * 1_000_000));
  return (BigInt(wei) * hargaMikro) / 10n ** 18n;
}
