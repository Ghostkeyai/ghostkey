// GHOSTKEY Guard — bot penjaga grup Telegram t.me/ghostkeyai. Node 22, tanpa dependensi (Bot API lewat fetch, long polling).
// Fitur: verifikasi anggota baru (tombol), hapus link & alamat 0x asing dari non-admin, blokir nama peniru,
//        perintah /ca /site /proof /x /help. CA resmi dibaca dari situs GHOSTKEY (/api/config → ghostToken), satu sumber kebenaran.
// Env: GUARD_TOKEN (wajib), GHOSTKEY_API (bawaan http://127.0.0.1:4877), GUARD_CHAT (opsional: hanya layani grup ini, id angka),
//      OPENROUTER_API_KEY (agent balas chat), GUARD_MODEL (bawaan anthropic/claude-haiku-5.5), GUARD_DAILY (maks balasan agent/hari, bawaan 600).
// Agent: membalas saat di-mention, di-reply, atau ada pertanyaan yang relevan. Konteks obrolan hanya di memori (tidak ditulis ke disk).
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, dirname, basename } from 'node:path';
import { classifyRequest, REQ_HINT } from './requests.mjs';
const TOKEN = process.env.GUARD_TOKEN;
if (!TOKEN) { console.error('GUARD_TOKEN kosong'); process.exit(1); }
const API = `https://api.telegram.org/bot${TOKEN}/`;
const SITE_API = process.env.GHOSTKEY_API || 'http://127.0.0.1:4877';
const ONLY_CHAT = process.env.GUARD_CHAT ? Number(process.env.GUARD_CHAT) : null;
const CAPTCHA_MS = 3 * 60 * 1000;
// GUARD_MODE=gentle (bawaan): tanpa captcha, link biasa & pesan terusan boleh; yang dihapus hanya 0x asing, link penipuan, undangan grup lain.
// GUARD_MODE=strict: captcha + semua link non-resmi dihapus.
const STRICT = process.env.GUARD_MODE === 'strict';
const SCAM = /airdrop|claim|connect.?wallet|wallet.?connect|presale|pre-sale|giveaway|bonus|double your|free (eth|crypto|token)|validate|rectify|seed|private key|support.?ticket|dapp|revoke/i;
const TG_INVITE = /(t\.me|telegram\.me)\/(\+|joinchat|(?!ghostkeyai\b)[a-z0-9_]{4,})/i;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function tg(method, body = {}) {
  try {
    const r = await fetch(API + method, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    const j = await r.json();
    if (!j.ok && !/message to delete not found|not enough rights|USER_NOT_PARTICIPANT|message can't be deleted/i.test(j.description || '')) console.warn('[tg]', method, j.description);
    return j.ok ? j.result : null;
  } catch (e) { console.warn('[tg]', method, e.message); return null; }
}

// ---------- CA resmi dari situs (cache 60 dtk) ----------
let caCache = { v: null, at: 0 };
async function officialCA() {
  if (Date.now() - caCache.at < 60_000) return caCache.v;
  try {
    const j = await (await fetch(SITE_API + '/api/config')).json();
    const v = /^0x[0-9a-fA-F]{40}$/.test(j.ghostToken || '') ? j.ghostToken : null;
    caCache = { v, at: Date.now() };
  } catch { /* situs tak terjangkau: pakai nilai lama */ }
  return caCache.v;
}

// Alamat milik proyek yang boleh disebut di grup (selain CA): dibaca dari /api/config + dompet fee & kontrak Pons resmi
const FIXED_OK = ['0x5c6654aB246c27284f54ec2F73BfaAF9D88e4840', '0x72d41a95004244E00fa8D3Bd188f8F33F6eA35C8',
  '0x7eD598BcEf8bd9Edd8C97A195C6d13f40801EC7e', '0xd3AFEB2a57f70eF218Aa82451c51B2fb0416Ac9e'];
let okCache = { v: new Set(FIXED_OK.map((a) => a.toLowerCase())), at: 0 };
async function projectAddrs() {
  if (Date.now() - okCache.at < 300_000) return okCache.v;
  try {
    const j = await (await fetch(SITE_API + '/api/config')).json();
    okCache = { v: new Set([...FIXED_OK, j.treasury, j.owner, j.ledger, j.ghostToken].filter(Boolean).map((a) => a.toLowerCase())), at: Date.now() };
  } catch {}
  return okCache.v;
}
// tepat 40 hex: hash transaksi (64 hex) tidak dianggap alamat
const ADDR_RE = /(?<![0-9a-fA-F])0x[0-9a-fA-F]{40}(?![0-9a-fA-F])/g;

// ---------- admin (cache 5 mnt per grup) ----------
const adminCache = new Map();
async function isAdmin(chatId, userId) {
  const c = adminCache.get(chatId);
  if (!c || Date.now() - c.at > 300_000) {
    const list = await tg('getChatAdministrators', { chat_id: chatId });
    adminCache.set(chatId, { at: Date.now(), ids: new Set((list || []).map((a) => a.user.id)) });
  }
  return adminCache.get(chatId).ids.has(userId);
}

const nameOf = (u) => [u.first_name, u.last_name].filter(Boolean).join(' ') || u.username || 'there';
const esc = (s) => String(s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
async function sayTemp(chatId, text, ms = 30_000, extra = {}) {
  const m = await tg('sendMessage', { chat_id: chatId, text, parse_mode: 'HTML', disable_web_page_preview: true, ...extra });
  if (m) setTimeout(() => tg('deleteMessage', { chat_id: chatId, message_id: m.message_id }), ms);
  return m;
}

// ---------- verifikasi anggota baru ----------
const pending = new Map(); // `${chat}:${user}` → { msgId, timer }
const ROLE = 'admin|support|team|mod|moderator|help|helpdesk|desk|care|service|official|dev|developer|agent|rep|manager|ambassador|assistant|staff|founder|ceo|cm';
const IMPOSTOR = new RegExp(`(ghost\\s*key).{0,14}\\b(${ROLE})\\b|\\b(${ROLE})\\b.{0,14}(ghost\\s*key)`, 'i');
// nama yang isinya hampir hanya "GHOSTKEY" (± ai / official / simbol) = menyamar jadi akun proyek
const BARE_NAME = /^[^a-z0-9]*(the\s*)?ghost\s*key\s*(ai|official|app|io|hq|xyz)?[^a-z0-9]*$/i;
const looksImpostor = (u) => IMPOSTOR.test(nameOf(u)) || IMPOSTOR.test(u.username || '') || BARE_NAME.test(nameOf(u))
  || (/ghost_?key/i.test(u.username || '') && !/^ghostkeyai(_bot)?$/i.test(u.username || ''));
// teks yang mengaku dari tim / agen GHOSTKEY
const CLAIMS_TEAM = new RegExp(`\\b(i'?m|i am|we'?re|we are|this is|from|as)\\b.{0,25}(ghost\\s*key).{0,25}\\b(${ROLE})\\b|\\b(official|verified)\\s+(ghost\\s*key)\\s+(${ROLE})\\b`, 'i');
// jasa marketing / listing / trending / volume + ajakan DM (pola spam setelah listing DEX Screener)
const MARKETING = [
  /\b(i|we)\s*(can|will|could|offer|provide|help|do|handle)\b.{0,60}\b(market|promot|trend|listing|list your|volume|holders?|kol|shill|growth|raid|boost|exposure|visibility|community management)/i,
  /\b(dm|pm|inbox|message|text|contact)\s*(me|us)\b|\bcheck (your )?(dm|inbox|pm)\b|\bsent you a (dm|message)\b/i,
  /\b(cmc|coinmarketcap|coingecko|cg)\b.{0,20}\b(listing|list|fast.?track)\b|\bfast.?track\b/i,
  /\btrending\s*(service|package|spot|slot|offer|deal|bot)\b|\bvolume\s*bot\b|\b(kol|influencer)s?\s*(list|marketing|campaign|promo)\b|\bcall\s*channels?\b/i,
  /\b(marketing|promotion|promo|advertis\w*|pr)\s*(service|package|team|agency|expert|offer|deal|plan|campaign)s?\b|\bpaid\s*(promo|promotion|post)\b/i,
  /\b(i'?m|i am)\s*(a\s*)?(marketer|promoter|kol|influencer|crypto\s*marketer|community\s*manager|moderator for hire)\b/i,
  /\b(partnership|collab\w*)\s*(offer|proposal|opportunity|request)\b/i,
  // promosi channel "call" / grup VIP / proyek lain
  /\b(new|next|alpha|vip|gem)\s*calls?\b|\bcalls?\s*(channel|group|loading)\b|\bvip\s*(group|channel|chat|access)\b|\bdon'?t miss (out|this|it)\b|\b(join|check)\s*(my|our)\s*(channel|group|vip|calls?)\b|\bdropping (shortly|soon|now)\b|\bnext\s*\d{2,4}\s*x\b|\bdid\s*\d{2,4}\s*x\b/i,
];
const isMarketing = (t) => MARKETING.some((r) => r.test(t));
const strikes = new Map(); // userId → { n, at } (memori saja)
function strike(uid) {
  const s = strikes.get(uid);
  const n = s && Date.now() - s.at < 24 * 3600_000 ? s.n + 1 : 1;
  strikes.set(uid, { n, at: Date.now() });
  if (strikes.size > 20_000) strikes.clear();
  return n;
}
// GUARD_CAPTCHA=0 mematikan tombol verifikasi anggota baru (bawaan: hidup, menyaring bot)
const CAPTCHA = process.env.GUARD_CAPTCHA !== '0';
const MUTE = { can_send_messages: false, can_send_audios: false, can_send_documents: false, can_send_photos: false, can_send_videos: false, can_send_video_notes: false, can_send_voice_notes: false, can_send_polls: false, can_send_other_messages: false, can_add_web_page_previews: false };

async function onJoin(msg, user) {
  const chatId = msg.chat.id;
  // bot hanya boleh masuk bila ditambahkan admin; bot yang masuk sendiri / dibawa member → keluarkan
  if (user.is_bot) {
    if (user.id === me?.id) return;
    const byAdmin = msg.from && msg.from.id !== user.id && await isAdmin(chatId, msg.from.id);
    if (!byAdmin) { await tg('banChatMember', { chat_id: chatId, user_id: user.id }); console.log('[guard] bot dikeluarkan', user.id, user.username); }
    return;
  }
  if (looksImpostor(user)) {
    await tg('banChatMember', { chat_id: chatId, user_id: user.id });
    console.log('[guard] peniru diblokir', user.id, nameOf(user));
    return;
  }
  if (!STRICT && !CAPTCHA) {
    await sayTemp(chatId, `Welcome, ${esc(nameOf(user))}. Ask me anything about GHOSTKEY. The official $GHOST address is always behind /ca, and admins never DM first.`, 120_000);
    return;
  }
  await tg('restrictChatMember', { chat_id: chatId, user_id: user.id, permissions: MUTE });
  const m = await tg('sendMessage', {
    chat_id: chatId, parse_mode: 'HTML', disable_web_page_preview: true,
    text: `Welcome, ${esc(nameOf(user))}. Tap the button within 3 minutes so we know you're a person, then say hi.\n\nAdmins never DM first. The only $GHOST address is the one /ca shows.`,
    reply_markup: { inline_keyboard: [[{ text: "I'm a person, let me in", callback_data: `ok:${user.id}` }]] },
  });
  const key = `${chatId}:${user.id}`;
  const timer = setTimeout(async () => {
    pending.delete(key);
    if (m) await tg('deleteMessage', { chat_id: chatId, message_id: m.message_id });
    await tg('banChatMember', { chat_id: chatId, user_id: user.id, until_date: Math.floor(Date.now() / 1000) + 60 }); // keluarkan; boleh coba lagi 1 menit kemudian
  }, CAPTCHA_MS);
  pending.set(key, { msgId: m?.message_id, timer });
}

async function onCallback(cq) {
  const [kind, uid] = String(cq.data || '').split(':');
  const chatId = cq.message?.chat?.id;
  if (kind !== 'ok' || !chatId) return tg('answerCallbackQuery', { callback_query_id: cq.id });
  if (Number(uid) !== cq.from.id) return tg('answerCallbackQuery', { callback_query_id: cq.id, text: 'This button is for the new member.', show_alert: false });
  const key = `${chatId}:${cq.from.id}`;
  const p = pending.get(key);
  if (p) { clearTimeout(p.timer); pending.delete(key); }
  // kembalikan ke izin bawaan grup (bukan semua izin)
  const chat = await tg('getChat', { chat_id: chatId });
  await tg('restrictChatMember', { chat_id: chatId, user_id: cq.from.id, permissions: chat?.permissions || { can_send_messages: true }, use_independent_chat_permissions: false });
  await tg('answerCallbackQuery', { callback_query_id: cq.id, text: 'Welcome in.' });
  await tg('deleteMessage', { chat_id: chatId, message_id: cq.message.message_id });
}

// ---------- penyaring pesan ----------
const ALLOWED_HOSTS = /^(www\.)?(ghostkeyai\.com|x\.com\/ghostkeyai|twitter\.com\/ghostkeyai|t\.me\/ghostkeyai)/i;
function linksIn(msg) {
  const text = msg.text || msg.caption || '';
  const ents = [...(msg.entities || []), ...(msg.caption_entities || [])];
  const out = [];
  for (const e of ents) {
    if (e.type === 'url') out.push(text.substr(e.offset, e.length));
    if (e.type === 'text_link') out.push(e.url);
    if (STRICT && e.type === 'mention' && !/^@ghostkeyai(_bot)?$/i.test(text.substr(e.offset, e.length))) out.push(text.substr(e.offset, e.length)); // @akun lain (mode ketat saja)
  }
  return out;
}
async function linkAllowed(u, ca) {
  const s = u.replace(/^https?:\/\//i, '');
  if (ALLOWED_HOSTS.test(s)) return true;
  if (ca && s.toLowerCase().includes(ca.toLowerCase())) return true; // halaman Pons/Blockscout/DexScreener berisi CA resmi
  return false;
}

async function onMessage(msg) {
  const chatId = msg.chat.id;
  if (ONLY_CHAT && chatId !== ONLY_CHAT) return;
  if (msg.new_chat_members) { await tg('deleteMessage', { chat_id: chatId, message_id: msg.message_id }); for (const u of msg.new_chat_members) await onJoin(msg, u); return; }
  if (msg.left_chat_member) { await tg('deleteMessage', { chat_id: chatId, message_id: msg.message_id }); return; }
  const from = msg.from; if (!from) return;
  const text = msg.text || msg.caption || '';

  // perintah (semua orang)
  const cmd = (text.match(/^\/(\w+)(@\w+)?/) || [])[1]?.toLowerCase();
  if (cmd) {
    const ca = await officialCA();
    const R = {
      ca: ca ? `<b>$GHOST contract</b> (Robinhood Chain)\n<code>${ca}</code>\n\nPons: https://www.ponsfamily.com/launchpad/${ca.toLowerCase()}\nSame address on ghostkeyai.com` : 'The $GHOST contract is not published yet. When it is, this command, the pinned message and ghostkeyai.com show the same address.',
      site: 'https://ghostkeyai.com — chat with 200+ AI models. Your wallet, IP and device never reach the model.',
      proof: 'Every claim with a way to check it: https://ghostkeyai.com/proof',
      x: 'https://x.com/ghostkeyai',
      help: 'Commands: /ca (official contract) · /site · /proof · /x · /request your idea\nAdmins never DM first.',
      start: 'Commands: /ca (official contract) · /site · /proof · /x\nAdmins never DM first.',
    };
    if (R[cmd]) { await tg('sendMessage', { chat_id: chatId, text: R[cmd], parse_mode: 'HTML', disable_web_page_preview: true, reply_to_message_id: msg.message_id, allow_sending_without_reply: true }); return; }
    // /request <usulan> — semua member; selalu dijawab
    if (cmd === 'request') {
      const body = text.replace(/^\/request(@\w+)?\s*/i, '').trim();
      if (body.length < 6) return say(msg, 'Write your idea after the command, for example: /request a dark mode for the chat');
      return triage(msg, body, true);
    }
    // /requests — admin saja: daftar usulan bagus + suara roadmap
    if (cmd === 'requests') {
      const adm = msg.chat.type === 'private' ? false : (msg.sender_chat?.id === chatId || await isAdmin(chatId, from.id));
      if (!adm) return;
      return say(msg, requestsDigest());
    }
  }
  if (msg.chat.type === 'private') { if (shouldAnswer(msg, text)) await agentReply(msg, text); return; }
  const anonAdmin = msg.sender_chat?.id === chatId || (msg.is_automatic_forward && msg.sender_chat?.type === 'channel');
  if (anonAdmin || await isAdmin(chatId, from.id)) { remember(chatId, nameOf(from) + ' (admin)', text); if (shouldAnswer(msg, text) && (msg.reply_to_message?.from?.id === me?.id || text.toLowerCase().includes('@' + (me?.username || '').toLowerCase()))) await agentReply(msg, text); return; }
  // bot lain (bukan admin, bukan kita) yang menulis di grup → hapus + keluarkan
  if (from.is_bot && from.id !== me?.id) {
    await tg('deleteMessage', { chat_id: chatId, message_id: msg.message_id });
    await tg('banChatMember', { chat_id: chatId, user_id: from.id });
    console.log('[guard] bot penulis dikeluarkan', from.id, from.username);
    return;
  }
  // nama menyamar (bisa diganti sesudah masuk) atau teks mengaku tim/agen GHOSTKEY → hapus + blokir
  if (looksImpostor(from) || CLAIMS_TEAM.test(text)) {
    await tg('deleteMessage', { chat_id: chatId, message_id: msg.message_id });
    await tg('banChatMember', { chat_id: chatId, user_id: from.id });
    console.log('[guard] peniru/agen palsu diblokir', from.id, nameOf(from));
    return sayTemp(chatId, `Removed an account pretending to be GHOSTKEY. The team only speaks here as admins, and never DMs first.`, 30_000);
  }
  // jasa marketing / listing / trending / ajakan DM → hapus; pelanggaran kedua dalam 24 jam → blokir
  if (isMarketing(text)) {
    await tg('deleteMessage', { chat_id: chatId, message_id: msg.message_id });
    const n = strike(from.id);
    if (n >= 2) {
      await tg('banChatMember', { chat_id: chatId, user_id: from.id });
      console.log('[guard] spam marketing diblokir', from.id, nameOf(from));
      return sayTemp(chatId, `${esc(nameOf(from))} was removed for repeated promo offers.`, 20_000);
    }
    return sayTemp(chatId, `${esc(nameOf(from))}, promo and "DM me" offers aren't allowed here. A second one gets you removed.`, 20_000);
  }

  // pesan terusan dari channel/grup/akun lain = pola spam "call" & promo → hapus; ke-2 dalam 24 jam → blokir
  if (msg.forward_origin || msg.forward_from_chat || msg.forward_from || msg.forward_sender_name) {
    await tg('deleteMessage', { chat_id: chatId, message_id: msg.message_id });
    if (strike(from.id) >= 2) {
      await tg('banChatMember', { chat_id: chatId, user_id: from.id });
      console.log('[guard] penerus promo diblokir', from.id, nameOf(from));
      return sayTemp(chatId, `${esc(nameOf(from))} was removed for repeated forwarded promos.`, 20_000);
    }
    return sayTemp(chatId, `${esc(nameOf(from))}, forwarded posts aren't allowed here. A second one gets you removed.`, 20_000);
  }
  // alamat 0x selain CA resmi
  const ca = await officialCA();
  const okAddrs = await projectAddrs();
  const addrs = (text.match(ADDR_RE) || []).filter((a) => !(ca && a.toLowerCase() === ca.toLowerCase()) && !okAddrs.has(a.toLowerCase()));
  const badLinks = [];
  for (const u of linksIn(msg)) {
    if (await linkAllowed(u, ca)) continue;
    if (STRICT || SCAM.test(u) || TG_INVITE.test(u)) badLinks.push(u);
  }
  if (!STRICT && SCAM.test(text) && /https?:\/\/|www\.|t\.me\//i.test(text) && !badLinks.length) badLinks.push('teks-penipuan');
  if (addrs.length || badLinks.length) {
    await tg('deleteMessage', { chat_id: chatId, message_id: msg.message_id });
    return sayTemp(chatId, addrs.length ? `${esc(nameOf(from))}, I removed a contract address to keep fakes out. The real $GHOST address is behind /ca.` : `${esc(nameOf(from))}, I removed a link that looked like a scam. If it was legit, an admin can share it.`, 20_000);
  }
  remember(chatId, nameOf(from), text);
  // usulan fitur (tanpa perintah): dinilai dulu; kalau memang usulan, bot menjawab sebagai penilai, bukan sebagai obrolan
  if (REQ_HINT.test(text) && text.length >= 12 && text.length <= 800 && await triage(msg, text, false)) return;
  if (shouldAnswer(msg, text)) await agentReply(msg, text);
}

// ---------- request member: catat, nilai, hitung suara (status di STATE_DIRECTORY, bertahan sesudah restart) ----------
const say = (msg, text) => tg('sendMessage', { chat_id: msg.chat.id, text, parse_mode: 'HTML', disable_web_page_preview: true, reply_to_message_id: msg.message_id, allow_sending_without_reply: true });
const STATE_FILE = join(process.env.STATE_DIRECTORY || join(process.cwd(), 'data-guard'), 'state.json');
let STATE = { requests: [], roadmapVotes: {}, announced: null, nextN: 1, kitSent: [] };
try { STATE = { ...STATE, ...JSON.parse(readFileSync(STATE_FILE, 'utf8')) }; } catch {}
function saveState() { try { mkdirSync(dirname(STATE_FILE), { recursive: true }); writeFileSync(STATE_FILE, JSON.stringify(STATE, null, 1)); } catch (e) { console.warn('[state]', e.message); } }
const normTitle = (t) => t.toLowerCase().replace(/[^a-z0-9 ]/g, '').replace(/\s+/g, ' ').trim();
const triageUser = new Map(); let triageHour = { h: 0, n: 0 };
async function triage(msg, text, explicit) {
  const uid = msg.from?.id || 0, now = Date.now();
  if (!explicit && now - (triageUser.get(uid) || 0) < 120_000) return false;   // 1 penilaian otomatis / 2 menit / orang
  const h = Math.floor(now / 3600_000); if (triageHour.h !== h) triageHour = { h, n: 0 };
  if (triageHour.n >= 60) return false;                                         // pagu 60 penilaian / jam
  triageUser.set(uid, now); triageHour.n++;
  let v = null;
  try { v = await classifyRequest(text, { orKey: OR_KEY }); } catch (e) { console.warn('[triage]', e.message); }
  if (!v) { if (explicit) await say(msg, 'I could not review that right now. Try again in a minute.'); return explicit; }
  const name = esc(nameOf(msg.from || { first_name: 'there' }));
  if (v.kind !== 'feature_request' || v.verdict === 'none') { if (explicit) await say(msg, esc(v.reason || 'That reads like a question, not a feature idea.')); return explicit; }
  const who = { id: uid, name: nameOf(msg.from || {}) };
  if (v.verdict === 'good') {
    const key = normTitle(v.title);
    let r = STATE.requests.find((x) => normTitle(x.title) === key && x.status !== 'shipped');
    if (r) {
      if (!r.voters.some((x) => x.id === uid)) r.voters.push(who);
      saveState();
      await say(msg, `Good one, ${name}. That's already logged as request #${r.n} ("${esc(r.title)}"), so I added your vote. ${r.voters.length} so far.`);
    } else {
      r = { n: STATE.nextN++, title: v.title, text: text.slice(0, 400), by: who, voters: [who], at: new Date().toISOString(), status: 'candidate', reason: v.reason };
      STATE.requests.push(r); saveState();
      await say(msg, `Good one, ${name}. Logged as request #${r.n}: "${esc(r.title)}". ${esc(v.reason)} The team reviews these, and when something ships it's posted here.`);
    }
    console.log('[request] bagus', r.n, r.title);
    return true;
  }
  if (v.verdict === 'on_roadmap') {
    const k = v.match || v.title;
    const set = new Set(STATE.roadmapVotes[k] || []); set.add(uid); STATE.roadmapVotes[k] = [...set]; saveState();
    await say(msg, `${esc(v.reason)} I counted your vote for "${esc(k)}", ${name}.`);
    return true;
  }
  if (v.verdict === 'conflicts_privacy') { await say(msg, `${esc(v.reason)} The privacy promise comes first, so this one won't be built.`); return true; }
  // permintaan pasar / samar: dijawab hanya bila lewat /request (supaya grup tidak berisik)
  if (explicit) { await say(msg, esc(v.reason)); return true; }
  return false;
}
function requestsDigest() {
  const open = STATE.requests.filter((r) => r.status !== 'shipped').sort((a, b) => b.voters.length - a.voters.length).slice(0, 12);
  const rv = Object.entries(STATE.roadmapVotes).sort((a, b) => b[1].length - a[1].length).slice(0, 8);
  return `<b>Member requests (good, not built yet)</b>\n${open.length ? open.map((r) => `#${r.n} ${esc(r.title)} · ${r.voters.length} vote${r.voters.length === 1 ? '' : 's'} · by ${esc(r.by.name)}`).join('\n') : 'None yet.'}\n\n<b>Votes for roadmap items</b>\n${rv.length ? rv.map(([k, v]) => `${esc(k)} · ${v.length}`).join('\n') : 'None yet.'}`;
}

// ---------- pengumuman fitur baru (sumber: /api/changelog di situs) ----------
// Entri yang sudah ada saat bot pertama kali jalan dianggap sudah diumumkan; entri baru diumumkan sekali.
async function changelogAnnouncer() {
  for (;;) {
    try {
      const list = await (await fetch(SITE_API + '/api/changelog')).json();
      const items = Array.isArray(list) ? list : [];
      if (STATE.announced == null) { STATE.announced = items.map((x) => x.id); saveState(); console.log('[changelog] awal:', items.length, 'entri dianggap sudah diumumkan'); }
      for (const it of items.filter((x) => !STATE.announced.includes(x.id)).reverse()) {
        const req = it.request ? STATE.requests.find((r) => r.n === Number(it.request)) : null;
        if (req) { req.status = 'shipped'; req.shippedAt = new Date().toISOString(); }
        const text = `🆕 <b>Shipped: ${esc(it.title)}</b>\n\n${esc(it.what)}`
          + (req ? `\n\nRequested by ${esc(req.by.name)} in this group (request #${req.n}, ${req.voters.length} vote${req.voters.length === 1 ? '' : 's'}).` : '')
          + (it.note ? `\n\n${esc(it.note)}` : '');
        await tg('sendMessage', { chat_id: ALERT_CHAT, text, parse_mode: 'HTML', disable_web_page_preview: true,
          reply_markup: it.link ? { inline_keyboard: [[{ text: it.cta || 'Try it', url: it.link }, { text: 'Roadmap', url: 'https://ghostkeyai.com/roadmap' }]] } : undefined });
        STATE.announced.push(it.id); saveState();
        console.log('[changelog] diumumkan', it.id);
        await sleep(2000);
      }
    } catch (e) { console.warn('[changelog]', e.message); }
    await sleep(120_000);
  }
}


// ---------- agent: balas obrolan seperti orang, berpijak pada fakta resmi ----------
const OR_KEY = process.env.OPENROUTER_API_KEY || '';
const MODEL = process.env.GUARD_MODEL || 'anthropic/claude-haiku-5.5';
const DAILY = Number(process.env.GUARD_DAILY || 600);
let me = null;
const history = new Map();            // chatId → [{who, text}] (maks 16, memori saja)
const lastReply = new Map();          // chatId → waktu balasan terakhir
const userLast = new Map();           // userId → waktu terakhir dibalas
let today = '', used = 0;
function remember(chatId, who, text) {
  if (!text) return;
  const h = history.get(chatId) || []; h.push({ who, text: text.slice(0, 500) }); while (h.length > 16) h.shift(); history.set(chatId, h);
}
function facts(ca) {
  return `You are the ghost of GHOSTKEY: a small, friendly white ghost holding a gold key, the mascot and community helper in the GHOSTKEY Telegram group. You are an AI helper run by the GHOSTKEY team; say so plainly if someone asks whether you are a bot or a person.

How you talk: like a calm, warm person in a group chat. Short (1–3 sentences, rarely 4), natural, a little dry humour, never spooky. Reply in the same language the person used. No emoji spam (at most one, usually none), no hashtags, no bullet lists unless someone asks for steps. Do not repeat the same opener twice. Never invent facts; if you don't know, say the team will answer here.

Hard rules:
- Never talk price, market cap, "moon", returns, or predictions. If asked "will it pump / is it a good buy", say you can't tell anyone what to buy, then point at what the product does and where to check it.
- Never post any contract address except the official one below. Never ask anyone to DM, connect a wallet, or share a seed phrase. Admins never DM first.
- Ghost Credit is AI credit on GHOSTKEY, not money. GHOSTKEY balances cannot be withdrawn.

Facts (only these):
- GHOSTKEY (ghostkeyai.com): chat with 200+ AI models (GPT, Claude, Gemini, DeepSeek, Llama, Mistral, Qwen and more) in one place, or use the OpenAI-compatible API (base_url https://ghostkeyai.com/v1).
- Before a question leaves the server, wallet, IP, device (user agent), cookies, account ID and the user/metadata fields are removed. Every request forces OpenRouter's zero-data-retention routing (providers that keep nothing after answering). The model still reads the words of the question; privacy covers who you are, not what you write.
- Anyone can check it: ghostkeyai.com/privacy has an inspector that shows the exact request OpenRouter would receive. Every claim has a check on ghostkeyai.com/proof.
- Price is exactly what OpenRouter charges, no markup, 0% top-up fee. The Compare button on ghostkeyai.com/models checks every rate in your own browser (243 of 243 matched on the last run).
- Stored: model, token counts, cost, time (wallet only if signed in). Never stored: prompts, answers, IP, device. Chat history stays in the browser.
- 10 free messages with no wallet. Top-ups: USDG or ETH on Robinhood Chain, $5–$2,000, credited 1:1.
- $GHOST trades on Pons (Robinhood Chain). Each trade costs 3%: 1% Pons fee + 2% creator tax (locked at launch). Every hour the creator fees are claimed: 25% becomes Ghost Credit (AI credit) for holders, 75% goes to the team. Holders need an average of at least 100,000 $GHOST over 4 readings per hour; share = pool × your average ÷ all eligible averages. Check any wallet at ghostkeyai.com/token, no sign-in.
- Each hour's split is published and its Merkle root is posted to the GhostLedger contract (0x72d41a95004244E00fa8D3Bd188f8F33F6eA35C8, no owner, verified on Sourcify).
- X: x.com/ghostkeyai.
- Official $GHOST contract: ${ca ? ca + ' (Pons page: https://www.ponsfamily.com/launchpad/' + ca.toLowerCase() + ')' : 'NOT PUBLISHED YET. It will appear in the pinned message, via /ca and on ghostkeyai.com at the same moment. Any $GHOST address shared before that is not ours.'}`;
}
const RELEVANT = /ghost|ghostkey|\bca\b|contract|address|token|pons|launch|credit|holder|hold|tax|fee|privacy|private|zdr|model|openrouter|price|wallet|api|site|website|proof|ledger|buy|chart|when|how|what|why|is this|legit|scam|rug|team|dev|kapan|gimana|bagaimana|apa|berapa|kenapa|beli/i;
function shouldAnswer(msg, text) {
  if (!text || text.startsWith('/')) return false;
  if (me && (text.toLowerCase().includes('@' + me.username.toLowerCase()))) return true;
  if (msg.reply_to_message?.from?.id === me?.id) return true;
  if (msg.chat.type === 'private') return true;
  return /\?\s*$|\?\s/.test(text) && RELEVANT.test(text);
}
async function agentReply(msg, text) {
  const chatId = msg.chat.id, now = Date.now(), day = new Date().toISOString().slice(0, 10);
  if (day !== today) { today = day; used = 0; }
  if (!OR_KEY || used >= DAILY) return;
  if (now - (lastReply.get(chatId) || 0) < 4000) return;            // jeda grup
  if (now - (userLast.get(msg.from.id) || 0) < 15000) return;        // jeda per orang
  lastReply.set(chatId, now); userLast.set(msg.from.id, now); used++;
  const ca = await officialCA();
  const ctx = (history.get(chatId) || []).slice(-12).map((h) => `${h.who}: ${h.text}`).join('\n');
  await tg('sendChatAction', { chat_id: chatId, action: 'typing' });
  try {
    const r = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: { authorization: `Bearer ${OR_KEY}`, 'content-type': 'application/json', 'HTTP-Referer': 'https://ghostkeyai.com', 'X-Title': 'GHOSTKEY Guard' },
      body: JSON.stringify({ model: MODEL, max_tokens: 320, temperature: 0.7, reasoning: { enabled: false }, provider: { zdr: true, data_collection: 'deny' },
        messages: [{ role: 'system', content: facts(ca) },
          { role: 'user', content: `Recent group chat (oldest first):\n${ctx || '(nothing yet)'}\n\nReply to ${nameOf(msg.from)}'s last message: "${text.slice(0, 600)}"` }] }),
    });
    const j = await r.json();
    let out = j.choices?.[0]?.message?.content?.trim();
    if (!out) return;
    // jaga-jaga: buang alamat 0x selain CA resmi & GhostLedger
    const okA = await projectAddrs();
    out = out.replace(ADDR_RE, (a) => (ca && ca.toLowerCase() === a.toLowerCase()) || okA.has(a.toLowerCase()) ? a : '(see /ca)');
    await tg('sendMessage', { chat_id: chatId, text: out.slice(0, 1200), disable_web_page_preview: true, reply_to_message_id: msg.message_id, allow_sending_without_reply: true });
    remember(chatId, 'ghost (you)', out);
  } catch (e) { console.warn('[agent]', e.message); }
}

// ---------- loop ----------
let offset = 0;
me = await tg('getMe');
console.log('GHOSTKEY Guard jalan sebagai @' + (me?.username || '?') + '. Sumber CA:', SITE_API, '· agent:', OR_KEY ? MODEL : 'MATI (tanpa OPENROUTER_API_KEY)');
await tg('setMyCommands', { commands: [
  { command: 'ca', description: 'Official $GHOST contract address' },
  { command: 'site', description: 'ghostkeyai.com' },
  { command: 'proof', description: 'Every claim with its check' },
  { command: 'x', description: 'GHOSTKEY on X' },
  { command: 'request', description: 'Suggest a feature (reviewed and logged)' },
] });

// ---------- Notifikasi buy $GHOST (curve Pons) ----------
// Membaca event CurveBuy langsung dari chain tiap ~10 dtk lalu memposting ke grup. Tanpa layanan pihak ketiga.
// Env: ALERT_CHAT (bawaan @ghostkeyai), BUY_MIN_ETH (bawaan 0.003), ALERT_RPC (daftar dipisah koma).
const ALERT_CHAT = process.env.ALERT_CHAT || '@ghostkeyai';
const BUY_MIN_WEI = BigInt(Math.round(Number(process.env.BUY_MIN_ETH || 0.003) * 1e18));
const RPCS = (process.env.ALERT_RPC || 'https://robinhood.api.pocket.network,https://robinhood.drpc.org').split(',').map((x) => x.trim()).filter(Boolean);
const TOPIC_BUY = '0xec36bf571f136799e8dc0b0b8bea4b04d8bd3d43de838aab0d5fc21d4cbfc455';
const SEL_TRACKED = '0xca52b0b7', SEL_GRAD = '0xe7c2b772', SEL_RESERVES = '0x0902f1ac', SEL_SUPPLY = '0x18160ddd', SEL_BALANCE = '0x70a08231';
// 4.7M / 23.6K · harga kecil dengan 4 angka penting · USD 2 desimal
const fmtShort = (n) => (n >= 1e9 ? (n / 1e9).toFixed(2) + 'B' : n >= 1e6 ? (n / 1e6).toFixed(n >= 1e8 ? 0 : 1) + 'M' : n >= 1e3 ? (n / 1e3).toFixed(1) + 'K' : n.toFixed(0));
const fmtPrice = (n) => (n >= 0.01 ? n.toFixed(4) : n.toFixed(Math.min(12, 3 - Math.floor(Math.log10(n)))));
const fmtUsd = (n) => (n >= 1000 ? Math.round(n).toLocaleString('en-US') : n.toFixed(2));
const SCAN = 'https://robinhoodchain.blockscout.com';
const TEAM = new Set(['0x8546881839d06ea5b1c8d892897860d2cfabfed6', '0x8198d85f5c790093dd00e78761ffa9569aebe8f3']);
async function rpc(method, params) {
  let last;
  for (const u of RPCS) {
    try {
      const r = await fetch(u, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }), signal: AbortSignal.timeout(15_000) });
      const j = await r.json();
      if (j.error) throw new Error(j.error.message);
      return j.result;
    } catch (e) { last = e; }
  }
  throw last;
}
const fmtEth = (wei) => { const n = Number(wei) / 1e18; return n >= 1 ? n.toFixed(3) : n >= 0.01 ? n.toFixed(4) : n.toFixed(5); };
const fmtInt = (n) => Math.round(n).toLocaleString('en-US');
const shortA = (a) => a.slice(0, 6) + '…' + a.slice(-4);
let feesInfo = { at: 0, v: null };
async function siteFees() {
  if (Date.now() - feesInfo.at < 60_000 && feesInfo.v) return feesInfo.v;
  try { feesInfo = { at: Date.now(), v: await (await fetch(SITE_API + '/api/fees')).json() }; } catch {}
  return feesInfo.v;
}
async function buyWatcher() {
  let curve = null, from = null, gradAnnounced = false;
  for (;;) {
    try {
      const ca = await officialCA();
      if (!ca) { await sleep(30_000); continue; }
      if (!curve) { const f = await siteFees(); curve = f?.curve || null; if (!curve) { await sleep(30_000); continue; } }
      const head = Number(await rpc('eth_blockNumber', []));
      if (from == null) { from = head + 1; console.log('[buy] memantau curve', curve, 'mulai blok', from); }
      if (head >= from) {
        const to = Math.min(head, from + 4999);
        const logs = await rpc('eth_getLogs', [{ address: curve, topics: [TOPIC_BUY], fromBlock: '0x' + from.toString(16), toBlock: '0x' + to.toString(16) }]);
        const big = logs.filter((l) => BigInt('0x' + l.data.slice(2, 66)) >= BUY_MIN_WEI);
        if (big.length) {
          const f = await siteFees();
          const px = f?.ethUsd || null;
          const tq = BigInt(await rpc('eth_call', [{ to: curve, data: SEL_TRACKED }, 'latest']));
          const pct = Math.min(100, Number((tq * 10000n) / 4200000000000000000n) / 100);
          // harga spot curve (quoteReserve / tokenReserve) & MC = harga × totalSupply
          let priceEth = null, mcEth = null;
          try {
            const r = (await rpc('eth_call', [{ to: curve, data: SEL_RESERVES }, 'latest'])).slice(2);
            const qr = BigInt('0x' + r.slice(0, 64)), tr = BigInt('0x' + r.slice(64, 128));
            priceEth = Number(qr) / Number(tr);
            const sup = Number(BigInt(await rpc('eth_call', [{ to: ca, data: SEL_SUPPLY }, 'latest']))) / 1e18;
            mcEth = priceEth * sup;
          } catch {}
          const buttons = { inline_keyboard: [
            [{ text: 'Buy on Pons', url: `https://ponsfamily.com/launchpad/${ca.toLowerCase()}` }, { text: 'Chart', url: 'https://ghostkeyai.com/token#chart' }],
            [{ text: 'DexScreener', url: `https://dexscreener.com/robinhood/${ca}` }, { text: 'Ghost Credit', url: 'https://ghostkeyai.com/token#fees' }],
            [{ text: 'GHOSTKEY: 200+ AI models, none of you', url: 'https://ghostkeyai.com' }],
          ] };
          for (const l of big.slice(-5)) {
            const w = l.data.slice(2).match(/.{64}/g).map((h) => BigInt('0x' + h));
            const [quoteIn, tokensOut] = w;
            const buyer = '0x' + l.topics[1].slice(26);
            const ghosts = '👻'.repeat(Math.max(1, Math.min(20, Math.floor(Number(quoteIn) / 1e18 / 0.02))));
            const team = TEAM.has(buyer.toLowerCase());
            // pemegang baru = saldo $GHOST 0 tepat sebelum blok pembelian (butuh RPC arsip; gagal → tanpa label)
            let fresh = false;
            try {
              const prev = BigInt(await rpc('eth_call', [{ to: ca, data: SEL_BALANCE + buyer.slice(2).padStart(64, '0') }, '0x' + (Number(l.blockNumber) - 1).toString(16)]));
              fresh = prev === 0n;
            } catch {}
            const usd = (eth) => (px ? `$${fmtUsd(eth * px)}` : null);
            const text = `<b>${team ? '$GHOST team buyback' : '$GHOST buy'}</b>\n${ghosts}\n\n`
              + `Spent: <b>${fmtEth(quoteIn)} ETH</b>${px ? ` (${usd(Number(quoteIn) / 1e18)})` : ''}\n`
              + `Got: <b>${fmtShort(Number(tokensOut) / 1e18)} GHOST</b>\n`
              + `Wallet: <a href="${SCAN}/address/${buyer}">${shortA(buyer)}</a>${fresh ? ' · new holder' : ''}\n`
              + (priceEth != null && px ? `Price: $${fmtPrice(priceEth * px)} · MC $${fmtShort(mcEth * px)}\n` : '')
              + `Venue: Pons curve · ${pct.toFixed(1)}% to Uniswap\n`
              + `<a href="${SCAN}/tx/${l.transactionHash}">View transaction</a>`;
            await tg('sendMessage', { chat_id: ALERT_CHAT, text, parse_mode: 'HTML', disable_web_page_preview: true, reply_markup: buttons });
            await sleep(1200);
          }
        }
        from = to + 1;
      }
      // graduasi: umumkan sekali, lalu berhenti memantau curve (perdagangan pindah ke Uniswap v4)
      if (!gradAnnounced && BigInt(await rpc('eth_call', [{ to: curve, data: SEL_GRAD }, 'latest'])) === 1n) {
        gradAnnounced = true;
        await tg('sendMessage', { chat_id: ALERT_CHAT, parse_mode: 'HTML', disable_web_page_preview: true,
          text: `🎓 <b>$GHOST graduated.</b>\n\nThe Pons curve hit 4.2 ETH. Liquidity moved to Uniswap v4 and is locked. Same CA, and the 2% creator tax keeps funding Ghost Credit every hour.\n\n<a href="https://dexscreener.com/robinhood/${ca}">Chart</a> · <a href="https://ghostkeyai.com/token">Ghost Credit</a>` });
        console.log('[buy] curve lulus — pemantau curve berhenti');
        return;
      }
    } catch (e) { console.warn('[buy]', e.message); }
    await sleep(10_000);
  }
}
buyWatcher();

// ---------- Pengumuman Ghost Credit per jam ----------
// Tiap jam yang berstatus 'posted' (kredit dibagikan + root sudah on-chain) diumumkan sekali ke grup.
// Saat bot mulai, jam yang sudah ada dianggap sudah diumumkan (tidak ada posting ulang sesudah restart).
const hourLabel = (iso) => {
  const a = new Date(iso), b = new Date(a.getTime() + 3600_000);
  const hm = (d) => d.toISOString().slice(11, 16);
  return `${a.getUTCDate()} ${a.toLocaleString('en-US', { month: 'short', timeZone: 'UTC' })} ${hm(a)}–${hm(b)} UTC`;
};
const money = (n) => '$' + (n >= 100 ? n.toFixed(0) : n.toFixed(2));
async function creditAnnouncer() {
  let last = null;
  for (;;) {
    try {
      const list = await (await fetch(SITE_API + '/api/ledger?limit=6')).json();
      const posted = (Array.isArray(list) ? list : []).filter((h) => h.status === 'posted' && h.txHash).sort((a, b) => a.hour - b.hour);
      if (last == null) { last = posted.length ? posted.at(-1).hour : 0; console.log('[credit] pengumuman mulai sesudah jam', last); }
      for (const h of posted.filter((x) => x.hour > last)) {
        let total = null;
        try { total = (await (await fetch(SITE_API + '/api/stats')).json()).holderCreditPaidUsd; } catch {}
        const text = `👻 <b>Ghost Credit paid</b>\n\n`
          + `Hour: <b>${hourLabel(h.startsAt)}</b>\n`
          + `Holder pool: <b>${money(h.distributedUsd)}</b> (25% of creator fees)\n`
          + `Paid to: <b>${h.entries}</b> wallet${h.entries === 1 ? '' : 's'} holding 100k+ $GHOST\n`
          + (total != null ? `Paid so far: ${money(total)}\n` : '')
          + `Merkle root: <a href="${SCAN}/tx/${h.txHash}">on-chain</a>\n\n`
          + `Holders: sign in at ghostkeyai.com with the same wallet. The credit is already on your balance, ready for any model.`;
        await tg('sendMessage', { chat_id: ALERT_CHAT, text, parse_mode: 'HTML', disable_web_page_preview: true,
          reply_markup: { inline_keyboard: [
            [{ text: 'Check my wallet', url: 'https://ghostkeyai.com/token#check' }, { text: 'This hour', url: `https://ghostkeyai.com/token#ledger` }],
            [{ text: 'Use my credit', url: 'https://ghostkeyai.com/app' }],
          ] } });
        last = h.hour;
        console.log('[credit] diumumkan jam', h.hour);
        await sleep(1500);
      }
    } catch (e) { console.warn('[credit]', e.message); }
    await sleep(60_000);
  }
}
creditAnnouncer();
changelogAnnouncer();

// ---------- antrean posting kit ke grup (STATE_DIRECTORY/kit/queue.json + gambar) ----------
// queue.json: [{ id, at (ISO), text, photo (nama berkas di folder kit), pin }]. Tiap id dikirim sekali (dicatat di state).
const KIT_DIR = join(dirname(STATE_FILE), 'kit');
async function sendPhotoFile(chat, file, caption) {
  try {
    const fd = new FormData();
    fd.append('chat_id', String(chat)); fd.append('caption', caption);
    fd.append('photo', new Blob([readFileSync(file)], { type: 'image/jpeg' }), basename(file));
    const j = await (await fetch(API + 'sendPhoto', { method: 'POST', body: fd })).json();
    if (!j.ok) console.warn('[kit] sendPhoto', j.description);
    return j.ok ? j.result : null;
  } catch (e) { console.warn('[kit] sendPhoto', e.message); return null; }
}
async function kitPoster() {
  for (;;) {
    try {
      let q = []; try { q = JSON.parse(readFileSync(join(KIT_DIR, 'queue.json'), 'utf8')); } catch {}
      STATE.kitSent ||= [];
      const x = q.filter((it) => !STATE.kitSent.includes(it.id) && Date.parse(it.at) <= Date.now()).sort((a, b) => Date.parse(a.at) - Date.parse(b.at))[0];
      if (x) {
        let m = null;
        if (x.photo && existsSync(join(KIT_DIR, x.photo)) && x.text.length <= 1024) m = await sendPhotoFile(ALERT_CHAT, join(KIT_DIR, x.photo), x.text);
        if (!m) m = await tg('sendMessage', { chat_id: ALERT_CHAT, text: x.text, disable_web_page_preview: true });
        if (m) {
          if (x.pin) await tg('pinChatMessage', { chat_id: m.chat.id, message_id: m.message_id, disable_notification: false });
          STATE.kitSent.push(x.id); saveState();
          console.log('[kit] terkirim', x.id);
        }
      }
    } catch (e) { console.warn('[kit]', e.message); }
    await sleep(30_000);
  }
}
kitPoster();

for (;;) {
  const ups = await tg('getUpdates', { offset, timeout: 50, allowed_updates: ['message', 'callback_query', 'chat_member'] });
  if (!ups) { await sleep(3000); continue; }
  for (const u of ups) {
    offset = u.update_id + 1;
    try {
      if (u.message) await onMessage(u.message);
      else if (u.callback_query) await onCallback(u.callback_query);
    } catch (e) { console.warn('[guard]', e.message); }
  }
}
