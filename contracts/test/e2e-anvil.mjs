// Uji ujung-ke-ujung: server/merkle.mjs + server/chain/ledger.mjs melawan GhostLedger sungguhan di anvil.
// Membuktikan pohon JS diterima kontrak Solidity (JS == Solidity).
//
//   ~/.local/node/node-v22.23.2-darwin-arm64/bin/node contracts/test/e2e-anvil.mjs
//
// Langkah: hidupkan anvil :8877 → pasang GhostLedger (poster = akun anvil #0) → bangun pohon 5 entri
// → postHour → verifyOnChain 5× (harus true) + entri yang diutak-atik (harus false) → matikan anvil
// lewat PID yang kita jalankan sendiri (bukan pkill/killall).
import { spawn, execFileSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { ContractFactory, JsonRpcProvider, Wallet, getAddress, keccak256, toUtf8Bytes } from 'ethers';
import { buildTree, leafHash, verifyProof } from '../../server/merkle.mjs';

const PORT = 8877;
const RPC = `http://127.0.0.1:${PORT}`;
// Kunci publik bawaan anvil (akun #0 dan #1) — hanya untuk rantai lokal, bukan rahasia.
const KUNCI_0 = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';
const KUNCI_1 = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412111fdc847b6a5c';

const disini = dirname(fileURLToPath(import.meta.url));
const folderKontrak = join(disini, '..');
const FORGE = join(homedir(), '.foundry/bin/forge');
const ANVIL = join(homedir(), '.foundry/bin/anvil');

let gagal = 0;
function cek(syarat, label) {
  console.log(`${syarat ? 'PASS' : 'FAIL'}  ${label}`);
  if (!syarat) gagal++;
}
const tidur = (ms) => new Promise((r) => setTimeout(r, ms));

async function harapRevert(janji, pola, label) {
  try {
    await janji;
    cek(false, `${label} (tidak revert)`);
  } catch (e) {
    cek(e.code === 'LEDGER_REVERT' && pola.test(e.message), `${label} → ${e.message}`);
  }
}

// ---- 1. anvil ----
// Cek mentah lewat fetch (provider ethers akan mencoba ulang tanpa henti kalau node belum hidup).
async function chainIdMentah() {
  try {
    const res = await fetch(RPC, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_chainId', params: [] }),
      signal: AbortSignal.timeout(1000),
    });
    return (await res.json()).result || null;
  } catch {
    return null;
  }
}

if (await chainIdMentah()) {
  console.error(`Port ${PORT} sudah dipakai proses lain — hentikan dulu, skrip ini tidak akan mematikannya.`);
  process.exit(2);
}

const anvil = spawn(ANVIL, ['--port', String(PORT), '--silent'], { stdio: 'ignore' });
console.log(`anvil hidup, PID ${anvil.pid}`);
const matikanAnvil = () => {
  if (anvil.exitCode === null && !anvil.killed) anvil.kill('SIGTERM'); // hanya PID milik kita
};
process.on('exit', matikanAnvil);
process.on('SIGINT', () => process.exit(130));
process.on('SIGTERM', () => process.exit(143));

try {
  // tunggu anvil siap (maks ±10 detik), baru buat provider
  let chainId = null;
  for (let i = 0; i < 100 && !chainId; i++) {
    chainId = await chainIdMentah();
    if (!chainId) await tidur(100);
  }
  if (!chainId) throw new Error('anvil tidak menyala');
  const provider = new JsonRpcProvider(RPC, Number(chainId), { staticNetwork: true, batchMaxCount: 1, pollingInterval: 100, cacheTimeout: -1 });

  // ---- 2. build + pasang ----
  const artefak = join(folderKontrak, 'out/GhostLedger.sol/GhostLedger.json');
  if (!existsSync(artefak)) execFileSync(FORGE, ['build', '-q'], { cwd: folderKontrak, stdio: 'inherit' });
  const { abi, bytecode } = JSON.parse(readFileSync(artefak, 'utf8'));
  const poster = new Wallet(KUNCI_0, provider);
  const orangLain = new Wallet(KUNCI_1, provider);
  const ledger = await new ContractFactory(abi, bytecode.object, poster).deploy(poster.address);
  await ledger.waitForDeployment();
  const alamat = getAddress(await ledger.getAddress());
  console.log(`GhostLedger terpasang di ${alamat} (poster ${poster.address})`);

  // ledger.mjs membaca alamat + RPC dari env (jalur yang sama dengan server).
  process.env.LEDGER_ADDRESS = alamat;
  process.env.LEDGER_RPC = RPC;
  const L = await import('../../server/chain/ledger.mjs');

  cek(L.ledgerAddress() === alamat, 'ledgerAddress() membaca LEDGER_ADDRESS');
  cek((await L.ledgerPoster()) === poster.address, 'poster() = akun anvil #0');
  cek((await L.latestHour()) === 0, 'latestHour() = 0 sebelum ada posting');

  // ---- 3. pohon 5 entri dari merkle.mjs ----
  const blok = await provider.getBlock('latest');
  const jamSekarang = Math.floor(blok.timestamp / 3600);
  const hour = jamSekarang; // sengaja jam BERJALAN → harus ditolak dulu, lalu waktu dimajukan
  const dompet = (i) => getAddress('0x' + keccak256(toUtf8Bytes(`ghostkey-e2e-${i}`)).slice(-40));
  const entries = [4_200_000n, 1n, 77_777n, 123_456_789n, 0n].map((c, i) => ({ wallet: dompet(i), hour, creditMicro: c }));
  const tree = buildTree(entries);
  cek(tree.leaves.every((l, i) => verifyProof(l, tree.proofs[i], tree.root)), 'verifyProof JS: 5/5 true');
  const poolMicro = 4_200_000n + 1n + 77_777n + 123_456_789n;

  // jam berjalan belum boleh
  await harapRevert(
    L.postHour({ hour, root: tree.root, poolMicro, entries: 5, uri: `data/ledger/hour-${hour}.json`, signer: poster }),
    /HourNotPast/,
    'postHour jam berjalan ditolak (simulasi)',
  );

  // majukan waktu 1 jam → jam tadi sudah lewat
  await provider.send('evm_increaseTime', [3600]);
  await provider.send('evm_mine', []);

  // bukan poster
  await harapRevert(
    L.postHour({ hour, root: tree.root, poolMicro, entries: 5, signer: orangLain }),
    /NotPoster/,
    'postHour dari dompet lain ditolak',
  );

  const hasil = await L.postHour({ hour, root: tree.root, poolMicro, entries: 5, uri: `data/ledger/hour-${hour}.json`, signer: poster });
  console.log(`post() tx ${hasil.txHash} blok ${hasil.blockNumber} gasUsed ${hasil.gasUsed}`);
  cek(/^0x[0-9a-f]{64}$/.test(hasil.txHash), 'postHour mengembalikan txHash');

  await harapRevert(
    L.postHour({ hour, root: tree.root, poolMicro, entries: 5, signer: poster }),
    /AlreadyPosted/,
    'posting ganda ditolak',
  );

  const h = await L.readHour(hour);
  cek(h && h.root === tree.root && h.poolMicro === poolMicro && h.entries === 5 && h.postedAt > 0, 'readHour cocok');
  cek((await L.readHour(hour - 1)) === null, 'readHour jam belum diposting → null');
  cek((await L.latestHour()) === hour, `latestHour() = ${hour}`);
  cek((await L.postedCount()) === 1, 'postedCount() = 1');

  // ---- 4. verifikasi on-chain ----
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    const ok = await L.verifyOnChain({ hour, wallet: e.wallet, creditMicro: e.creditMicro, proof: tree.proofs[i] });
    cek(ok === true, `verifyOnChain entri ${i} (${e.wallet}, ${e.creditMicro}) → ${ok}`);
  }
  const e1 = entries[1];
  const salah = [
    ['kredit diutak-atik', { hour, wallet: e1.wallet, creditMicro: e1.creditMicro + 1n, proof: tree.proofs[1] }],
    ['dompet lain', { hour, wallet: entries[2].wallet, creditMicro: e1.creditMicro, proof: tree.proofs[1] }],
    ['jam lain', { hour: hour - 1, wallet: e1.wallet, creditMicro: e1.creditMicro, proof: tree.proofs[1] }],
    ['bukti dirusak', { hour, wallet: e1.wallet, creditMicro: e1.creditMicro, proof: [tree.proofs[1][0].replace(/.$/, (x) => (x === '0' ? '1' : '0')), ...tree.proofs[1].slice(1)] }],
  ];
  for (const [label, arg] of salah) {
    const ok = await L.verifyOnChain(arg);
    cek(ok === false, `verifyOnChain ${label} → ${ok}`);
  }

  // ---- 5. vektor uji (contracts/test/vectors.json) juga diterima kontrak ----
  const v = JSON.parse(readFileSync(join(disini, 'vectors.json'), 'utf8'));
  const vt = buildTree(v.leaves.map((x) => ({ wallet: x.wallet, hour: v.hour, creditMicro: x.creditMicro })));
  cek(vt.root === v.root && vt.leaves.every((l, i) => l === v.leaves[i].leaf), 'vectors.json = buildTree() hari ini');
  cek(leafHash(v.leaves[0].wallet, v.hour, v.leaves[0].creditMicro) === v.leaves[0].leaf, 'leafHash cocok dengan vektor');
  const h2 = await L.postHour({ hour: v.hour, root: v.root, poolMicro: 1, entries: v.leaves.length, signer: poster });
  console.log(`post() kedua (slot hitungan sudah terisi) gasUsed ${h2.gasUsed}`);
  for (let i = 0; i < v.leaves.length; i++) {
    const ok = await L.verifyOnChain({ hour: v.hour, wallet: v.leaves[i].wallet, creditMicro: v.leaves[i].creditMicro, proof: v.proofs[i] });
    cek(ok, `vektor ${i} diterima kontrak`);
  }
  cek((await L.latestHour()) === hour, 'latestHour tetap jam tertinggi setelah posting jam lama');
  cek((await L.postedCount()) === 2, 'postedCount() = 2');

  // ---- 6. tools/verify/check-wallet.mjs (skrip publik) ----
  const skrip = join(disini, '../../tools/verify/check-wallet.mjs');
  const jalankan = (args) => {
    try {
      return { kode: 0, out: execFileSync(process.execPath, [skrip, ...args, '--ledger', alamat, '--rpc', RPC], { encoding: 'utf8' }) };
    } catch (e) {
      return { kode: e.status, out: String(e.stdout || '') + String(e.stderr || '') };
    }
  };
  const e3 = entries[3];
  let r = jalankan(['--hour', String(hour), '--wallet', e3.wallet, '--credit', String(e3.creditMicro), '--proof', tree.proofs[3].join(',')]);
  cek(r.kode === 0 && r.out.trim().endsWith('TRUE'), 'check-wallet (manual) → TRUE');
  r = jalankan(['--hour', String(hour), '--wallet', e3.wallet, '--credit', String(e3.creditMicro + 1n), '--proof', tree.proofs[3].join(',')]);
  cek(r.kode === 1 && r.out.trim().endsWith('FALSE'), 'check-wallet (kredit salah) → FALSE');

  // mode --base: server tiruan kecil yang meniru /api/holder/<wallet> + /api/config
  const { createServer } = await import('node:http');
  const srv = createServer((req, res) => {
    res.setHeader('content-type', 'application/json');
    if (req.url === '/api/config') return res.end(JSON.stringify({ chainId: 4663, ledger: alamat }));
    if (req.url === `/api/holder/${entries[0].wallet}`) {
      return res.end(JSON.stringify({
        wallet: entries[0].wallet,
        credits: [{ hour, creditUsd: Number(entries[0].creditMicro) / 1e6, creditMicro: String(entries[0].creditMicro), proof: tree.proofs[0], root: tree.root, txHash: hasil.txHash }],
      }));
    }
    res.statusCode = 404;
    res.end('{}');
  });
  await new Promise((ok) => srv.listen(0, '127.0.0.1', ok));
  const base = `http://127.0.0.1:${srv.address().port}`;
  const r2 = await new Promise((ok) => {
    const anak = spawn(process.execPath, [skrip, '--base', base, '--wallet', entries[0].wallet, '--rpc', RPC]);
    let out = '';
    anak.stdout.on('data', (d) => (out += d));
    anak.stderr.on('data', (d) => (out += d));
    anak.on('close', (kode) => ok({ kode, out }));
  });
  srv.close();
  cek(r2.kode === 0 && r2.out.trim().endsWith('TRUE'), 'check-wallet (--base) → TRUE');
  console.log(r2.out.replace(/^/gm, '    | '));
} catch (e) {
  console.error('ERROR', e);
  gagal++;
} finally {
  matikanAnvil();
}

console.log(gagal === 0 ? '\nSEMUA LULUS — JS == Solidity' : `\n${gagal} GAGAL`);
process.exit(gagal === 0 ? 0 : 1);
