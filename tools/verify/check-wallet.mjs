#!/usr/bin/env node
// Pemeriksa publik Holder Credit: cocokkan kredit satu dompet dengan akar Merkle di GhostLedger
// (Robinhood Chain 4663) lewat eth_call verify(). Tidak butuh kunci apa pun, tidak mengirim transaksi.
//
// Mode 1 — satu kredit manual:
//   node tools/verify/check-wallet.mjs --hour 498763 --wallet 0x… --credit 4200000 --proof 0xaa…,0xbb… [--ledger 0x…] [--rpc URL]
//   (--credit dalam mikro-USD; --proof dipisah koma atau array JSON; bukti kosong = --proof "")
// Mode 2 — semua kredit dompet dari server GHOSTKEY:
//   node tools/verify/check-wallet.mjs --base https://ghostkeyai.com --wallet 0x… [--ledger 0x…] [--rpc URL]
//   (membaca /api/holder/<wallet>; alamat ledger diambil dari /api/config kalau --ledger kosong)
//
// Keluar dengan kode 0 kalau semua TRUE, 1 kalau ada FALSE, 2 kalau masukan/jaringan bermasalah.
import { Contract, JsonRpcProvider, getAddress, isHexString } from 'ethers';
import { leafHash, verifyProof } from '../../server/merkle.mjs';

const RPC_BAWAAN = 'https://rpc.mainnet.chain.robinhood.com';
const ABI = [
  'function verify(uint64 hour, address wallet, uint128 creditMicro, bytes32[] proof) view returns (bool)',
  'function hourOf(uint64 hour) view returns (bytes32 root, uint128 poolMicro, uint32 entries, uint64 postedAt)',
];

function bacaArgumen(argv) {
  const a = {};
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    if (!k.startsWith('--')) continue;
    const nama = k.slice(2);
    const nilai = argv[i + 1] !== undefined && !argv[i + 1].startsWith('--') ? argv[++i] : '';
    a[nama] = nilai;
  }
  return a;
}

function berhenti(pesan) {
  console.error(`Error: ${pesan}`);
  console.error('Usage:\n  check-wallet.mjs --hour <n> --wallet <0x…> --credit <microUSD> --proof <0x…,0x…> [--ledger <0x…>] [--rpc <url>]\n  check-wallet.mjs --base <https://…> --wallet <0x…> [--ledger <0x…>] [--rpc <url>]');
  process.exit(2);
}

function bacaBukti(teks) {
  const t = (teks || '').trim();
  if (!t) return [];
  const daftar = t.startsWith('[') ? JSON.parse(t) : t.split(',').map((x) => x.trim()).filter(Boolean);
  for (const p of daftar) if (!isHexString(p, 32)) berhenti(`proof element is not bytes32: ${p}`);
  return daftar;
}

async function ambilJson(url) {
  const res = await fetch(url, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(20_000) });
  if (!res.ok) throw new Error(`${url} → HTTP ${res.status}`);
  return res.json();
}

// Kredit dalam mikro-USD: pakai creditMicro kalau server menyediakannya (tepat), kalau tidak dari creditUsd.
function mikroDari(c) {
  if (c.creditMicro !== undefined && c.creditMicro !== null) return BigInt(c.creditMicro);
  if (c.creditUsd !== undefined) return BigInt(Math.round(Number(c.creditUsd) * 1e6));
  throw new Error('credit has neither creditMicro nor creditUsd');
}

const arg = bacaArgumen(process.argv.slice(2));
if (!arg.wallet) berhenti('--wallet is required');
let wallet;
try {
  wallet = getAddress(arg.wallet.trim());
} catch {
  berhenti(`not a valid address: ${arg.wallet}`);
}
const base = (arg.base || '').replace(/\/+$/, '');

// Kumpulkan kredit yang mau diperiksa.
let kredit = [];
let ledger = (arg.ledger || process.env.LEDGER_ADDRESS || '').trim();
try {
  if (base) {
    const data = await ambilJson(`${base}/api/holder/${wallet}`);
    kredit = (data.credits || []).map((c) => ({ hour: Number(c.hour), creditMicro: mikroDari(c), proof: c.proof || [], root: c.root, txHash: c.txHash }));
    if (!ledger) ledger = ((await ambilJson(`${base}/api/config`)).ledger || '').trim();
    if (kredit.length === 0) {
      console.log(`No Holder Credit recorded for ${wallet} at ${base}.`);
      process.exit(0);
    }
  } else {
    if (arg.hour === undefined || arg.credit === undefined || arg.proof === undefined) berhenti('--hour, --credit and --proof are required without --base');
    if (!/^[0-9]+$/.test(arg.hour) || !/^[0-9]+$/.test(arg.credit)) berhenti('--hour and --credit must be whole numbers (credit in micro-USD)');
    kredit = [{ hour: Number(arg.hour), creditMicro: BigInt(arg.credit), proof: bacaBukti(arg.proof) }];
  }
} catch (e) {
  berhenti(e.message);
}
if (!ledger) berhenti('GhostLedger address unknown: pass --ledger, set LEDGER_ADDRESS, or use --base (ledger may not be deployed yet)');

const rpc = arg.rpc || process.env.LEDGER_RPC || RPC_BAWAAN;
const kontrak = new Contract(getAddress(ledger), ABI, new JsonRpcProvider(rpc, undefined, { batchMaxCount: 1 }));

console.log(`GhostLedger ${getAddress(ledger)} via ${rpc}`);
console.log(`Wallet      ${wallet}\n`);

let semuaBenar = true;
for (const k of kredit) {
  const leaf = leafHash(wallet, k.hour, k.creditMicro);
  let onchain = false;
  let akarChain = null;
  try {
    const h = await kontrak.hourOf(k.hour);
    akarChain = h.postedAt === 0n ? null : h.root;
    onchain = await kontrak.verify(k.hour, wallet, k.creditMicro, k.proof);
  } catch (e) {
    berhenti(`RPC call failed: ${e.shortMessage || e.message}`);
  }
  const usd = (Number(k.creditMicro) / 1e6).toFixed(6);
  console.log(`hour ${k.hour}  (${new Date(k.hour * 3600 * 1000).toISOString().slice(0, 13)}:00 UTC)  credit $${usd}  [${k.creditMicro} micro]`);
  console.log(`  leaf          ${leaf}`);
  console.log(`  on-chain root ${akarChain || '(hour not posted)'}`);
  if (k.root) {
    console.log(`  server root   ${k.root}${akarChain && k.root.toLowerCase() !== akarChain.toLowerCase() ? '  << MISMATCH' : ''}`);
    console.log(`  local check   ${verifyProof(leaf, k.proof, k.root) ? 'ok' : 'proof does not match server root'}`);
  }
  if (k.txHash) console.log(`  post tx       https://robinhoodchain.blockscout.com/tx/${k.txHash}`);
  console.log(`  verify()      ${onchain ? 'TRUE' : 'FALSE'}\n`);
  if (!onchain) semuaBenar = false;
}

console.log(semuaBenar ? 'TRUE' : 'FALSE');
process.exit(semuaBenar ? 0 : 1);
