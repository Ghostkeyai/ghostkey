// Inti chat: bersihkan pesan, tentukan siapa yang membayar, tahan biaya, stream, tagih usage.cost, kirim struk.
// Struk (receipt) memuat salinan tersamar dari permintaan yang BENAR-BENAR dikirim ke OpenRouter.
import { config, usdToMicro, microToUsd } from './config.mjs';
import { modelInfo, streamChat, completeChat, fitMaxTokens, estimateMaxUsd } from './openrouter.mjs';
import { hold, settle, release, available, canUseFree, consumeFree, bumpFreeCost, freeLeft, recordUsage } from './billing.mjs';
import { redactForDisplay, STRIPPED, pickAllowed } from './privacy.mjs';
import { sseStart, sseData, sseEvent, sendJson } from './http.mjs';

const MAX_CHARS = 400_000;
const MIN_TOKENS = 64;
export const STORED = ['model', 'tokens', 'cost', 'time'];

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
export function pickPayer({ account, model, clientId, ip, freeLimit = config.freeMessages, api = false }) {
  if (account && available(account.id) > 0) return { account: true, source: api ? 'api' : 'chat' };
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
  bad_model: 'Unknown model, or the model has no zero-retention provider right now.',
  bad_messages: 'Messages are missing or too long.',
  vision: 'This model cannot read images.',
  upstream: 'The model provider returned an error. You were not charged.',
};
export const errText = (code) => ERR_TEXT[code] || code;

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
  const { account, clientId, ip, openaiStream = false, freeLimit = config.freeMessages } = opts;
  const extra = pickAllowed(opts.extra || {});
  const fail = (status, code, extraBody = {}) => openaiStream
    ? sendJson(res, status, { error: { message: errText(code), code: code === 'top_up' ? 'insufficient_balance' : code } })
    : sendJson(res, status, { error: code, message: errText(code), ...extraBody });
  const model = await modelInfo(opts.modelId);
  if (!model) return fail(400, 'bad_model');
  const messages = cleanMessages(opts.messages);
  if (!messages) return fail(400, 'bad_messages');
  if (hasImage(messages) && !model.vision) return fail(400, 'vision');

  const payer = pickPayer({ account, model, clientId, ip, freeLimit, api: openaiStream });
  if (payer.error) return fail(402, payer.error, { freeLeft: freeLeft(clientId, freeLimit) });

  // Hitung batas token & tahan dana
  let maxTokens, heldMicro = 0;
  const want = Math.min(Math.max(MIN_TOKENS, opts.wantTokens || 4096), 32000);
  if (payer.free) {
    maxTokens = Math.min(want, config.freeMaxTokens);
  } else {
    maxTokens = fitMaxTokens(model, messages, microToUsd(available(account.id)), want);
    if (maxTokens < MIN_TOKENS) return fail(402, 'top_up');
    heldMicro = usdToMicro(estimateMaxUsd(model, messages, maxTokens)) + 1;
    if (!hold(account.id, heldMicro)) return fail(402, 'top_up');
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
      if (!res.writableEnded) sseData(res, chunk);
    };
    // Pesan gratis: matikan "thinking" tersembunyi (model penalar bisa menghabiskan jatah tanpa menjawab).
    // Kalau model menolak opsi itu, ulangi sekali tanpa opsi.
    const reasoningOff = !!payer.free;
    let r;
    try { r = await streamChat({ model, messages, maxTokens, signal: ac.signal, extra, reasoningOff, onDelta }); }
    catch (e) {
      if (!reasoningOff || streamedChars || ac.signal.aborted || !(e.status >= 400 && e.status < 500)) throw e;
      r = await streamChat({ model, messages, maxTokens, signal: ac.signal, extra, onDelta });
    }
    finished = true;
    const costMicro = Math.round(r.costUsd * 1e6);   // dibulatkan ke mikro-USD terdekat (bukan ke atas)
    const usage = { ...usageBase, tokens_in: r.tokensIn, tokens_out: r.tokensOut };
    // Jawaban kosong (semua token habis untuk berpikir): pesan gratis tidak dihitung ke jatah pengunjung
    const emptyAnswer = !streamedChars && r.tokensOut > 0 && !openaiStream;
    let balanceMicro = null;
    if (payer.free) {
      if (emptyAnswer) bumpFreeCost(ip, costMicro, clientId);
      else consumeFree(clientId, ip, costMicro);
      recordUsage({ ...usage, cost_micro: costMicro });
    } else balanceMicro = settle(account.id, heldMicro, costMicro, usage);

    const receipt = makeReceipt({ model, r, costMicro, balanceMicro, payer, clientId, freeLimit,
      extra: emptyAnswer ? { empty: true, freeRefunded: !!payer.free } : {} });
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
      const estMicro = Math.ceil(tin * model.in + tout * model.out);   // tarif per 1M token × token = mikro-USD
      const usage = { ...usageBase, tokens_in: tin, tokens_out: tout };
      if (payer.free) { consumeFree(clientId, ip, estMicro); recordUsage({ ...usage, cost_micro: estMicro }); }
      else settle(account.id, heldMicro, estMicro, usage);
      return;
    }
    if (!payer.free) release(account.id, heldMicro);
    console.warn('[chat] hulu gagal', e.message, e.detail || '');
    if (!res.writableEnded) {
      if (openaiStream) sseData(res, { error: { message: errText('upstream'), code: e.status || 502 } });
      else sseEvent(res, 'error', { error: 'upstream', message: errText('upstream') });
      res.end();
    }
  }
}

// /v1/chat/completions tanpa stream — jawaban hulu diteruskan utuh + kolom `ghostkey_receipt`.
export async function runChatJson(req, res, { account, body, clientId, ip, freeLimit = config.freeApiCalls }) {
  const err = (status, code) => sendJson(res, status, { error: { message: errText(code), code: code === 'top_up' ? 'insufficient_balance' : code } });
  const model = await modelInfo(body.model);
  if (!model) return err(400, 'bad_model');
  const messages = cleanMessages(body.messages);
  if (!messages) return err(400, 'bad_messages');
  if (hasImage(messages) && !model.vision) return err(400, 'vision');
  const payer = pickPayer({ account, model, clientId, ip, freeLimit, api: true });
  if (payer.error) return err(402, payer.error);
  const want = Math.min(Math.max(MIN_TOKENS, Number(body.max_tokens || body.max_completion_tokens) || 4096), 32000);
  let maxTokens, heldMicro = 0;
  if (payer.free) maxTokens = Math.min(want, config.freeMaxTokens);
  else {
    maxTokens = fitMaxTokens(model, messages, microToUsd(available(account.id)), want);
    if (maxTokens < MIN_TOKENS) return err(402, 'top_up');
    heldMicro = usdToMicro(estimateMaxUsd(model, messages, maxTokens)) + 1;
    if (!hold(account.id, heldMicro)) return err(402, 'top_up');
  }
  try {
    const r = await completeChat({ model, messages, maxTokens, extra: pickAllowed(body) });
    const costMicro = Math.round(r.costUsd * 1e6);   // dibulatkan ke mikro-USD terdekat (bukan ke atas)
    const usage = { account_id: account?.id, client_id: payer.free ? clientId : null, source: payer.source,
      model: model.id, tokens_in: r.tokensIn, tokens_out: r.tokensOut };
    let balanceMicro = null;
    if (payer.free) { consumeFree(clientId, ip, costMicro); recordUsage({ ...usage, cost_micro: costMicro }); }
    else balanceMicro = settle(account.id, heldMicro, costMicro, usage);
    const receipt = makeReceipt({ model, r, costMicro, balanceMicro, payer, clientId, freeLimit });
    const h = { 'X-Ghostkey-Cost': String(receipt.costUsd), 'X-Ghostkey-Rate-In-Per-M': String(model.in),
      'X-Ghostkey-Rate-Out-Per-M': String(model.out) };
    if (payer.free) h['X-Ghostkey-Free-Left'] = String(receipt.freeLeft);
    else h['X-Ghostkey-Balance'] = String(receipt.balanceUsd);
    sendJson(res, 200, { ...r.json, ghostkey_receipt: receipt }, h);
  } catch (e) {
    if (!payer.free) release(account.id, heldMicro);
    sendJson(res, e.status && e.status < 500 ? e.status : 502, { error: { message: errText('upstream'), code: 'upstream_error' } });
  }
}
