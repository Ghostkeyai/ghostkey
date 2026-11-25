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
export function listApiKeys(accountId) {
  return q.all('SELECT prefix, created_at FROM api_keys WHERE account_id=? AND revoked_at IS NULL ORDER BY id', accountId)
    .map((k) => ({ prefix: k.prefix, createdAt: k.created_at }));
}

export function createApiKey(accountId) {
  const n = q.one('SELECT COUNT(*) n FROM api_keys WHERE account_id=? AND revoked_at IS NULL', accountId).n;
  if (n >= MAX_KEYS) return { error: 'too_many_keys', max: MAX_KEYS };
  const key = `gk_live_${randomBytes(24).toString('base64url')}`;
  const prefix = key.slice(0, 14);
  q.run('INSERT INTO api_keys(account_id,key_hash,prefix,created_at) VALUES(?,?,?,?)', accountId, sha(key), prefix, now());
  return { apiKey: key, prefix };
}

export function revokeApiKey(accountId, prefix) {
  const r = q.run('UPDATE api_keys SET revoked_at=? WHERE account_id=? AND prefix=? AND revoked_at IS NULL', now(), accountId, String(prefix || ''));
  return r.changes > 0;
}

// Bearer gk_live_… → akun, atau null
export function accountFromBearer(req) {
  const m = (req.headers.authorization || '').match(/^Bearer\s+(gk_live_[A-Za-z0-9_\-]+)$/);
  if (!m) return null;
  const k = q.one('SELECT account_id FROM api_keys WHERE key_hash=? AND revoked_at IS NULL', sha(m[1]));
  return k ? q.one('SELECT * FROM accounts WHERE id=?', k.account_id) : null;
}
