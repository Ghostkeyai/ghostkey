// Masuk dengan dompet (personal_sign EIP-191, gratis tanpa gas) + sesi cookie `gk_s` + kunci API `gk_live_…`.
import { randomBytes, createHash } from 'node:crypto';
import { verifyMessage, getAddress } from 'ethers';
import { q, tx, now } from './db.mjs';
import { config } from './config.mjs';

const SESSION_DAYS = 30;
const MAX_KEYS = 5;
const sha = (s) => createHash('sha256').update(s).digest('hex');

export function normWallet(w) {
  try { return /^0x[0-9a-fA-F]{40}$/.test(String(w)) ? getAddress(String(w)).toLowerCase() : null; } catch { return null; }
}

// Ambil akun berdasarkan dompet; buat kalau belum ada (status 'pending' = dibuat oleh Ghost Credit).
export function ensureAccount(wallet, status = 'active') {
  const w = normWallet(wallet);
  if (!w) throw new Error('bad_wallet');
  let acc = q.one('SELECT * FROM accounts WHERE wallet=?', w);
  if (!acc) {
    q.run('INSERT INTO accounts(wallet, status, created_at) VALUES(?,?,?)', w, status, now());
    acc = q.one('SELECT * FROM accounts WHERE wallet=?', w);
  }
  return acc;
}

// Langkah 1: server membuat pesan sekali pakai untuk ditandatangani dompet.
export function makeNonce(wallet) {
  const w = normWallet(wallet);
  if (!w) return null;
  const host = new URL(config.publicUrl).host;
  const message = [
    `${host} wants you to sign in to GHOSTKEY with your wallet.`,
    '',
    'Signing is free and does not send a transaction.',
    '',
    `Wallet: ${getAddress(w)}`,
    `Nonce: ${randomBytes(12).toString('hex')}`,
    `Issued: ${new Date().toISOString()}`,
  ].join('\n');
  q.run(`INSERT INTO nonces(wallet,challenge,expires_at) VALUES(?,?,?)
         ON CONFLICT(wallet) DO UPDATE SET challenge=excluded.challenge, expires_at=excluded.expires_at`,
        w, message, now() + 10 * 60_000);
  return message;
}

// Langkah 2: cocokkan tanda tangan → buat akun (kalau baru) + sesi.
export function verifySignIn(wallet, signature) {
  const w = normWallet(wallet);
  if (!w) return { error: 'bad_wallet' };
  const row = q.one('SELECT challenge, expires_at FROM nonces WHERE wallet=?', w);
  if (!row || row.expires_at < now()) return { error: 'nonce_expired' };
  let signer;
  try { signer = verifyMessage(row.challenge, signature).toLowerCase(); } catch { return { error: 'bad_signature' }; }
  if (signer !== w) return { error: 'bad_signature' };
  q.run('DELETE FROM nonces WHERE wallet=?', w);

  const acc = tx(() => {
    const a = ensureAccount(w, 'active');
    if (a.status !== 'active') q.run("UPDATE accounts SET status='active' WHERE id=?", a.id); // akun Ghost Credit kini diaktifkan
    return q.one('SELECT * FROM accounts WHERE id=?', a.id);
  });
  const token = randomBytes(32).toString('base64url');
  q.run('INSERT INTO sessions(token,account_id,expires_at) VALUES(?,?,?)', token, acc.id, now() + SESSION_DAYS * 86400_000);
  return { account: acc, token };
}

export function sessionCookie(token, maxAgeSec = SESSION_DAYS * 86400) {
  return `gk_s=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSec}${config.cookieSecure ? '; Secure' : ''}`;
}

function cookieToken(req) {
  const m = (req.headers.cookie || '').match(/(?:^|;\s*)gk_s=([^;]+)/);
  return m ? m[1] : null;
}

export function accountFromSession(req) {
  const t = cookieToken(req);
  if (!t) return null;
  const s = q.one('SELECT account_id, expires_at FROM sessions WHERE token=?', t);
  if (!s || s.expires_at < now()) return null;
  return q.one('SELECT * FROM accounts WHERE id=?', s.account_id);
}

export function logout(req) {
  const t = cookieToken(req);
  if (t) q.run('DELETE FROM sessions WHERE token=?', t);
}

// ---------- Kunci API: hanya hash yang disimpan; kunci penuh tampil sekali ----------
// Batas belanja per kunci: label, batas harian USD (reset 00:00 UTC), tanggal kedaluwarsa.
// Belanja harian per kunci disimpan sebagai satu angka di daily_counters (bukan per pemakaian), dihapus setelah 2 hari.
export const MAX_KEY_CAP_USD = 10_000;
export const MAX_KEY_DAYS = 365;
export const keySpendKey = (keyId) => `keyspend:${keyId}`;
const keySpentMicro = (keyId) => q.one("SELECT micro FROM daily_counters WHERE day=? AND key=?", new Date().toISOString().slice(0, 10), keySpendKey(keyId))?.micro || 0;

// Rapikan masukan batas dari pengguna → { ok, label, capMicro, expiresAt } atau { error }
export function parseKeyLimits(b = {}, { partial = false } = {}) {
  const out = {};
  if (!partial || 'label' in b) {
    const label = String(b.label ?? '').replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, 40);
    out.label = label || null;
  }
  if (!partial || 'dailyCapUsd' in b) {
    const v = b.dailyCapUsd;
    if (v === null || v === undefined || v === '') out.capMicro = null;
    else {
      const n = Number(v);
      if (!Number.isFinite(n) || n < 0.01 || n > MAX_KEY_CAP_USD) return { error: 'bad_cap', min: 0.01, max: MAX_KEY_CAP_USD };
      out.capMicro = Math.round(n * 1e6);
    }
  }
  if (!partial || 'expiresInDays' in b || 'expiresAt' in b) {
    if ('expiresAt' in b && b.expiresAt != null && b.expiresAt !== '') {
      const t = Number(b.expiresAt);
      if (!Number.isFinite(t) || t <= now() || t > now() + MAX_KEY_DAYS * 86400_000) return { error: 'bad_expiry', maxDays: MAX_KEY_DAYS };
      out.expiresAt = Math.floor(t);
    } else if (b.expiresInDays != null && b.expiresInDays !== '') {
      const d = Number(b.expiresInDays);
      if (!Number.isFinite(d) || d <= 0 || d > MAX_KEY_DAYS) return { error: 'bad_expiry', maxDays: MAX_KEY_DAYS };
      out.expiresAt = now() + Math.round(d * 86400_000);
    } else out.expiresAt = null;
  }
  return { ok: true, ...out };
}

const keyView = (k) => ({
  prefix: k.prefix, createdAt: k.created_at, label: k.label || null,
  dailyCapUsd: k.daily_cap_micro == null ? null : k.daily_cap_micro / 1e6,
  spentTodayUsd: keySpentMicro(k.id) / 1e6,
  expiresAt: k.expires_at || null,
  expired: !!(k.expires_at && k.expires_at <= now()),
});

export function listApiKeys(accountId) {
  return q.all('SELECT * FROM api_keys WHERE account_id=? AND revoked_at IS NULL ORDER BY id', accountId).map(keyView);
}

export function createApiKey(accountId, limits = {}) {
  const lim = parseKeyLimits(limits);
  if (lim.error) return lim;
  const n = q.one('SELECT COUNT(*) n FROM api_keys WHERE account_id=? AND revoked_at IS NULL', accountId).n;
  if (n >= MAX_KEYS) return { error: 'too_many_keys', max: MAX_KEYS };
  const key = `gk_live_${randomBytes(24).toString('base64url')}`;
  const prefix = key.slice(0, 14);
  q.run('INSERT INTO api_keys(account_id,key_hash,prefix,created_at,label,daily_cap_micro,expires_at) VALUES(?,?,?,?,?,?,?)',
    accountId, sha(key), prefix, now(), lim.label, lim.capMicro, lim.expiresAt);
  return { apiKey: key, prefix, key: keyView(q.one('SELECT * FROM api_keys WHERE key_hash=?', sha(key))) };
}

// Ubah batas kunci yang sudah ada (hanya kolom yang dikirim)
export function updateApiKey(accountId, prefix, body = {}) {
  const k = q.one('SELECT * FROM api_keys WHERE account_id=? AND prefix=? AND revoked_at IS NULL', accountId, String(prefix || ''));
  if (!k) return { error: 'not_found' };
  const lim = parseKeyLimits(body, { partial: true });
  if (lim.error) return lim;
  q.run('UPDATE api_keys SET label=?, daily_cap_micro=?, expires_at=? WHERE id=?',
    'label' in lim ? lim.label : k.label,
    'capMicro' in lim ? lim.capMicro : k.daily_cap_micro,
    'expiresAt' in lim ? lim.expiresAt : k.expires_at, k.id);
  return { ok: true, key: keyView(q.one('SELECT * FROM api_keys WHERE id=?', k.id)) };
}

export function revokeApiKey(accountId, prefix) {
  const r = q.run('UPDATE api_keys SET revoked_at=? WHERE account_id=? AND prefix=? AND revoked_at IS NULL', now(), accountId, String(prefix || ''));
  return r.changes > 0;
}

// Bearer gk_live_… → { account, key } | { error: 'invalid_api_key' | 'key_expired' }
export function resolveBearer(req) {
  const m = (req.headers.authorization || '').match(/^Bearer\s+(gk_live_[A-Za-z0-9_\-]+)$/);
  if (!m) return { error: 'invalid_api_key' };
  const k = q.one('SELECT * FROM api_keys WHERE key_hash=? AND revoked_at IS NULL', sha(m[1]));
  if (!k) return { error: 'invalid_api_key' };
  if (k.expires_at && k.expires_at <= now()) return { error: 'key_expired', expiredAt: k.expires_at };
  const account = q.one('SELECT * FROM accounts WHERE id=?', k.account_id);
  if (!account) return { error: 'invalid_api_key' };
  return { account, key: { id: k.id, prefix: k.prefix, capMicro: k.daily_cap_micro, spentMicro: keySpentMicro(k.id) } };
}
export const accountFromBearer = (req) => resolveBearer(req).account || null;
