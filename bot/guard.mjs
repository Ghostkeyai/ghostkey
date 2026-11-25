// GHOSTKEY Guard — bot penjaga grup Telegram t.me/ghostkeyai. Node 22, tanpa dependensi (Bot API lewat fetch, long polling).
// Fitur: verifikasi anggota baru (tombol), hapus link & alamat 0x asing dari non-admin, blokir nama peniru,
//        perintah /ca /site /proof /x /help. CA resmi dibaca dari situs GHOSTKEY (/api/config → ghostToken), satu sumber kebenaran.
// Env: GUARD_TOKEN (wajib), GHOSTKEY_API (bawaan http://127.0.0.1:4877), GUARD_CHAT (opsional: hanya layani grup ini, id angka),
//      OPENROUTER_API_KEY (agent balas chat), GUARD_MODEL (bawaan anthropic/claude-haiku-5.5), GUARD_DAILY (maks balasan agent/hari, bawaan 600).
// Agent: membalas saat di-mention, di-reply, atau ada pertanyaan yang relevan. Konteks obrolan hanya di memori (tidak ditulis ke disk).
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
const IMPOSTOR = /(ghost\s*key|ghostkey).{0,12}(admin|support|team|mod|help|official|dev)|(admin|support|team|mod|official|dev).{0,12}(ghost\s*key|ghostkey)/i;
const MUTE = { can_send_messages: false, can_send_audios: false, can_send_documents: false, can_send_photos: false, can_send_videos: false, can_send_video_notes: false, can_send_voice_notes: false, can_send_polls: false, can_send_other_messages: false, can_add_web_page_previews: false };

async function onJoin(msg, user) {
  const chatId = msg.chat.id;
  if (user.is_bot) return;
  if (IMPOSTOR.test(nameOf(user)) || IMPOSTOR.test(user.username || '')) {
    await tg('banChatMember', { chat_id: chatId, user_id: user.id });
    console.log('[guard] peniru diblokir', user.id, nameOf(user));
    return;
  }
  if (!STRICT) {
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
      help: 'Commands: /ca (official contract) · /site · /proof · /x\nAdmins never DM first.',
      start: 'Commands: /ca (official contract) · /site · /proof · /x\nAdmins never DM first.',
    };
    if (R[cmd]) { await tg('sendMessage', { chat_id: chatId, text: R[cmd], parse_mode: 'HTML', disable_web_page_preview: true, reply_to_message_id: msg.message_id, allow_sending_without_reply: true }); return; }
  }
  if (msg.chat.type === 'private') { if (shouldAnswer(msg, text)) await agentReply(msg, text); return; }
  const anonAdmin = msg.sender_chat?.id === chatId || (msg.is_automatic_forward && msg.sender_chat?.type === 'channel');
  if (anonAdmin || await isAdmin(chatId, from.id)) { remember(chatId, nameOf(from) + ' (admin)', text); if (shouldAnswer(msg, text) && (msg.reply_to_message?.from?.id === me?.id || text.toLowerCase().includes('@' + (me?.username || '').toLowerCase()))) await agentReply(msg, text); return; }
  if (from.is_bot && from.username !== undefined) { /* bot lain lewat admin saja */ }

  // pesan terusan dari kanal / akun lain = pola spam umum
  if (STRICT && (msg.forward_origin || msg.forward_from_chat)) {
    await tg('deleteMessage', { chat_id: chatId, message_id: msg.message_id });
    return sayTemp(chatId, `${esc(nameOf(from))}, forwarded posts are removed here to keep scams out.`, 20_000);
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
  if (shouldAnswer(msg, text)) await agentReply(msg, text);
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
] });
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
