// Konfigurasi modul chain/ — semua nilai dari process.env, dengan nilai bawaan.
// Dibaca saat dipanggil (bukan saat import) supaya .env yang dimuat belakangan tetap terpakai.

function daftar(nilai, bawaan) {
  const s = (nilai ?? '').trim();
  if (!s) return bawaan;
  return s.split(',').map((x) => x.trim()).filter(Boolean);
}

export const CHAIN_ID = 4663;

export function chainConfig() {
  const env = process.env;
  return {
    chainId: CHAIN_ID,
    // titik RPC umum (eth_call, receipt, saldo, kirim tx) — urutan = prioritas
    rpcUrls: daftar(env.RPC_URLS, [
      'https://robinhood-rpc.publicnode.com',
      'https://robinhood.api.pocket.network',
      'https://robinhood.drpc.org',
      'https://robinhood.daybreak-rpc.network',
      'https://rpc.mainnet.chain.robinhood.com',
    ]),
    // titik khusus eth_getLogs (publicnode menolak riwayat tanpa token)
    logsRpcUrls: daftar(env.LOGS_RPC_URLS, [
      'https://robinhood.api.pocket.network',
      'https://robinhood.drpc.org',
    ]),
    factory: env.FACTORY || '0x7eD598BcEf8bd9Edd8C97A195C6d13f40801EC7e',
    feeEscrow: env.FEE_ESCROW || '0xd3AFEB2a57f70eF218Aa82451c51B2fb0416Ac9e',
    usdg: env.USDG || '0x5fc5360d0400a0fd4f2af552add042d716f1d168',
    usdgDecimals: 6, // dicek on-chain 23 Nov 2026: decimals()=6, symbol()=USDG, name()="Global Dollar"
    weth: env.WETH || '0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73', // hanya untuk cadangan harga DexScreener
    minConfirmations: Number(env.MIN_CONFIRMATIONS || 3),
    treasury: env.TREASURY || '',
    mnemonic: env.GHOST_MNEMONIC || '',
    cooldownMs: Number(env.RPC_COOLDOWN_MS || 90_000),
    minGapMs: Number(env.RPC_MIN_GAP_MS || 150), // jeda minimum antar-panggilan per titik
  };
}
