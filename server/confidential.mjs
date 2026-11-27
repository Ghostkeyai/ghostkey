// Model Confidential: rute yang dikunci ke satu penyedia yang menjalankan model di dalam enclave perangkat keras (TEE),
// dan HANYA ditampilkan selama laporan atestasi publik penyedia itu benar-benar bisa diambil.
// Sumber: NEAR AI Cloud — Intel TDX (CPU) + NVIDIA Confidential Computing (GPU), laporan tanpa API key:
//   GET https://cloud-api.near.ai/v1/attestation/report?model=<id NEAR>&signing_algo=ecdsa&nonce=<64 hex>
// Pemeriksa publik: https://cloud.near.ai/verify?model=<id NEAR>
// Daftar di bawah hanya berisi model yang punya rute Near AI di daftar ZDR OpenRouter DAN laporan atestasi (dicek 27 Nov 2026).
// gpt-oss-120b sengaja tidak ada: Near AI melayaninya di OpenRouter, tetapi tidak menerbitkan atestasi untuknya.
import { randomBytes } from 'node:crypto';

export const CONF_PROVIDER = { name: 'Near AI', slug: 'near-ai', site: 'https://near.ai', docs: 'https://docs.near.ai/cloud/verification' };
// id OpenRouter → id model di NEAR AI Cloud
export const CONF_MODELS = {
  'z-ai/glm-5.3-flash': 'z-ai/glm-5.3-flash',
  'qwen/qwen3.8-27b': 'Qwen/Qwen3.8-27B',
  'deepseek/deepseek-v4.1-flash-1017': 'deepseek-ai/DeepSeek-V4.1-Flash-1017',
};
export const CONF_SUFFIX = ':confidential';
const REPORT = 'https://cloud-api.near.ai/v1/attestation/report';
export const reportUrl = (nearId) => `${REPORT}?model=${encodeURIComponent(nearId)}&signing_algo=ecdsa`;
export const verifyUrl = (nearId) => `https://cloud.near.ai/verify?model=${encodeURIComponent(nearId)}`;

const TTL = 30 * 60_000;            // laporan diambil ulang tiap 30 menit
const FAIL_RETRY = 5 * 60_000;
const status = new Map();           // id OpenRouter → { ok, at, tdx, gpu, signer, error }
let running = null;

async function checkOne(orId, nearId) {
  const nonce = randomBytes(32).toString('hex');
  try {
    const r = await fetch(`${reportUrl(nearId)}&nonce=${nonce}`, { headers: { 'x-no-aliasing': 'true', accept: 'application/json' }, signal: AbortSignal.timeout(25000) });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const j = await r.json();
    const att = (j.model_attestations || []).filter((a) => a && a.intel_quote && a.request_nonce === nonce);
    if (!att.length) throw new Error('no model attestation for this nonce');
    status.set(orId, { ok: true, at: Date.now(), tdx: true, gpu: att.some((a) => !!a.nvidia_payload), signer: att[0].signing_address || null, nodes: att.length });
  } catch (e) {
    const prev = status.get(orId);
    // Satu kegagalan sesaat tidak langsung mencabut label; dua jam tanpa laporan sukses → dicabut.
    const keep = prev?.ok && Date.now() - prev.at < 2 * 3600_000;
    status.set(orId, keep ? { ...prev, lastError: e.message, lastErrorAt: Date.now() } : { ok: false, at: Date.now(), error: e.message });
    console.warn('[confidential] atestasi gagal', orId, e.message);
  }
}

export async function refreshAttestations(force = false) {
  const due = Object.keys(CONF_MODELS).filter((id) => {
    const s = status.get(id);
    return force || !s || Date.now() - (s.lastErrorAt || s.at) > (s.ok ? TTL : FAIL_RETRY);
  });
  if (!due.length) return status;
  if (!running) running = Promise.all(due.map((id) => checkOne(id, CONF_MODELS[id]))).finally(() => { running = null; });
  await running;
  return status;
}

export const attestation = (orId) => status.get(orId) || null;

// Info publik untuk satu varian Confidential
export function confInfo(orId) {
  const nearId = CONF_MODELS[orId];
  const s = status.get(orId);
  return {
    provider: CONF_PROVIDER.name, nearModel: nearId,
    verify: verifyUrl(nearId), report: reportUrl(nearId), docs: CONF_PROVIDER.docs,
    tee: s?.gpu ? 'Intel TDX + NVIDIA GPU' : 'Intel TDX',
    checkedAt: s?.ok ? new Date(s.at).toISOString() : null,
  };
}
