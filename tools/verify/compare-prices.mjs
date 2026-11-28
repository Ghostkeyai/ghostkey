#!/usr/bin/env node
// Compare every GHOSTKEY model rate with OpenRouter's public list, and check each model is on
// OpenRouter's public Zero Data Retention list. No keys needed.
//   node tools/verify/compare-prices.mjs [https://ghostkeyai.com]
// Exit code 0 = all rates equal and all models ZDR, 1 = a difference, 2 = network error.
const BASE = String(process.argv[2] || 'https://ghostkeyai.com').replace(/\/+$/, '');
let ours, or, zdr;
try {
  [ours, or, zdr] = await Promise.all([
    fetch(`${BASE}/api/models`).then((r) => r.json()),
    fetch('https://openrouter.ai/api/v1/models').then((r) => r.json()),
    fetch('https://openrouter.ai/api/v1/endpoints/zdr').then((r) => r.json()),
  ]);
} catch (e) { console.error('network error:', e.message); process.exit(2); }

const perM = (x) => +(Number(x || 0) * 1e6).toFixed(4);
const orBy = new Map(or.data.map((m) => [m.id, m]));
const zdrIds = new Set(zdr.data.map((e) => e.model_id));
// Confidential variants ("<id>:confidential") are the same OpenRouter model locked to one provider:
// check the base id on the ZDR list, and compare the price with that provider's own line on it.
const confLine = (m) => zdr.data.find((e) => e.model_id === m.baseId && e.provider_name === m.confidential?.provider) || null;
let match = 0, gone = 0, conf = 0;
const diff = [], notZdr = [];
for (const m of ours) {
  const base = m.baseId || m.id;
  if (!zdrIds.has(base) || (m.confidential && !confLine(m))) notZdr.push(m.id);
  if (m.confidential) conf++;
  const o = m.confidential ? confLine(m) : orBy.get(m.id);
  if (!o) { gone++; continue; }
  const oin = perM(o.pricing.prompt), oout = perM(o.pricing.completion);
  if (oin === m.in && oout === m.out) match++;
  else diff.push(`${m.id}: GHOSTKEY $${m.in}/$${m.out} vs OpenRouter $${oin}/$${oout} per 1M tokens`);
}
console.log(`${ours.length} GHOSTKEY models`);
console.log(`  ${match} rates equal to OpenRouter (input and output, USD per 1M tokens)`);
console.log(`  ${diff.length} different${gone ? `, ${gone} no longer listed by OpenRouter (catalog refreshes hourly)` : ''}`);
console.log(`  ${ours.length - notZdr.length} on OpenRouter's public ZDR list, ${notZdr.length} not`);
if (conf) console.log(`  ${conf} Confidential routes compared with their provider's own line on the ZDR list`);
for (const d of diff.slice(0, 20)) console.log('   ', d);
for (const id of notZdr.slice(0, 20)) console.log('    not ZDR:', id);
console.log('\nThe price billed per answer is the usage.cost OpenRouter returns for that call; it is shown in each receipt.');
process.exit(diff.length || notZdr.length ? 1 : 0);
