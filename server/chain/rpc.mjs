// RPC Robinhood Chain berotasi: beberapa titik gratis, coba ulang, dan titik yang gagal
// "didinginkan" ±90 detik. Dipakai lewat provider() (ethers v6) atau rpcCall() untuk
// panggilan mentah (mis. eth_call dengan state override, eth_sendRawTransaction).
import { JsonRpcProvider, Network } from 'ethers';
import { chainConfig, CHAIN_ID } from './config.mjs';

const tidur = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- keadaan per titik ----
const dinginSampai = new Map(); // url -> waktu (ms) titik boleh dipakai lagi
const antrean = new Map(); // url -> promise terakhir (agar ada jeda antar-panggilan)

function sedangDingin(url) {
  return (dinginSampai.get(url) || 0) > Date.now();
}

function dinginkan(url, alasan) {
  const { cooldownMs } = chainConfig();
  dinginSampai.set(url, Date.now() + cooldownMs);
  if (process.env.CHAIN_DEBUG) console.warn(`[rpc] dinginkan ${url}: ${alasan}`);
}

// Tunggu giliran: tiap titik minimal minGapMs antar-panggilan (titik publik membatasi laju).
function giliran(url) {
  const { minGapMs } = chainConfig();
  const sebelumnya = antrean.get(url) || Promise.resolve();
  const berikut = sebelumnya.then(() => tidur(minGapMs));
  antrean.set(url, berikut.catch(() => {}));
  return sebelumnya;
}

// Urutan titik untuk satu metode: yang sehat dulu, yang sedang dingin paling akhir
// (dipakai hanya kalau semuanya dingin).
function urutanTitik(method) {
  const cfg = chainConfig();
  const daftar = method === 'eth_getLogs' ? cfg.logsRpcUrls : cfg.rpcUrls;
  const sehat = daftar.filter((u) => !sedangDingin(u));
  const dingin = daftar
    .filter((u) => sedangDingin(u))
    .sort((a, b) => dinginSampai.get(a) - dinginSampai.get(b));
  return [...sehat, ...dingin];
}

// Error JSON-RPC yang "asli" (revert, nonce, saldo kurang) TIDAK boleh memicu rotasi;
// hasilnya harus diteruskan apa adanya ke pemanggil.
const POLA_ERROR_ASLI =
  /execution reverted|revert|insufficient funds|nonce too low|nonce too high|already known|replacement|underpriced|intrinsic gas|gas too low|invalid sender|exceeds block gas limit/i;
// Error yang menandakan masalah titik (batas laju, sibuk, tanpa arsip, dll) → rotasi.
const POLA_ERROR_INFRA =
  /rate|limit|busy|too many|archive|historical|state|timeout|timed out|capacity|exceed|unavailable|header not found|missing trie|upstream|backend|temporar|batch|range|free plan|not available|internal|not supported|unsupported|method not found|forbidden|unauthori/i;

function errorInfra(err) {
  if (!err) return false;
  const pesan = String(err.message || '');
  if (err.code === 3 || POLA_ERROR_ASLI.test(pesan)) return false;
  if ([-32005, -32601, -32603, 429].includes(Number(err.code))) return true;
  return POLA_ERROR_INFRA.test(pesan);
}

// Kirim satu payload (objek atau array) ke satu titik. Melempar kalau titiknya bermasalah.
async function kirimKeTitik(url, payload) {
  await giliran(url);
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(20_000),
  });
  const teks = await res.text();
  if (!res.ok && !teks.trim().startsWith('{') && !teks.trim().startsWith('[')) {
    throw new Error(`HTTP ${res.status}`);
  }
  if (!teks.trim()) throw new Error(`badan kosong (HTTP ${res.status})`);
  let json;
  try {
    json = JSON.parse(teks);
  } catch {
    throw new Error(`bukan JSON (HTTP ${res.status})`);
  }
  const arr = Array.isArray(json) ? json : [json];
  // Batch yang kembali sebagai satu objek tanpa id (mis. pocket) = gagal, bukan kosong.
  if (Array.isArray(payload) && !Array.isArray(json)) {
    throw new Error('balasan batch bukan array');
  }
  if (!res.ok && arr.every((x) => x && x.error)) {
    throw new Error(`HTTP ${res.status}: ${arr[0].error.message || ''}`);
  }
  // Semua item gagal karena infra → anggap titik gagal (bukan sukses-kosong).
  if (arr.length > 0 && arr.every((x) => x && x.error && errorInfra(x.error))) {
    throw new Error(`semua item gagal: ${arr[0].error.message || arr[0].error.code}`);
  }
  // Item yang sama sekali tanpa result & error juga tanda balasan rusak.
  if (arr.some((x) => !x || (!('result' in x) && !('error' in x)))) {
    throw new Error('balasan JSON-RPC tidak lengkap');
  }
  return arr;
}

// Kirim payload dengan rotasi titik + beberapa putaran coba ulang.
export async function kirimPayload(payload) {
  const method = Array.isArray(payload) ? payload[0]?.method : payload.method;
  let errTerakhir;
  for (let putaran = 0; putaran < 3; putaran++) {
    if (putaran > 0) await tidur(1000 * putaran + Math.floor(Math.random() * 400));
    for (const url of urutanTitik(method)) {
      try {
        return await kirimKeTitik(url, payload);
      } catch (e) {
        errTerakhir = e;
        dinginkan(url, e.message);
      }
    }
  }
  const err = new Error(`rpc_unavailable: ${method}: ${errTerakhir?.message || 'tidak ada titik'}`);
  err.code = 'RPC_UNAVAILABLE';
  throw err;
}

let idBerikut = 1;

// Panggilan mentah: mengembalikan `result`, atau melempar Error dengan .code/.data dari node.
export async function rpcCall(method, params = []) {
  const [jawab] = await kirimPayload({ jsonrpc: '2.0', id: idBerikut++, method, params });
  if (jawab.error) {
    const err = new Error(jawab.error.message || 'rpc error');
    err.code = jawab.error.code;
    err.data = jawab.error.data;
    throw err;
  }
  return jawab.result;
}

// Provider ethers yang semua permintaannya lewat kirimPayload() di atas.
class ProviderBerotasi extends JsonRpcProvider {
  async _send(payload) {
    return kirimPayload(payload);
  }
}

let _provider = null;

export function provider() {
  if (_provider) return _provider;
  const cfg = chainConfig();
  const jaringan = new Network('robinhood', CHAIN_ID);
  _provider = new ProviderBerotasi(cfg.rpcUrls[0], jaringan, {
    staticNetwork: jaringan, // jangan tanya eth_chainId terus-menerus
    batchMaxCount: 1, // pocket/drpc tidak andal untuk batch → satu permintaan per POST
    polling: true,
    pollingInterval: 2000,
  });
  return _provider;
}

// Untuk tes/diagnosa: status pendinginan titik saat ini.
export function statusTitik() {
  const cfg = chainConfig();
  const semua = [...new Set([...cfg.rpcUrls, ...cfg.logsRpcUrls])];
  return semua.map((url) => ({ url, dinginMs: Math.max(0, (dinginSampai.get(url) || 0) - Date.now()) }));
}
