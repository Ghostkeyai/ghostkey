// Konfigurasi GHOSTKEY — semua nilai bisa ditimpa lewat berkas .env di akar proyek (atau variabel lingkungan).
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

// Baca .env sederhana (KUNCI=nilai), tanpa pustaka tambahan. Variabel lingkungan yang sudah ada menang.
const envPath = process.env.GHOSTKEY_ENV_FILE || join(ROOT, '.env');
if (existsSync(envPath)) {
  for (const line of readFileSync(envPath, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=(.*)$/);
    if (!m || process.env[m[1]] !== undefined) continue;
    // Komentar: nilai yang diawali '#', atau ' # …' setelah spasi, diabaikan
    const v = m[2].trim().startsWith('#') ? '' : m[2].replace(/\s+#.*$/, '').trim();
    process.env[m[1]] = v.replace(/^["']|["']$/g, '');
  }
}

// Modul chain/ membaca TREASURY; samakan dengan TREASURY_ADDRESS
if (process.env.TREASURY_ADDRESS && !process.env.TREASURY) process.env.TREASURY = process.env.TREASURY_ADDRESS;

const env = (k, d) => (process.env[k] ?? d);
const num = (k, d) => Number(env(k, d));
const addr = (k) => {
  const v = String(env(k, '')).trim();
  return /^0x[0-9a-fA-F]{40}$/.test(v) ? v : '';
};
const addrList = (k) => String(env(k, '')).split(',').map((s) => s.trim()).filter((s) => /^0x[0-9a-fA-F]{40}$/.test(s));

const ghostToken = addr('GHOST_TOKEN');
const port = num('PORT', 4877);

export const config = {
  port,
  host: env('HOST', '0.0.0.0'),
  dataDir: env('GHOSTKEY_DATA_DIR', join(ROOT, 'data')),     // DB + data/ledger/hour-<n>.json
  publicUrl: env('PUBLIC_URL', `http://localhost:${port}`),
  chainId: 4663,
  blockscout: 'https://robinhoodchain.blockscout.com',

  // OpenRouter: satu kunci bersama milik GHOSTKEY. Kosong → MODE TIRUAN (jawaban palsu berlabel), untuk uji lokal.
  openrouterKey: env('OPENROUTER_API_KEY', ''),
  appTitle: 'GHOSTKEY',

  // Dompet & kontrak
  treasury: addr('TREASURY_ADDRESS'),       // tujuan top-up + pool Ghost Credit (25% fee)
  ownerWallet: addr('OWNER_WALLET'),        // 75% fee $GHOST
  ghostToken,                               // CA $GHOST (kosong sebelum launch)
  ledgerAddress: addr('LEDGER_ADDRESS'),    // kontrak GhostLedger (kosong sebelum deploy)
  teamWallets: addrList('TEAM_WALLETS'),    // dikecualikan dari Ghost Credit, tampil di /proof
  feeWalletOverride: addr('FEE_WALLET'),    // opsional: alamat dompet fee untuk ditampilkan bila mnemonic tidak ada di server ini

  // Ghost Credit (bagian pemegang)
  holderMinTokens: num('HOLDER_MIN_TOKENS', 100000),
  holderShareBps: num('HOLDER_SHARE_BPS', 2500),
  creditMinute: num('CREDIT_MINUTE', 5),        // menit ke-5 tiap jam → proses jam sebelumnya
  harvestMinute: num('HARVEST_MINUTE', 50),     // panen di menit ke-50 supaya masuk pool jam yang sama
  harvestMinWei: BigInt(env('HARVEST_MIN_WEI', '2000000000000000')), // 0,002 ETH
  tokenDeployBlock: num('GHOST_TOKEN_BLOCK', 0), // opsional: blok deploy token (mempercepat pencarian pemegang)

  // Isi saldo: TANPA biaya (0%) — kredit = USD yang dibayar
  minDepositUsd: num('MIN_DEPOSIT_USD', 5),
  maxDepositUsd: num('MAX_DEPOSIT_USD', 2000),

  // Pesan gratis
  freeMessages: num('FREE_MESSAGES', 10),          // per browser (clientId), seumur hidup
  freeApiCalls: num('FREE_API_CALLS', 10),         // per akun baru lewat /v1
  freePerIpDay: num('FREE_PER_IP_DAY', 30),
  freeDailyUsd: num('FREE_DAILY_USD', 2),          // pagu biaya gratis seluruh situs per hari
  freeMaxOutPerM: num('FREE_MAX_OUT_PER_M', 1),    // model gratis: harga output ≤ $1 per 1 juta token
  freeMaxTokens: num('FREE_MAX_TOKENS', 1200),

  // Keuntungan pemegang $GHOST (≥ HOLDER_MIN_TOKENS, dicek on-chain, disimpan 5 menit)
  holderFreePerDay: num('HOLDER_FREE_PER_DAY', 30),     // pesan gratis web per hari + panggilan API gratis per hari (UTC)
  holderFreeDailyUsd: num('HOLDER_FREE_DAILY_USD', 5),  // pagu biaya gratis pemegang seluruh situs per hari (terpisah dari umum)
  apiRpm: num('API_RPM', 120),
  holderApiRpm: num('HOLDER_API_RPM', 600),

  // Tautan publik
  links: {
    x: env('LINK_X', ''),   // kosong sampai akun X benar-benar dibuat (jangan tautkan handle yang belum dimiliki)
    telegram: env('LINK_TELEGRAM', ''),
    github: env('LINK_GITHUB', ''),
    pons: ghostToken ? `https://www.ponsfamily.com/launchpad/${ghostToken.toLowerCase()}` : '',
  },

  // Lain-lain
  cookieSecure: env('COOKIE_SECURE', '0') === '1',
  adminKey: env('ADMIN_KEY', ''),
  disableSchedulers: env('GHOSTKEY_NO_SCHEDULERS', '0') === '1',
};

// URL kode sumber di GitHub (null kalau LINK_GITHUB belum diisi)
export function codeUrl(path) {
  const g = config.links.github.replace(/\/+$/, '');
  return g ? `${g}/blob/main/${path}` : null;
}

// Uang disimpan sebagai bilangan bulat mikro-dolar (aman sampai ±9 miliar USD sebagai Number).
export const usdToMicro = (usd) => Math.round(Number(usd) * 1e6);
export const microToUsd = (m) => Math.round(Number(m)) / 1e6;
