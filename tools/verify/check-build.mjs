#!/usr/bin/env node
// Compare the code the live GHOSTKEY server says it runs with this checkout of the public repo.
// The server hashes every file in server/, web/, package.json and package-lock.json when it starts
// and publishes the list at /api/build. This script hashes the same files here and lists any difference.
//   git clone https://github.com/Ghostkeyai/ghostkey && cd ghostkey
//   node tools/verify/check-build.mjs            # checks out nothing; run `git checkout <commit>` first
//   node tools/verify/check-build.mjs https://ghostkeyai.com
// No script needed either: the treeHash equals
//   git ls-files server web package.json package-lock.json | LC_ALL=C sort | xargs shasum -a 256 | shasum -a 256
// Exit code 0 = identical, 1 = a difference, 2 = network error.
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { manifest, BUILD_SCOPE } from '../../server/build.mjs';

const BASE = String(process.argv[2] || 'https://ghostkeyai.com').replace(/\/+$/, '');
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

let live;
try { live = await fetch(`${BASE}/api/build`).then((r) => r.json()); }
catch (e) { console.error('network error:', e.message); process.exit(2); }

const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT }).toString().trim();
// Hanya file yang dilacak git, sama seperti perintah ls-files di atas
const tracked = execFileSync('git', ['ls-files', ...BUILD_SCOPE], { cwd: ROOT }).toString().split('\n').filter(Boolean);
const local = manifest(ROOT, tracked);

console.log(`live commit   ${live.commit || '(not reported)'}`);
console.log(`local commit  ${head}${live.commit && live.commit !== head ? `   ← run: git checkout ${live.commit}` : ''}`);
console.log(`live tree     ${live.treeHash}  (${live.fileCount} files)`);
console.log(`local tree    ${local.treeHash}  (${local.files.length} files)`);

const L = new Map(live.files.map((f) => [f.path, f.sha256]));
const M = new Map(local.files.map((f) => [f.path, f.sha256]));
const diff = [];
for (const [p, h] of M) if (!L.has(p)) diff.push(`only here   ${p}`); else if (L.get(p) !== h) diff.push(`different   ${p}`);
for (const p of L.keys()) if (!M.has(p)) diff.push(`only live   ${p}`);

if (!diff.length && live.treeHash === local.treeHash) {
  console.log('\nSAME: every file the live server reports matches this checkout.');
  process.exit(0);
}
console.log(`\nDIFFERENT: ${diff.length} file(s)`);
for (const d of diff) console.log('  ' + d);
process.exit(1);
