// Inti chat: bersihkan pesan, tentukan siapa yang membayar, tahan biaya, stream, tagih usage.cost, kirim struk.
// Struk (receipt) memuat salinan tersamar dari permintaan yang BENAR-BENAR dikirim ke OpenRouter.
import { config, usdToMicro, microToUsd } from './config.mjs';
import { modelInfo, streamChat, completeChat, fitMaxTokens, estimateMaxUsd } from './openrouter.mjs';
import { hold, settle, release, available, canUseFree, consumeFree, bumpFreeCost, freeLeft, recordUsage } from './billing.mjs';
import { redactForDisplay, STRIPPED, pickAllowed, WEB_SEARCH } from './privacy.mjs';
import { sseStart, sseData, sseEvent, sendJson } from './http.mjs';
import { getDaily, bumpDaily } from './db.mjs';
import { keySpendKey } from './auth.mjs';

const MAX_CHARS = 400_000;
const MIN_TOKENS = 64;
export const STORED = ['model', 'tokens', 'cost', 'time', 'OpenRouter generation ID'];

// Bersihkan daftar pesan dari klien (format OpenAI). Hanya role/content (+ tool_calls/tool_call_id untuk alat)
// yang dibawa; kolom lain (mis. `name`) dibuang.
export function cleanMessages(messages) {
  if (!Array.isArray(messages) || !messages.length || messages.length > 200) return null;
  const out = [];
  let chars = 0;
  for (const m of messages) {
    if (!m || !['user', 'assistant', 'system', 'tool'].includes(m.role)) return null;
    let content = m.content;
    if (content == null && m.role === 'assistant' && Array.isArray(m.tool_calls)) content = null;
    else if (typeof content === 'string') chars += content.length;
    else if (Array.isArray(content)) {
      content = content.filter((p) => p && (p.type === 'text' || p.type === 'image_url')).map((p) => {
        if (p.type === 'text') { chars += String(p.text || '').length; return { type: 'text', text: String(p.text || '') }; }
        chars += 2000;
        return { type: 'image_url', image_url: { url: String(p.image_url?.url || '') } };
      });
    } else return null;
    const msg = { role: m.role, content };
    if (m.role === 'assistant' && Array.isArray(m.tool_calls)) {
      msg.tool_calls = m.tool_calls.slice(0, 64).map((t) => ({
        id: String(t?.id || ''), type: 'function',
        function: { name: String(t?.function?.name || ''), arguments: String(t?.function?.arguments ?? '') },
      }));
      chars += JSON.stringify(msg.tool_calls).length;
    }
    if (m.role === 'tool') msg.tool_call_id = String(m.tool_call_id || '');
    out.push(msg);
  }
  return chars > MAX_CHARS ? null : out;
}

const hasImage = (msgs) => msgs.some((m) => Array.isArray(m.content) && m.content.some((p) => p.type === 'image_url'));

/**
 * Tentukan pembayar: { account } berbayar, atau { free:true } jatah gratis.
 * freeLimit: batas jatah untuk clientId ini (web = FREE_MESSAGES, API = FREE_API_CALLS).
 */
// ---------- Batas belanja kunci API ----------
// Belanja hari ini per kunci ada di daily_counters (satu angka per kunci per hari UTC);
// tahanan permintaan yang masih berjalan dihitung di memori supaya permintaan paralel tidak menembus batas.
const keyHeld = new Map();
export function keyCapLeftMicro(key) {
  if (!key || key.capMicro == null) return Infinity;
  return Math.max(0, key.capMicro - getDaily(keySpendKey(key.id)).micro - (keyHeld.get(key.id) || 0));
}
const spendable = (account, key) => Math.min(available(account.id), keyCapLeftMicro(key));
const keyHold = (key, micro) => { if (key?.capMicro != null) keyHeld.set(key.id, (keyHeld.get(key.id) || 0) + micro); };
const keyRelease = (key, micro) => {
  if (key?.capMicro == null) return;
  const left = (keyHeld.get(key.id) || 0) - micro;
  if (left > 0) keyHeld.set(key.id, left); else keyHeld.delete(key.id);
};
// Belanja dicatat untuk SEMUA kunci (juga yang tanpa batas) supaya halaman akun bisa menampilkan "hari ini"
const keySettle = (key, heldMicro, costMicro) => {
  if (!key) return;
  keyRelease(key, heldMicro);
  bumpDaily(keySpendKey(key.id), 1, Math.max(0, costMicro | 0));
};

export function pickPayer({ account, model, clientId, ip, freeLimit = config.freeMessages, api = false, key = null }) {
  if (account && available(account.id) > 0) {
    // Kunci yang sudah mencapai batas hariannya berhenti total (tidak diam-diam pindah ke jatah gratis)
    if (keyCapLeftMicro(key) <= 0) return { error: 'key_cap' };
    return { account: true, source: api ? 'api' : 'chat' };
  }
  const f = canUseFree(clientId, ip, freeLimit);
  if (f.ok) {
    if (!model.freeEligible) return { error: 'model_needs_balance' };
    return { free: true, source: api ? 'free_api' : 'free' };
  }
  if (f.reason === 'free_paused') return { error: 'free_paused' };
  return { error: account ? 'top_up' : 'sign_in' };
}

const ERR_TEXT = {
  sign_in: 'Your free messages are used up. Connect a wallet and add balance to keep going.',
  top_up: 'Your balance is too low for this request. Add balance or pick a cheaper model.',
  model_needs_balance: 'Free messages work on budget models only. Pick a model marked FREE, or add balance.',
  free_paused: 'Free messages are paused for today. Add balance to continue.',
  key_cap: 'This API key has reached its daily spending limit. It resets at 00:00 UTC, or raise the limit on your account page.',
  key_expired: 'This API key has expired. Extend it or create a new one on your account page.',
  bad_model: 'Unknown model, or the model has no zero-retention provider right now.',
  bad_messages: 'Messages are missing or too long.',
  vision: 'This model cannot read images.',
  upstream: 'The model provider returned an error. You were not charged.',
  web_balance: `Web search needs a balance. Each search costs $${WEB_SEARCH.feeUsd} on top of the tokens, so it is not part of free messages.`,
  web_confidential: 'Web search sends a query to Exa, outside the enclave. Turn search off, or pick a model that is not Confidential.',
};
export const errText = (code) => ERR_TEXT[code] || code;
// Kode galat gaya OpenAI untuk /v1
const API_CODE = { top_up: 'insufficient_balance', key_cap: 'key_daily_limit_reached', key_expired: 'key_expired',
  web_balance: 'web_search_needs_balance', web_confidential: 'web_search_not_on_confidential' };
export const apiCode = (code) => API_CODE[code] || code;

// Sisa batas harian kunci (hanya untuk kunci yang punya batas) → ikut di struk
const keyExtra = (key) => key?.capMicro != null ? { keyDailyLimitLeftUsd: microToUsd(keyCapLeftMicro(key)) } : {};

// Info pencarian web di struk: mesin, tarif tetap, dan sumber yang dipakai jawaban (dari anotasi OpenRouter)
const webExtra = (web, r) => web ? { web: { engine: WEB_SEARCH.engine, via: WEB_SEARCH.via, maxResults: WEB_SEARCH.maxResults,
  feeUsd: WEB_SEARCH.feeUsd, sources: r.sources || [], policy: WEB_SEARCH.policy } } : {};
// Cek sakelar pencarian web sebelum memanggil hulu
function webBlock(web, model, payer) {
  if (!web) return null;
  if (model.confidential) return [400, 'web_confidential'];
  if (payer.free) return [402, 'web_balance'];
  return null;
}

// Struk yang sama untuk web (event: receipt), /v1 stream (potongan terakhir) dan /v1 biasa (ghostkey_receipt)
function makeReceipt({ model, r, costMicro, balanceMicro, payer, clientId, freeLimit, extra = {} }) {
  return {
    model: model.id,
    tokensIn: r.tokensIn, tokensOut: r.tokensOut,
    rateIn: model.in, rateOut: model.out,                 // USD per 1 juta token (harga model di OpenRouter)
    costUsd: microToUsd(costMicro),
    costSource: r.costSource,                             // openrouter_usage_cost | rates (mode tiruan)
    balanceUsd: payer.account ? microToUsd(balanceMicro) : null,
    freeLeft: payer.free ? freeLeft(clientId, freeLimit) : null,
    paidBy: payer.free ? 'free' : 'balance',
    forwarded: redactForDisplay(r.upstream),
    stripped: STRIPPED,
    stored: STORED,
    mock: !config.openrouterKey,
    generationId: r.genId || null,                        // ID generasi OpenRouter: cek biaya ke catatan OpenRouter sendiri
    forwardedSha256: r.forwardedSha256 || null,           // SHA-256 dari body persis yang dikirim ke OpenRouter (tidak disimpan server)
    verifyUrl: r.genId ? `/api/receipt/${r.genId}` : null,
    ...extra,
  };
}

/**
 * Chat streaming ke res (SSE). opts: { account, modelId, messages, clientId, ip, wantTokens, extra, openaiStream, freeLimit }
 * - web (/api/chat): potongan OpenAI → `event: receipt` → `data: [DONE]`
 * - /v1 stream (openaiStream=true): potongan OpenAI; potongan terakhir (choices:[]) membawa `ghostkey_receipt`
 *   supaya SDK OpenAI tidak tersandung event asing.
 */
export async function runChatStream(req, res, opts) {
  const { account, clientId, ip, openaiStream = false, freeLimit = config.freeMessages, key = null } = opts;
  const web = opts.web === true;
  const extra = pickAllowed(opts.extra || {});
  const fail = (status, code, extraBody = {}) => openaiStream
    ? sendJson(res, status, { error: { message: errText(code), code: apiCode(code) } })
    : sendJson(res, status, { error: code, message: errText(code), ...extraBody });
  const model = await modelInfo(opts.modelId);
  if (!model) return fail(400, 'bad_model');
  const messages = cleanMessages(opts.messages);
  if (!messages) return fail(400, 'bad_messages');
  if (hasImage(messages) && !model.vision) return fail(400, 'vision');

  const payer = pickPayer({ account, model, clientId, ip, freeLimit, api: openaiStream, key });
  if (payer.error) return fail(402, payer.error, { freeLeft: freeLeft(clientId, freeLimit) });
  const wb = webBlock(web, model, payer);
  if (wb) return fail(wb[0], wb[1]);

  // Hitung batas token & tahan dana
  let maxTokens, heldMicro = 0;
  const want = Math.min(Math.max(MIN_TOKENS, opts.wantTokens || 4096), 32000);
  if (payer.free) {
    maxTokens = Math.min(want, config.freeMaxTokens);
  } else {
    maxTokens = fitMaxTokens(model, messages, microToUsd(spendable(account, key)), want, web);
    if (maxTokens < MIN_TOKENS) return fail(402, keyCapLeftMicro(key) < available(account.id) ? 'key_cap' : 'top_up');
    heldMicro = usdToMicro(estimateMaxUsd(model, messages, maxTokens, web)) + 1;
    if (!hold(account.id, heldMicro)) return fail(402, 'top_up');
    keyHold(key, heldMicro);
  }

  const ac = new AbortController();
  let finished = false;
  res.on('close', () => { if (!finished) ac.abort(); });

  sseStart(res);
  let streamedChars = 0;
  const usageBase = { account_id: account?.id, client_id: payer.free ? clientId : null, source: payer.source, model: model.id };
  try {
    const onDelta = (chunk) => {
      streamedChars += (chunk.choices?.[0]?.delta?.content || '').length;
      // chat web: cuplikan halaman di anotasi tidak perlu dikirim ke browser (sumbernya ada di struk); /v1 tetap utuh
      if (!openaiStream && chunk.choices?.[0]?.delta?.annotations) delete chunk.choices[0].delta.annotations;
      if (!res.writableEnded) sseData(res, chunk);
    };
    // Pesan gratis: matikan "thinking" tersembunyi (model penalar bisa menghabiskan jatah tanpa menjawab).
    // Kalau model menolak opsi itu, ulangi sekali tanpa opsi.
    const reasoningOff = !!payer.free;
    let r;
    try { r = await streamChat({ model, messages, maxTokens, signal: ac.signal, extra, reasoningOff, web, onDelta }); }
    catch (e) {
      if (!reasoningOff || streamedChars || ac.signal.aborted || !(e.status >= 400 && e.status < 500)) throw e;
      r = await streamChat({ model, messages, maxTokens, signal: ac.signal, extra, web, onDelta });
    }
    finished = true;
    const costMicro = Math.round(r.costUsd * 1e6);   // dibulatkan ke mikro-USD terdekat (bukan ke atas)
    const usage = { ...usageBase, tokens_in: r.tokensIn, tokens_out: r.tokensOut, gen_id: r.genId || null };
    // Jawaban kosong (semua token habis untuk berpikir): pesan gratis tidak dihitung ke jatah pengunjung
    const emptyAnswer = !streamedChars && r.tokensOut > 0 && !openaiStream;
    let balanceMicro = null;
    if (payer.free) {
      if (emptyAnswer) bumpFreeCost(ip, costMicro, clientId);
      else consumeFree(clientId, ip, costMicro);
      recordUsage({ ...usage, cost_micro: costMicro });
    } else { balanceMicro = settle(account.id, heldMicro, costMicro, usage); keySettle(key, heldMicro, costMicro); }

    const receipt = makeReceipt({ model, r, costMicro, balanceMicro, payer, clientId, freeLimit,
      extra: { ...(emptyAnswer ? { empty: true, freeRefunded: !!payer.free } : {}), ...keyExtra(key), ...webExtra(web, r) } });
    if (openaiStream) sseData(res, { id: 'ghostkey-receipt', object: 'chat.completion.chunk', model: model.id, choices: [], ghostkey_receipt: receipt });
    else sseEvent(res, 'receipt', receipt);
    sseData(res, '[DONE]');
    res.end();
  } catch (e) {
    finished = true;
    if (ac.signal.aborted) {
      // Pengguna menekan Stop: tagih perkiraan dari teks yang sudah keluar (hulu tetap menagih kita).
      const tin = Math.ceil(JSON.stringify(messages).length / 3.2);
      const tout = Math.ceil(streamedChars / 4);
      // tarif per 1M token × token = mikro-USD; + tarif pencarian bila sakelar web nyala dan teks sudah keluar
      const estMicro = Math.ceil(tin * model.in + tout * model.out) + (web && streamedChars ? usdToMicro(WEB_SEARCH.feeUsd) : 0);
      const usage = { ...usageBase, tokens_in: tin, tokens_out: tout };
      if (payer.free) { consumeFree(clientId, ip, estMicro); recordUsage({ ...usage, cost_micro: estMicro }); }
      else { settle(account.id, heldMicro, estMicro, usage); keySettle(key, heldMicro, estMicro); }
      return;
    }
    if (!payer.free) { release(account.id, heldMicro); keyRelease(key, heldMicro); }
    console.warn('[chat] hulu gagal', e.message, e.detail || '');
    if (!res.writableEnded) {
      if (openaiStream) sseData(res, { error: { message: errText('upstream'), code: e.status || 502 } });
      else sseEvent(res, 'error', { error: 'upstream', message: errText('upstream') });
      res.end();
    }
  }
}

// /v1/chat/completions tanpa stream — jawaban hulu diteruskan utuh + kolom `ghostkey_receipt`.
export async function runChatJson(req, res, { account, body, clientId, ip, freeLimit = config.freeApiCalls, key = null }) {
  const err = (status, code) => sendJson(res, status, { error: { message: errText(code), code: apiCode(code) } });
  const model = await modelInfo(body.model);
  if (!model) return err(400, 'bad_model');
  const messages = cleanMessages(body.messages);
  if (!messages) return err(400, 'bad_messages');
  if (hasImage(messages) && !model.vision) return err(400, 'vision');
  const payer = pickPayer({ account, model, clientId, ip, freeLimit, api: true, key });
  if (payer.error) return err(402, payer.error);
  const web = body.web_search === true;
  const wb = webBlock(web, model, payer);
  if (wb) return err(wb[0], wb[1]);
  const want = Math.min(Math.max(MIN_TOKENS, Number(body.max_tokens || body.max_completion_tokens) || 4096), 32000);
  let maxTokens, heldMicro = 0;
  if (payer.free) maxTokens = Math.min(want, config.freeMaxTokens);
  else {
    maxTokens = fitMaxTokens(model, messages, microToUsd(spendable(account, key)), want, web);
    if (maxTokens < MIN_TOKENS) return err(402, keyCapLeftMicro(key) < available(account.id) ? 'key_cap' : 'top_up');
    heldMicro = usdToMicro(estimateMaxUsd(model, messages, maxTokens, web)) + 1;
    if (!hold(account.id, heldMicro)) return err(402, 'top_up');
    keyHold(key, heldMicro);
  }
  try {
    const r = await completeChat({ model, messages, maxTokens, extra: pickAllowed(body), web });
    const costMicro = Math.round(r.costUsd * 1e6);   // dibulatkan ke mikro-USD terdekat (bukan ke atas)
    const usage = { account_id: account?.id, client_id: payer.free ? clientId : null, source: payer.source,
      model: model.id, tokens_in: r.tokensIn, tokens_out: r.tokensOut, gen_id: r.genId || null };
    let balanceMicro = null;
    if (payer.free) { consumeFree(clientId, ip, costMicro); recordUsage({ ...usage, cost_micro: costMicro }); }
    else { balanceMicro = settle(account.id, heldMicro, costMicro, usage); keySettle(key, heldMicro, costMicro); }
    const receipt = makeReceipt({ model, r, costMicro, balanceMicro, payer, clientId, freeLimit, extra: { ...keyExtra(key), ...webExtra(web, r) } });
    const h = { 'X-Ghostkey-Generation-Id': String(receipt.generationId || ''), 'X-Ghostkey-Cost': String(receipt.costUsd), 'X-Ghostkey-Rate-In-Per-M': String(model.in),
      'X-Ghostkey-Rate-Out-Per-M': String(model.out) };
    if (payer.free) h['X-Ghostkey-Free-Left'] = String(receipt.freeLeft);
    else h['X-Ghostkey-Balance'] = String(receipt.balanceUsd);
    if (receipt.keyDailyLimitLeftUsd != null) h['X-Ghostkey-Key-Limit-Left'] = String(receipt.keyDailyLimitLeftUsd);
    sendJson(res, 200, { ...r.json, ghostkey_receipt: receipt }, h);
  } catch (e) {
    if (!payer.free) { release(account.id, heldMicro); keyRelease(key, heldMicro); }
    sendJson(res, e.status && e.status < 500 ? e.status : 502, { error: { message: errText('upstream'), code: 'upstream_error' } });
  }
}
