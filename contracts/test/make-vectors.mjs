// Membuat contracts/test/vectors.json dari server/merkle.mjs (sisi JS).
// GhostLedger.t.sol (testVectorsFromJs) lalu membaca file ini, membangun ulang pohon dengan
// aturan Solidity, dan memastikan akar + semua bukti sama persis → bukti JS == Solidity.
//
//   node contracts/test/make-vectors.mjs
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { getAddress, keccak256, toUtf8Bytes } from 'ethers';
import { buildTree, verifyProof } from '../../server/merkle.mjs';

const disini = dirname(fileURLToPath(import.meta.url));

// Dompet contoh deterministik (bukan dompet sungguhan): 20 byte terakhir keccak("ghostkey-vector-i").
const dompet = (i) => getAddress('0x' + keccak256(toUtf8Bytes(`ghostkey-vector-${i}`)).slice(-40));

const hour = 494000; // 10 Mei 2026 08:00 UTC — sudah lewat, jadi bisa diposting di tes
const kredit = [1_250_000n, 37n, 999_999_999n, 0n, (1n << 128n) - 1n]; // termasuk 0 dan maks uint128
const entries = kredit.map((c, i) => ({ wallet: dompet(i), hour, creditMicro: c }));

const { root, leaves, proofs } = buildTree(entries);
leaves.forEach((leaf, i) => {
  if (!verifyProof(leaf, proofs[i], root)) throw new Error(`bukti JS gagal untuk daun ${i}`);
});

const out = {
  rule: 'leaf=keccak256(abi.encode(address,uint64,uint128)); sorted-pair nodes; leaves sorted by hash; odd node promoted',
  hour,
  leaves: entries.map((e, i) => ({ wallet: e.wallet, creditMicro: e.creditMicro.toString(), leaf: leaves[i] })),
  root,
  proofs,
};
const tujuan = join(disini, 'vectors.json');
writeFileSync(tujuan, JSON.stringify(out, null, 2) + '\n');
console.log(`vectors.json ditulis: ${tujuan}\nroot ${root}`);
