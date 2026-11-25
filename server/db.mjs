// Basis data SQLite bawaan Node 22 (node:sqlite). Satu berkas: data/ghostkey.db
// ATURAN PRIVASI: tidak ada kolom untuk isi prompt atau jawaban di tabel mana pun.
// tools/test-server.mjs memeriksa skema ini (nama kolom) supaya aturan itu tidak bocor diam-diam.
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { config } from './config.mjs';

mkdirSync(join(config.dataDir, 'ledger'), { recursive: true });
export const DB_PATH = process.env.GHOSTKEY_DB || join(config.dataDir, 'ghostkey.db');
export const db = new DatabaseSync(DB_PATH);

export const SCHEMA = `
CREATE TABLE IF NOT EXISTS accounts (
  id INTEGER PRIMARY KEY,
  wallet TEXT UNIQUE NOT NULL,             -- huruf kecil
  balance_micro INTEGER NOT NULL DEFAULT 0,
  held_micro INTEGER NOT NULL DEFAULT 0,    -- dana yang sedang ditahan untuk permintaan berjalan
  status TEXT NOT NULL DEFAULT 'active',    -- active | pending (dibuat otomatis oleh Ghost Credit, belum pernah masuk)
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS api_keys (
  id INTEGER PRIMARY KEY,
  account_id INTEGER NOT NULL REFERENCES accounts(id),
  key_hash TEXT UNIQUE NOT NULL,            -- sha256 kunci; kunci penuh tidak pernah disimpan
  prefix TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  revoked_at INTEGER
);
CREATE INDEX IF NOT EXISTS api_keys_account ON api_keys(account_id);
CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY, account_id INTEGER NOT NULL REFERENCES accounts(id), expires_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS nonces (
  wallet TEXT PRIMARY KEY, challenge TEXT NOT NULL, expires_at INTEGER NOT NULL   -- teks masuk sekali pakai (10 menit)
);
CREATE TABLE IF NOT EXISTS free_clients (
  client_id TEXT PRIMARY KEY, used INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS daily_counters (
  day TEXT NOT NULL, key TEXT NOT NULL, count INTEGER NOT NULL DEFAULT 0, micro INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (day, key)
);
-- Pemakaian: HANYA model, jumlah token, biaya, waktu. Tanpa isi.
CREATE TABLE IF NOT EXISTS usage (
  id INTEGER PRIMARY KEY,
  account_id INTEGER, client_id TEXT,
  source TEXT NOT NULL,                     -- chat | api | free | free_api
  model TEXT NOT NULL, tokens_in INTEGER NOT NULL, tokens_out INTEGER NOT NULL,
  cost_micro INTEGER NOT NULL, created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS usage_account ON usage(account_id, created_at);
CREATE TABLE IF NOT EXISTS deposits (
  tx_hash TEXT PRIMARY KEY, account_id INTEGER NOT NULL REFERENCES accounts(id),
  asset TEXT NOT NULL, amount_raw TEXT NOT NULL,
  paid_micro INTEGER NOT NULL, credit_micro INTEGER NOT NULL,   -- top-up 0%: credit = paid
  created_at INTEGER NOT NULL
);
-- Panen fee $GHOST per jam: 25% → TREASURY (pool pemegang), 75% → OWNER_WALLET
CREATE TABLE IF NOT EXISTS harvests (
  id INTEGER PRIMARY KEY,
  hour INTEGER NOT NULL,                    -- floor(unix/3600) saat panen dimulai
  claimed_wei TEXT NOT NULL, eth_usd REAL NOT NULL, usd_micro INTEGER NOT NULL,
  holder_wei TEXT NOT NULL, holder_micro INTEGER NOT NULL,      -- bagian pemegang (ke TREASURY)
  owner_wei TEXT NOT NULL, owner_micro INTEGER NOT NULL,
  claim_tx TEXT, txs TEXT NOT NULL,         -- JSON [{kind, txHash, to?, wei?}]
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS harvests_hour ON harvests(hour);
-- Ghost Credit: satu baris per jam yang sudah diproses
CREATE TABLE IF NOT EXISTS ledger_hours (
  hour INTEGER PRIMARY KEY,
  status TEXT NOT NULL,                     -- posted | pending | no_fees | no_holders
  fees_micro INTEGER NOT NULL DEFAULT 0,    -- bagian pemegang dari panen jam ini
  carry_in_micro INTEGER NOT NULL DEFAULT 0,
  pool_micro INTEGER NOT NULL DEFAULT 0,    -- fees + carry_in
  distributed_micro INTEGER NOT NULL DEFAULT 0,
  carry_out_micro INTEGER NOT NULL DEFAULT 0,
  entries INTEGER NOT NULL DEFAULT 0,
  root TEXT, uri_hash TEXT, file TEXT,
  fee_txs TEXT NOT NULL DEFAULT '[]',
  tx_hash TEXT, block_number INTEGER, error TEXT,
  created_at INTEGER NOT NULL, posted_at INTEGER
);
-- Kredit per dompet per jam (sumber kebenaran: data/ledger/hour-<n>.json)
CREATE TABLE IF NOT EXISTS credits (
  hour INTEGER NOT NULL, wallet TEXT NOT NULL,
  account_id INTEGER NOT NULL REFERENCES accounts(id),
  credit_micro INTEGER NOT NULL, created_at INTEGER NOT NULL,
  PRIMARY KEY (hour, wallet)
);
CREATE INDEX IF NOT EXISTS credits_wallet ON credits(wallet);
CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT NOT NULL);
`;

db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
db.exec(SCHEMA);
// migrasi: ID generasi OpenRouter per pemakaian (untuk struk yang bisa dicek ke catatan OpenRouter; bukan isi pesan)
if (!db.prepare("SELECT 1 FROM pragma_table_info('usage') WHERE name='gen_id'").get()) {
  db.exec('ALTER TABLE usage ADD COLUMN gen_id TEXT; CREATE INDEX IF NOT EXISTS usage_gen ON usage(gen_id);');
}

export const now = () => Date.now();
export const today = () => new Date().toISOString().slice(0, 10);

// Pembungkus transaksi: semua perubahan saldo wajib atomik. Aman dipanggil bersarang (pakai SAVEPOINT).
let depth = 0;
export function tx(fn) {
  const sp = `sp${depth}`;
  db.exec(depth === 0 ? 'BEGIN IMMEDIATE' : `SAVEPOINT ${sp}`);
  depth++;
  try {
    const r = fn();
    depth--;
    db.exec(depth === 0 ? 'COMMIT' : `RELEASE ${sp}`);
    return r;
  } catch (e) {
    depth--;
    db.exec(depth === 0 ? 'ROLLBACK' : `ROLLBACK TO ${sp}; RELEASE ${sp}`);
    throw e;
  }
}

export const q = {
  one: (sql, ...p) => db.prepare(sql).get(...p),
  all: (sql, ...p) => db.prepare(sql).all(...p),
  run: (sql, ...p) => db.prepare(sql).run(...p),
};

export function kvGet(k, d = null) {
  const r = q.one('SELECT v FROM kv WHERE k=?', k);
  if (!r) return d;
  try { return JSON.parse(r.v); } catch { return d; }
}
export function kvSet(k, v) {
  q.run('INSERT INTO kv(k,v) VALUES(?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v', k, JSON.stringify(v));
}

// Hitungan harian (pesan gratis per IP, pagu biaya gratis)
export function bumpDaily(key, count = 1, micro = 0) {
  q.run(`INSERT INTO daily_counters(day,key,count,micro) VALUES(?,?,?,?)
         ON CONFLICT(day,key) DO UPDATE SET count=count+excluded.count, micro=micro+excluded.micro`,
        today(), key, count, micro);
}
export function getDaily(key) {
  return q.one('SELECT count, micro FROM daily_counters WHERE day=? AND key=?', today(), key) || { count: 0, micro: 0 };
}

// Daftar tabel + kolom (dipakai /api/me/export sebagai bukti skema)
export function schemaColumns() {
  const out = {};
  for (const t of q.all("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name")) {
    out[t.name] = q.all(`PRAGMA table_info(${t.name})`).map((c) => c.name);
  }
  return out;
}
