// Privasi GHOSTKEY — SATU-SATUNYA tempat permintaan ke OpenRouter dibentuk.
// Dipakai chat web (/api/chat), API (/v1/chat/completions), dan inspector publik (/api/inspect),
// jadi yang diperlihatkan inspector = yang benar-benar dikirim.
//
// Yang TIDAK pernah ikut ke hulu:
//   - IP, user agent, cookie, atau header apa pun dari klien (header di bawah ditulis tetap oleh server);
//   - dompet & ID akun (tidak ada kolomnya di badan permintaan);
//   - kolom `user`, `metadata`, `provider` dari klien, dan kolom lain di luar daftar izin.
// Yang SELALU dipaksa: provider: { zdr: true, data_collection: 'deny' } → hanya penyedia Zero Data Retention.
import { config } from './config.mjs';

export const UPSTREAM_URL = 'https://openrouter.ai/api/v1/chat/completions';
export const ZDR_LIST_URL = 'https://openrouter.ai/api/v1/endpoints/zdr';

// Yang dicopot sebelum permintaan meninggalkan server (ditampilkan di struk & inspector)
export const STRIPPED = ['ip_address', 'user_agent', 'cookies', 'wallet_address', 'account_id', 'user_field'];

// Parameter OpenAI dari klien yang boleh diteruskan (selain model, messages, stream, max_tokens)
export const ALLOWED_EXTRA = ['temperature', 'top_p', 'stop', 'tools', 'tool_choice', 'response_format', 'seed',
  'presence_penalty', 'frequency_penalty'];

// Kebijakan penyedia yang selalu dipaksa (tidak bisa ditimpa klien)
export const FORCED_PROVIDER = Object.freeze({ zdr: true, data_collection: 'deny' });

// Ambil hanya parameter yang diizinkan dari badan klien.
export function pickAllowed(body = {}) {
  const o = {};
  for (const k of ALLOWED_EXTRA) if (body[k] !== undefined) o[k] = body[k];
  return o;
}

// Kolom badan klien yang dibuang (untuk ditampilkan apa adanya)
const KNOWN = new Set(['model', 'messages', 'stream', 'max_tokens', 'max_completion_tokens', ...ALLOWED_EXTRA]);
export function droppedFields(body = {}) {
  return Object.keys(body || {}).filter((k) => !KNOWN.has(k));
}

/**
 * Bentuk permintaan hulu.
 * { modelId, messages, maxTokens, stream, extra, reasoningOff } →
 *   { url, headers, body }
 * - extra disaring lagi di sini (pertahanan berlapis): hanya ALLOWED_EXTRA yang lolos.
 * - reasoningOff: opsi SERVER (bukan dari klien) untuk pesan gratis — mematikan "thinking" tersembunyi.
 * - only: opsi SERVER dari katalog (varian Confidential) — satu penyedia saja, tanpa fallback. ZDR tetap dipaksa.
 */
export function buildUpstream({ modelId, messages, maxTokens, stream = false, extra = {}, reasoningOff = false, only = null }) {
  const body = {
    ...pickAllowed(extra),
    model: modelId,
    messages,
    stream: !!stream,
    max_tokens: maxTokens,
    usage: { include: true },
    provider: { ...FORCED_PROVIDER, ...(only ? { only: [only], allow_fallbacks: false } : {}) },
  };
  if (reasoningOff) body.reasoning = { enabled: false };
  return {
    url: UPSTREAM_URL,
    headers: {
      Authorization: `Bearer ${config.openrouterKey || 'sk-or-mock'}`,
      'Content-Type': 'application/json',
      'HTTP-Referer': config.publicUrl,
      'X-Title': config.appTitle,
      // Ditulis eksplisit supaya runtime tidak menambah user agent lain; ini milik server, bukan pengguna.
      'User-Agent': 'GHOSTKEY-gateway',
    },
    body,
  };
}

// Potong string sangat panjang (mis. gambar data:… base64) supaya struk tetap ringan dibaca.
function shorten(v) {
  if (typeof v === 'string') {
    if (v.startsWith('data:') && v.length > 120) return `${v.slice(0, 40)}…(${Math.round(v.length / 1024)} KB, shortened for display)`;
    return v;
  }
  if (Array.isArray(v)) return v.map(shorten);
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, shorten(x)]));
  return v;
}

// Salinan aman untuk ditampilkan: kunci bersama disembunyikan, gambar base64 dipendekkan.
export function redactForDisplay(upstream) {
  return {
    url: upstream.url,
    method: 'POST',
    headers: { ...upstream.headers, Authorization: 'Bearer sk-or-…(GHOSTKEY shared key, hidden)' },
    body: shorten(upstream.body),
  };
}

// Header masuk yang tidak pernah diteruskan (semua header klien dibuang; daftar nama saja, tanpa nilai)
export function incomingNotSent(req) {
  const names = Object.keys(req.headers || {}).map((h) => h.toLowerCase());
  return ['ip_address (your connection address)', ...names];
}
