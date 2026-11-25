// Klien kontrak GhostLedger (contracts/src/GhostLedger.sol) — posting akar Merkle Holder Credit
// per jam dan pembacaan publik (readHour, verifyOnChain, latestHour).
//
// Alamat:  opsi `address` → env LEDGER_ADDRESS.
// RPC:     opsi `rpcUrl`  → env LEDGER_RPC → provider() berotasi dari rpc.mjs (Robinhood Chain 4663).
//          LEDGER_RPC/rpcUrl dipakai untuk uji lokal di anvil (mis. http://127.0.0.1:8877).
// Penanda tangan: opsi `signer` (ethers Signer). Kalau kosong → gasWallet() dari wallets.mjs
//          (m/44'/60'/1'/0/0 = dompet poster ledger). Kunci tidak pernah dicatat ke log.
import { Contract, Interface, JsonRpcProvider, ZeroHash, getAddress, isHexString, keccak256, toUtf8Bytes } from 'ethers';
import { provider as providerBerotasi } from './rpc.mjs';

/** Human-readable ABI. Full JSON ABI: contracts/abi/GhostLedger.json */
export const LEDGER_ABI = [
  'constructor(address poster_)',
  'function poster() view returns (address)',
  'function hourOf(uint64 hour) view returns (bytes32 root, uint128 poolMicro, uint32 entries, uint64 postedAt)',
  'function postedCount() view returns (uint64)',
  'function latestHour() view returns (uint64)',
  'function post(uint64 hour, bytes32 root, uint128 poolMicro, uint32 entries, bytes32 uriHash)',
  'function verify(uint64 hour, address wallet, uint128 creditMicro, bytes32[] proof) view returns (bool)',
  'event Posted(uint64 indexed hour, bytes32 root, uint128 poolMicro, uint32 entries, bytes32 uriHash)',
  'error ZeroPoster()',
  'error NotPoster()',
  'error AlreadyPosted(uint64 hour)',
  'error HourNotPast(uint64 hour, uint256 currentHour)',
  'error EmptyRoot()',
];

const iface = new Interface(LEDGER_ABI);

export function ledgerAddress() {
  const a = (process.env.LEDGER_ADDRESS || '').trim();
  return a || null;
}

// ---- pembantu ----

const providerLokal = new Map(); // url → JsonRpcProvider (untuk LEDGER_RPC / rpcUrl)

function ambilProvider(rpcUrl) {
  const url = (rpcUrl || process.env.LEDGER_RPC || '').trim();
  if (!url) return providerBerotasi();
  if (!providerLokal.has(url)) {
    providerLokal.set(url, new JsonRpcProvider(url, undefined, { batchMaxCount: 1, pollingInterval: 500, cacheTimeout: -1 }));
  }
  return providerLokal.get(url);
}

function ambilAlamat(address) {
  const a = (address || ledgerAddress() || '').trim();
  if (!a) {
    const err = new Error('GhostLedger not deployed yet (LEDGER_ADDRESS is empty)');
    err.code = 'NO_LEDGER';
    throw err;
  }
  return getAddress(a);
}

function kontrak({ address, rpcUrl, runner } = {}) {
  return new Contract(ambilAlamat(address), LEDGER_ABI, runner || ambilProvider(rpcUrl));
}

// Terjemahkan revert kontrak (custom error) jadi pesan yang bisa dibaca.
function pesanRevert(e) {
  const data = e?.data ?? e?.info?.error?.data ?? e?.error?.data ?? e?.revert?.data;
  let nama = e?.revert?.name;
  let args = e?.revert?.args;
  if (!nama && typeof data === 'string' && data.length >= 10) {
    try {
      const p = iface.parseError(data);
      if (p) {
        nama = p.name;
        args = p.args;
      }
    } catch {
      /* bukan error milik GhostLedger */
    }
  }
  switch (nama) {
    case 'NotPoster':
      return 'NotPoster: signer is not the GhostLedger poster';
    case 'AlreadyPosted':
      return `AlreadyPosted: hour ${args?.[0]} is already on-chain`;
    case 'HourNotPast':
      return `HourNotPast: hour ${args?.[0]} is not finished yet (chain hour is ${args?.[1]})`;
    case 'EmptyRoot':
      return 'EmptyRoot: root is zero but entries > 0';
    case 'ZeroPoster':
      return 'ZeroPoster';
    default:
      return e?.shortMessage || e?.message || String(e);
  }
}

function keBigInt(v, nama) {
  if (typeof v === 'bigint') return v;
  if (typeof v === 'number' && Number.isSafeInteger(v)) return BigInt(v);
  if (typeof v === 'string' && /^(0x[0-9a-fA-F]+|[0-9]+)$/.test(v.trim())) return BigInt(v.trim());
  throw new Error(`${nama} is not an integer: ${v}`);
}

function keBytes32(v, nama) {
  if (!isHexString(v, 32)) throw new Error(`${nama} must be 0x + 64 hex chars`);
  return v;
}

// uriHash boleh hex 32 byte, atau (lewat opsi `uri`) string yang di-hash keccak256(utf8).
function hitungUriHash(uriHash, uri) {
  if (uriHash) return keBytes32(uriHash, 'uriHash');
  if (uri) return keccak256(toUtf8Bytes(String(uri)));
  return ZeroHash;
}

// Penanda tangan bawaan = dompet gas/poster dari wallets.mjs (dimuat malas: modul itu butuh mnemonic).
async function signerBawaan() {
  const { gasWallet } = await import('./wallets.mjs');
  return gasWallet().signer;
}

// ---- API ----

/**
 * Post one hour on-chain. Simulates with eth_call first so a revert never costs gas.
 * @returns {Promise<{txHash:string, blockNumber:number, gasUsed:bigint, poster:string}>}
 */
export async function postHour({ hour, root, poolMicro, entries, uriHash, uri, signer, address, rpcUrl, confirmations = 1 } = {}) {
  const h = keBigInt(hour, 'hour');
  const r = keBytes32(root || ZeroHash, 'root');
  const pool = keBigInt(poolMicro ?? 0, 'poolMicro');
  const n = Number(entries ?? 0);
  if (!Number.isInteger(n) || n < 0 || n > 0xffffffff) throw new Error(`entries out of range: ${entries}`);
  const u = hitungUriHash(uriHash, uri);

  let s = signer || (await signerBawaan());
  // Signer tanpa provider (mis. Wallet polos) → sambungkan ke provider kita.
  if (!s.provider) s = s.connect(ambilProvider(rpcUrl));
  const c = kontrak({ address, rpcUrl, runner: s });
  const dari = await s.getAddress();

  // 1) simulasi (eth_call dari alamat poster) — revert dibaca sebagai pesan yang jelas
  try {
    await c.post.staticCall(h, r, pool, n, u, { from: dari });
  } catch (e) {
    const err = new Error(`GhostLedger.post(${h}) would revert: ${pesanRevert(e)}`);
    err.code = 'LEDGER_REVERT';
    err.cause = e;
    throw err;
  }

  // 2) kirim sungguhan
  let tx;
  try {
    tx = await c.post(h, r, pool, n, u);
  } catch (e) {
    const err = new Error(`GhostLedger.post(${h}) send failed: ${pesanRevert(e)}`);
    err.code = 'LEDGER_SEND_FAILED';
    err.cause = e;
    throw err;
  }
  const rc = await tx.wait(confirmations);
  if (!rc || rc.status !== 1) {
    const err = new Error(`GhostLedger.post(${h}) reverted on-chain: ${tx.hash}`);
    err.code = 'LEDGER_REVERT';
    err.txHash = tx.hash;
    throw err;
  }
  return { txHash: tx.hash, blockNumber: rc.blockNumber, gasUsed: rc.gasUsed, poster: dari };
}

/** Read one posted hour, or null if that hour was never posted. */
export async function readHour(hour, { address, rpcUrl } = {}) {
  const [root, poolMicro, entries, postedAt] = await kontrak({ address, rpcUrl }).hourOf(keBigInt(hour, 'hour'));
  if (postedAt === 0n) return null;
  return { root, poolMicro, entries: Number(entries), postedAt: Number(postedAt) };
}

/** On-chain proof check via eth_call. Never sends a transaction. */
export async function verifyOnChain({ hour, wallet, creditMicro, proof, address, rpcUrl } = {}) {
  const bukti = (proof || []).map((p, i) => keBytes32(p, `proof[${i}]`));
  return kontrak({ address, rpcUrl }).verify(keBigInt(hour, 'hour'), getAddress(wallet), keBigInt(creditMicro, 'creditMicro'), bukti);
}

/** Highest hour posted so far (number), 0 if none. */
export async function latestHour({ address, rpcUrl } = {}) {
  return Number(await kontrak({ address, rpcUrl }).latestHour());
}

/** Number of hours posted so far (number). */
export async function postedCount({ address, rpcUrl } = {}) {
  return Number(await kontrak({ address, rpcUrl }).postedCount());
}

/** Poster address fixed in the contract. */
export async function ledgerPoster({ address, rpcUrl } = {}) {
  return kontrak({ address, rpcUrl }).poster();
}
