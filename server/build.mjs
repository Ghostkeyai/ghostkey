// Sidik jari kode yang sedang berjalan.
// Saat server menyala, setiap file di BUILD_SCOPE di-hash (SHA-256), lalu daftar "hash  path" (urut path)
// di-hash lagi jadi satu treeHash. Formatnya sama persis dengan keluaran `shasum -a 256`, jadi siapa pun
// bisa menghitung ulang dari repo publik tanpa skrip kami:
//   git checkout <commit>
//   git ls-files server web package.json package-lock.json | LC_ALL=C sort | xargs shasum -a 256 | shasum -a 256
// Commit dibaca dari BUILD.json yang ditulis tools/deploy.sh (hanya boleh deploy dari pohon kerja bersih).
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, sep } from 'node:path';

export const BUILD_SCOPE = ['server', 'web', 'package.json', 'package-lock.json'];
const SKIP = new Set(['.DS_Store']);

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

function walk(root, rel, out) {
  const abs = join(root, rel);
  if (!existsSync(abs)) return;
  if (statSync(abs).isDirectory()) {
    for (const name of readdirSync(abs)) if (!SKIP.has(name)) walk(root, join(rel, name), out);
  } else out.push(rel.split(sep).join('/'));
}

// Manifest file di sebuah folder root (dipakai server DAN skrip verifikasi, supaya caranya satu)
export function manifest(root, paths = null) {
  const list = paths || (() => { const o = []; for (const p of BUILD_SCOPE) walk(root, p, o); return o; })();
  // urut per byte, sama dengan LC_ALL=C sort
  const files = [...list].sort((a, b) => (Buffer.compare(Buffer.from(a), Buffer.from(b))))
    .map((path) => ({ path, sha256: sha256(readFileSync(join(root, path))) }));
  const text = files.map((f) => `${f.sha256}  ${f.path}\n`).join('');
  return { files, treeHash: sha256(text) };
}

let cached = null;
// Dihitung sekali saat server menyala: itulah kode yang dimuat proses ini
export function buildInfo(root, repo) {
  if (cached) return cached;
  let meta = {};
  try { meta = JSON.parse(readFileSync(join(root, 'BUILD.json'), 'utf8')); } catch {}
  const commit = /^[0-9a-f]{40}$/.test(meta.commit || '') ? meta.commit : null;
  const m = manifest(root);
  const g = String(repo || '').replace(/\/+$/, '');
  cached = {
    commit,
    commitUrl: commit && g ? `${g}/tree/${commit}` : null,
    deployedAt: Number(meta.deployedAt) || null,
    startedAt: Date.now(),
    scope: BUILD_SCOPE,
    fileCount: m.files.length,
    treeHash: m.treeHash,
    recompute: 'git ls-files server web package.json package-lock.json | LC_ALL=C sort | xargs shasum -a 256 | shasum -a 256',
    script: g ? `${g}/blob/main/tools/verify/check-build.mjs` : null,
    files: m.files,
  };
  return cached;
}

// Ringkasan tanpa daftar file (untuk /api/proof)
export const buildSummary = (b) => { const { files, ...rest } = b; return rest; };
