// Pustaka Merkle Holder Credit — HARUS identik dengan contracts/src/GhostLedger.sol.
//
// Aturan (dikunci; mengubahnya = semua bukti lama tidak sah lagi):
//   1. Daun   = keccak256(abi.encode(address wallet, uint64 hour, uint128 creditMicro))
//               (urutan kolom: address, uint64, uint128 — masing-masing 32 byte, tanpa "packed").
//   2. Simpul = keccak256(min(a,b) ++ max(a,b)) — pasangan disortir, gaya OpenZeppelin MerkleProof.
//   3. Sebelum pohon dibangun, daun disortir menaik berdasarkan nilai hash-nya → pohon deterministik,
//      tidak bergantung urutan input.
//   4. Tingkat ganjil: simpul terakhir yang tidak punya pasangan DINAIKKAN apa adanya ke tingkat
//      berikutnya (tidak diduplikasi, tidak di-hash sendirian). Karena itu simpul tersebut tidak
//      menambah elemen ke bukti, dan verifikasi gaya OpenZeppelin (GhostLedger.verify) tetap lolos.
//   5. Pohon 1 daun: akar = daun itu sendiri, bukti = [].
//   6. Pohon kosong: akar = 0x00…00, bukti = [].
//
// Dipakai oleh server/credit.mjs (membangun pohon tiap jam) dan tools/verify/* (pemeriksaan publik).
import { AbiCoder, getAddress, keccak256, concat, ZeroHash } from 'ethers';

const coder = AbiCoder.defaultAbiCoder();
const MAX_U64 = (1n << 64n) - 1n;
const MAX_U128 = (1n << 128n) - 1n;
const POLA_B32 = /^0x[0-9a-fA-F]{64}$/;

// Ubah angka (bigint | number | string desimal/hex) jadi bigint dan cek rentangnya.
function keBigInt(nilai, max, nama) {
  let b;
  if (typeof nilai === 'bigint') b = nilai;
  else if (typeof nilai === 'number') {
    if (!Number.isSafeInteger(nilai)) throw new Error(`${nama} must be a safe integer, got ${nilai}`);
    b = BigInt(nilai);
  } else if (typeof nilai === 'string' && /^(0x[0-9a-fA-F]+|[0-9]+)$/.test(nilai.trim())) {
    b = BigInt(nilai.trim());
  } else {
    throw new Error(`${nama} is not an integer: ${nilai}`);
  }
  if (b < 0n || b > max) throw new Error(`${nama} out of range: ${b}`);
  return b;
}

function cekB32(h, nama) {
  if (typeof h !== 'string' || !POLA_B32.test(h)) throw new Error(`${nama} is not a 32-byte hex string`);
  return h.toLowerCase();
}

// Bandingkan dua bytes32 sebagai bilangan (hex huruf kecil, panjang sama → urutan string = urutan angka).
function lebihKecil(a, b) {
  return a < b;
}

// Gabungkan dua simpul dengan aturan pasangan tersortir.
export function hashPair(a, b) {
  const x = a.toLowerCase();
  const y = b.toLowerCase();
  return lebihKecil(x, y) ? keccak256(concat([x, y])) : keccak256(concat([y, x]));
}

/** Leaf hash: keccak256(abi.encode(address, uint64, uint128)) → 0x-hex (lowercase). */
export function leafHash(wallet, hour, creditMicro) {
  const w = getAddress(String(wallet).trim()); // melempar kalau alamat tidak sah
  const h = keBigInt(hour, MAX_U64, 'hour');
  const c = keBigInt(creditMicro, MAX_U128, 'creditMicro');
  return keccak256(coder.encode(['address', 'uint64', 'uint128'], [w, h, c])).toLowerCase();
}

// Satu tingkat ke atas: pasangkan (0,1), (2,3), …; sisa ganjil dinaikkan apa adanya.
function tingkatBerikut(level) {
  const naik = [];
  for (let i = 0; i < level.length; i += 2) {
    naik.push(i + 1 < level.length ? hashPair(level[i], level[i + 1]) : level[i]);
  }
  return naik;
}

/**
 * Build the hour tree.
 * @param {{wallet:string, hour:number|bigint|string, creditMicro:bigint|number|string}[]} entries
 * @returns {{ root:string, leaves:string[], proofs:string[][] }} leaves/proofs in INPUT order.
 */
export function buildTree(entries) {
  if (!Array.isArray(entries)) throw new Error('entries must be an array');
  if (entries.length === 0) return { root: ZeroHash, leaves: [], proofs: [] };

  const leaves = entries.map((e) => leafHash(e.wallet, e.hour, e.creditMicro));

  // Urutan di pohon: sortir berdasarkan hash (stabil; daun kembar tetap berdampingan).
  const urut = leaves.map((leaf, i) => ({ leaf, i })).sort((a, b) => (a.leaf < b.leaf ? -1 : a.leaf > b.leaf ? 1 : a.i - b.i));
  const posisi = new Array(leaves.length); // indeks input → posisi di tingkat 0
  urut.forEach((u, p) => {
    posisi[u.i] = p;
  });

  // Simpan semua tingkat (tingkat 0 = daun tersortir, terakhir = [akar]).
  const tingkat = [urut.map((u) => u.leaf)];
  while (tingkat[tingkat.length - 1].length > 1) tingkat.push(tingkatBerikut(tingkat[tingkat.length - 1]));
  const root = tingkat[tingkat.length - 1][0];

  const proofs = leaves.map((_, iInput) => {
    const bukti = [];
    let idx = posisi[iInput];
    for (let t = 0; t < tingkat.length - 1; t++) {
      const sib = idx ^ 1;
      if (sib < tingkat[t].length) bukti.push(tingkat[t][sib]); // tanpa pasangan → tidak ada elemen bukti
      idx >>= 1;
    }
    return bukti;
  });

  return { root, leaves, proofs };
}

/** OpenZeppelin-style check: fold proof with sorted-pair hashing and compare with root. */
export function verifyProof(leaf, proof, root) {
  try {
    let h = cekB32(leaf, 'leaf');
    for (const p of proof || []) h = hashPair(h, cekB32(p, 'proof element'));
    return h === cekB32(root, 'root');
  } catch {
    return false;
  }
}
