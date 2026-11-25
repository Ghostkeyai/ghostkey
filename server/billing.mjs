// Saldo, penahanan biaya, isi saldo tanpa biaya (0%), dan jatah pesan gratis.
// Tidak ada diskon, cadangan, tier pemegang, atau fee platform: kredit = USD yang dibayar.
import { createHash, randomBytes } from 'node:crypto';
import { config, usdToMicro } from './config.mjs';
import { q, tx, now, bumpDaily, getDaily } from './db.mjs';

// ---------- Saldo akun ----------
export function available(accountId) {
  const r = q.one('SELECT balance_micro, held_micro FROM accounts WHERE id=?', accountId);
  return r ? r.balance_micro - r.held_micro : 0;
}

// Tahan dana sebelum memanggil model. Gagal kalau saldo bebas kurang.
export function hold(accountId, micro) {
  return tx(() => {
    if (available(accountId) < micro) return false;
    q.run('UPDATE accounts SET held_micro = held_micro + ? WHERE id=?', micro, accountId);
    return true;
  });
}

// Lepas tahanan, potong biaya sebenarnya (tak pernah di bawah nol), catat pemakaian. → saldo baru (mikro)
export function settle(accountId, heldMicro, costMicro, usage) {
  return tx(() => {
    const r = q.one('SELECT balance_micro FROM accounts WHERE id=?', accountId);
    const charge = Math.min(Math.max(0, costMicro), r.balance_micro);
    q.run('UPDATE accounts SET held_micro = MAX(0, held_micro - ?), balance_micro = balance_micro - ? WHERE id=?',
          heldMicro, charge, accountId);
    recordUsage({ ...usage, cost_micro: charge });
    return q.one('SELECT balance_micro FROM accounts WHERE id=?', accountId).balance_micro;
  });
}

export function release(accountId, heldMicro) {
  q.run('UPDATE accounts SET held_micro = MAX(0, held_micro - ?) WHERE id=?', heldMicro, accountId);
}

// Catatan pemakaian: model, token, biaya, waktu — tanpa isi pesan.
export function recordUsage(u) {
  q.run(`INSERT INTO usage(account_id,client_id,source,model,tokens_in,tokens_out,cost_micro,created_at)
         VALUES(?,?,?,?,?,?,?,?)`,
        u.account_id ?? null, u.client_id ?? null, u.source, u.model,
        u.tokens_in | 0, u.tokens_out | 0, u.cost_micro | 0, now());
}

// ---------- Pesan gratis ----------
// IP tidak pernah disimpan: kunci hitungan harian = hash IP dengan garam acak di memori (hilang saat restart).
const ipSalt = randomBytes(32).toString('hex');
const ipKey = (ip) => 'ip:' + createHash('sha256').update(ipSalt + String(ip)).digest('hex').slice(0, 20);

export const apiClientId = (accountId) => `acct${accountId}apifree0000`;
// Jatah harian pemegang: satu clientId per akun per hari UTC (web dan API terpisah) → hitungan otomatis reset 00:00 UTC
export const holderClientId = (accountId, kind) => `holder-${kind}-${accountId}-${new Date().toISOString().slice(0, 10).replace(/-/g, '')}`;
const isHolderCid = (c) => String(c || '').startsWith('holder-');

export function freeLeft(clientId, limit = config.freeMessages) {
  if (!clientId) return 0;
  const r = q.one('SELECT used FROM free_clients WHERE client_id=?', clientId);
  return Math.max(0, limit - (r?.used ?? 0));
}

// Boleh pakai jatah gratis? (per browser/akun, per IP harian, pagu biaya harian seluruh situs)
export function canUseFree(clientId, ip, limit = config.freeMessages) {
  if (!/^[a-zA-Z0-9_-]{16,64}$/.test(clientId || '')) return { ok: false, reason: 'no_client' };
  if (freeLeft(clientId, limit) <= 0) return { ok: false, reason: 'free_used' };
  // pemegang: tanpa batas per-IP, pagu biaya hariannya sendiri
  if (isHolderCid(clientId)) {
    if (getDaily('holder_total').micro >= usdToMicro(config.holderFreeDailyUsd)) return { ok: false, reason: 'free_paused' };
    return { ok: true };
  }
  if (getDaily(ipKey(ip)).count >= config.freePerIpDay) return { ok: false, reason: 'free_ip_limit' };
  if (getDaily('free_total').micro >= usdToMicro(config.freeDailyUsd)) return { ok: false, reason: 'free_paused' };
  return { ok: true };
}

export function consumeFree(clientId, ip, costMicro) {
  tx(() => {
    q.run(`INSERT INTO free_clients(client_id,used,created_at) VALUES(?,1,?)
           ON CONFLICT(client_id) DO UPDATE SET used=used+1`, clientId, now());
    if (isHolderCid(clientId)) { bumpDaily('holder_total', 1, costMicro); return; }
    bumpDaily(ipKey(ip), 1, costMicro);
    bumpDaily('free_total', 1, costMicro);
  });
}

// Jawaban kosong pada pesan gratis: biaya tetap dihitung ke anggaran harian, tapi jatah pengunjung tidak berkurang
export function bumpFreeCost(ip, costMicro, clientId) {
  if (isHolderCid(clientId)) return bumpDaily('holder_total', 0, costMicro);
  tx(() => { bumpDaily(ipKey(ip), 0, costMicro); bumpDaily('free_total', 0, costMicro); });
}

// ---------- Isi saldo (0% biaya) ----------
export function quoteCredit(paidMicro) {
  return { paidMicro, feeMicro: 0, creditMicro: paidMicro };
}

// Catat deposit terverifikasi secara atomik (tx_hash unik → tidak bisa dobel).
export function creditDeposit(accountId, dep) {
  return tx(() => {
    if (q.one('SELECT 1 FROM deposits WHERE tx_hash=?', dep.txHash)) return { error: 'already_credited' };
    const c = quoteCredit(dep.paidMicro);
    q.run(`INSERT INTO deposits(tx_hash,account_id,asset,amount_raw,paid_micro,credit_micro,created_at) VALUES(?,?,?,?,?,?,?)`,
          dep.txHash, accountId, dep.asset, String(dep.amountRaw), c.paidMicro, c.creditMicro, now());
    q.run('UPDATE accounts SET balance_micro = balance_micro + ? WHERE id=?', c.creditMicro, accountId);
    const bal = q.one('SELECT balance_micro FROM accounts WHERE id=?', accountId).balance_micro;
    return { ...c, balanceMicro: bal };
  });
}

// Bersihkan hitungan harian lama (kunci IP ter-hash tidak disimpan lebih dari 2 hari)
export function pruneDaily() {
  const cutoff = new Date(Date.now() - 2 * 86400_000).toISOString().slice(0, 10);
  q.run('DELETE FROM daily_counters WHERE day < ?', cutoff);
}
