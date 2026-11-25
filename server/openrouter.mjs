import { createHash } from 'node:crypto';
// Penghubung ke OpenRouter: katalog model (hanya yang punya penyedia ZDR) + chat (streaming & biasa).
// Badan & header permintaan hulu SELALU dibentuk oleh privacy.mjs buildUpstream().
import { config } from './config.mjs';
import { kvGet, kvSet } from './db.mjs';
import { buildUpstream, ZDR_LIST_URL } from './privacy.mjs';

const BASE = 'https://openrouter.ai/api/v1';
const CATALOG_TTL = 60 * 60_000;     // 1 jam
let catalog = null;                  // { at, list, byId, source }
let refreshing = null;

// Nama lab yang rapi untuk ditampilkan
const LABS = {
  openai: 'OpenAI', anthropic: 'Anthropic', google: 'Google', 'x-ai': 'xAI', deepseek: 'DeepSeek',
  'meta-llama': 'Meta', meta: 'Meta', mistralai: 'Mistral', qwen: 'Qwen', moonshotai: 'Moonshot', 'z-ai': 'Z.ai',
  minimax: 'MiniMax', cohere: 'Cohere', nvidia: 'NVIDIA', perplexity: 'Perplexity', microsoft: 'Microsoft',
  amazon: 'Amazon', tencent: 'Tencent', baidu: 'Baidu',
};
const perM = (perTok) => +(Number(perTok || 0) * 1e6).toFixed(4);   // USD per 1 juta token

// Gabungkan daftar model + daftar endpoint ZDR → hanya model teks berbayar yang punya ≥1 endpoint ZDR.
export function mergeCatalog(models, zdrEndpoints) {
  const zdrBy = new Map();
  for (const e of zdrEndpoints || []) {
    if (!e?.model_id) continue;
    if (!zdrBy.has(e.model_id)) zdrBy.set(e.model_id, []);
    zdrBy.get(e.model_id).push(e);
  }
  const list = [];
  for (const m of models || []) {
    const eps = zdrBy.get(m.id);
    if (!eps?.length) continue;
    if (!(Number(m.pricing?.prompt) >= 0 && Number(m.pricing?.completion) > 0)) continue;   // buang ":free" & harga aneh
    if (!(m.architecture?.output_modalities || ['text']).includes('text')) continue;
    const inM = perM(m.pricing.prompt), outM = perM(m.pricing.completion);
    // Harga endpoint ZDR termahal — hanya untuk menahan saldo dengan aman (tagihan tetap usage.cost dari OpenRouter)
    const zdrMaxIn = Math.max(inM, ...eps.map((e) => perM(e.pricing?.prompt)));
    const zdrMaxOut = Math.max(outM, ...eps.map((e) => perM(e.pricing?.completion)));
    const [labKey] = m.id.split('/');
    list.push({
      id: m.id,
      name: String(m.name || m.id).replace(/^[^:]+:\s*/, ''),
      lab: LABS[labKey] || labKey,
      context: m.context_length || 0,
      in: inM,
      out: outM,
      vision: (m.architecture?.input_modalities || []).includes('image'),
      tools: (m.supported_parameters || []).includes('tools'),
      freeEligible: outM > 0 && zdrMaxOut <= config.freeMaxOutPerM,
      zdr: true,
      zdrProviders: [...new Set(eps.map((e) => e.provider_name).filter(Boolean))].sort(),
      zdrMaxIn, zdrMaxOut,
      created: m.created || 0,
    });
  }
  list.sort((a, b) => b.created - a.created);
  return list;
}

// Bentuk publik /api/models
export const publicModel = (m) => ({
  id: m.id, name: m.name, lab: m.lab, context: m.context, in: m.in, out: m.out, vision: m.vision, tools: m.tools,
  freeEligible: m.freeEligible, zdr: m.zdr, zdrProviders: m.zdrProviders, zdrMaxIn: m.zdrMaxIn, zdrMaxOut: m.zdrMaxOut,
});

const setCatalog = (list, at, source) => { catalog = { at, list, byId: new Map(list.map((m) => [m.id, m])), source }; return catalog; };

async function fetchJson(url) {
  const r = await fetch(url, { signal: AbortSignal.timeout(20000), headers: { accept: 'application/json' } });
  if (!r.ok) throw new Error(`HTTP ${r.status} ${url}`);
  return r.json();
}

async function refresh() {
  try {
    const [m, z] = await Promise.all([fetchJson(`${BASE}/models`), fetchJson(ZDR_LIST_URL)]);
    const list = mergeCatalog(m.data, z.data);
    if (!list.length) throw new Error('empty ZDR catalog');
    kvSet('catalog', { at: Date.now(), list });
    return setCatalog(list, Date.now(), 'live');
  } catch (e) {
    console.warn('[openrouter] katalog gagal diperbarui:', e.message);
    // Gagal ambil → pakai salinan terakhir di memori, lalu di DB; coba lagi ±1 menit kemudian
    if (catalog?.list.length) { catalog.at = Date.now() - CATALOG_TTL + 60_000; return catalog; }
    const saved = kvGet('catalog');
    return setCatalog(saved?.list || [], Date.now() - CATALOG_TTL + 60_000, saved ? 'db' : 'empty');
  }
}

export async function getCatalog(force = false) {
  if (!force && catalog && Date.now() - catalog.at < CATALOG_TTL) return catalog;
  if (!refreshing) refreshing = refresh().finally(() => { refreshing = null; });
  return refreshing;
}

export async function modelInfo(id) {
  const c = await getCatalog();
  return c.byId.get(String(id || '')) || null;
}

// Perkiraan biaya maksimum (USD) sebelum memanggil — untuk menahan saldo (pakai harga ZDR termahal).
const promptTokEstimate = (messages) => Math.ceil(JSON.stringify(messages).length / 3.2) + 50;
export function estimateMaxUsd(model, messages, maxTokens) {
  return (promptTokEstimate(messages) * model.zdrMaxIn + maxTokens * model.zdrMaxOut) / 1e6;
}

// Token keluaran terbesar yang masih muat di saldo tersedia.
export function fitMaxTokens(model, messages, availableUsd, wanted) {
  const promptUsd = (promptTokEstimate(messages) * model.zdrMaxIn) / 1e6;
  if (model.zdrMaxOut <= 0) return wanted;
  const room = Math.floor(((availableUsd - promptUsd) * 1e6) / model.zdrMaxOut);
  return Math.max(0, Math.min(wanted, room));
}

// Biaya yang ditagih = usage.cost dari OpenRouter (harga OpenRouter, tanpa markup).
// Hanya kalau OpenRouter tidak mengirim angka (atau mode tiruan): hitung dari token × tarif model.
export function billedCost(model, tokensIn, tokensOut, upstream) {
  const rateUsd = (tokensIn * model.in + tokensOut * model.out) / 1e6;
  const up = upstream != null && Number.isFinite(Number(upstream)) ? Number(upstream) : null;
  return { costUsd: up ?? rateUsd, rateUsd, upstreamUsd: up, costSource: up == null ? 'rates' : 'openrouter_usage_cost' };
}

/**
 * Chat streaming. onDelta(chunkObj) dipanggil untuk tiap potongan (format OpenAI).
 * → { tokensIn, tokensOut, costUsd, text, finish, upstream (permintaan yang dikirim) }
 */
export async function streamChat({ model, messages, maxTokens, onDelta, signal, extra = {}, reasoningOff = false }) {
  const up = buildUpstream({ modelId: model.id, messages, maxTokens, stream: true, extra, reasoningOff });
  const bodyStr = JSON.stringify(up.body);
  const forwardedSha256 = sha256(bodyStr);
  if (!config.openrouterKey) return { ...(await mockStream({ model, messages, maxTokens, onDelta })), upstream: up, genId: null, forwardedSha256 };

  const r = await fetch(up.url, { method: 'POST', signal, headers: up.headers, body: bodyStr });
  if (!r.ok) {
    const t = await r.text().catch(() => '');
    const err = new Error(`upstream_${r.status}`);
    err.detail = t.slice(0, 400);
    err.status = r.status;
    throw err;
  }

  let usage = null, text = '', finish = null, buf = '', genId = null;
  const dec = new TextDecoder();
  for await (const part of r.body) {
    buf += dec.decode(part, { stream: true });
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!line.startsWith('data:')) continue;          // baris ": OPENROUTER PROCESSING" diabaikan
      const data = line.slice(5).trim();
      if (data === '[DONE]') continue;
      let obj; try { obj = JSON.parse(data); } catch { continue; }
      if (obj.error) { const e = new Error('upstream_error'); e.detail = JSON.stringify(obj.error).slice(0, 400); throw e; }
      if (!genId && typeof obj.id === 'string' && obj.id.startsWith('gen-')) genId = obj.id;   // ID generasi OpenRouter
      if (obj.usage) usage = obj.usage;               // usage.cost tetap diteruskan: itulah yang ditagihkan
      const ch = obj.choices?.[0];
      if (ch?.delta?.content) text += ch.delta.content;
      if (ch?.finish_reason) finish = ch.finish_reason;
      delete obj.provider;                              // nama penyedia hulu tidak perlu diteruskan
      onDelta?.(obj);
    }
  }
  const tokensIn = usage?.prompt_tokens ?? 0;
  const tokensOut = usage?.completion_tokens ?? 0;
  return { tokensIn, tokensOut, ...billedCost(model, tokensIn, tokensOut, usage?.cost), text, finish, upstream: up, genId, forwardedSha256 };
}

/**
 * Chat tanpa streaming (/v1/chat/completions stream:false) — jawaban hulu diteruskan (tool_calls tetap utuh).
 * → { json, tokensIn, tokensOut, costUsd, upstream }
 */
export async function completeChat({ model, messages, maxTokens, extra = {}, signal }) {
  const up = buildUpstream({ modelId: model.id, messages, maxTokens, stream: false, extra });
  const bodyStr = JSON.stringify(up.body);
  const forwardedSha256 = sha256(bodyStr);
  if (!config.openrouterKey) {
    let text = '';
    const r = await mockStream({ model, messages, maxTokens, onDelta: (c) => { text += c.choices[0].delta.content; } });
    return {
      json: { id: 'gen-mock', object: 'chat.completion', model: model.id, created: Math.floor(Date.now() / 1000),
        choices: [{ index: 0, message: { role: 'assistant', content: text }, finish_reason: 'stop' }],
        usage: { prompt_tokens: r.tokensIn, completion_tokens: r.tokensOut, total_tokens: r.tokensIn + r.tokensOut } },
      ...r, upstream: up, genId: null, forwardedSha256,
    };
  }
  const res = await fetch(up.url, { method: 'POST', signal, headers: up.headers, body: bodyStr });
  const json = await res.json().catch(() => null);
  if (!res.ok || !json || json.error) {
    const err = new Error(`upstream_${res.status}`);
    err.status = res.status; err.detail = JSON.stringify(json?.error ?? json).slice(0, 400);
    throw err;
  }
  const u = json.usage || {};
  const tokensIn = u.prompt_tokens ?? 0, tokensOut = u.completion_tokens ?? 0;
  const b = billedCost(model, tokensIn, tokensOut, u.cost);
  delete json.provider;
  return { json, tokensIn, tokensOut, ...b, upstream: up, genId: typeof json.id === 'string' && json.id.startsWith('gen-') ? json.id : null, forwardedSha256 };
}

const sha256 = (t) => createHash('sha256').update(t, 'utf8').digest('hex');

// Mode tiruan untuk uji lokal tanpa kunci OpenRouter — jawaban jelas berlabel, biaya dihitung dari tarif.
async function mockStream({ model, messages, maxTokens, onDelta }) {
  const lastUser = [...messages].reverse().find((m) => m.role === 'user')?.content ?? '';
  const last = typeof lastUser === 'string' ? lastUser : (lastUser.find?.((p) => p.type === 'text')?.text ?? '');
  const reply = `[Local test mode (mock), no OpenRouter key set] You asked ${model.name}: "${String(last).slice(0, 80)}". ` +
    'Once an OPENROUTER_API_KEY is added, real answers stream here from a zero-retention provider.';
  const words = reply.split(' ').slice(0, Math.max(5, maxTokens));
  let text = '';
  for (const w of words) {
    const piece = (text ? ' ' : '') + w;
    text += piece;
    onDelta?.({ id: 'gen-mock', object: 'chat.completion.chunk', model: model.id, choices: [{ index: 0, delta: { content: piece } }] });
    await new Promise((r) => setTimeout(r, 4));
  }
  const tokensIn = Math.ceil(JSON.stringify(messages).length / 3.2);
  const tokensOut = words.length;
  return { tokensIn, tokensOut, ...billedCost(model, tokensIn, tokensOut, null), text, finish: 'stop' };
}
