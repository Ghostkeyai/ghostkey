// Send one message through the GHOSTKEY API and recompute the bill from its receipt.
// Usage: GHOSTKEY_KEY=gk_live_... node tools/verify/receipt.mjs [https://ghostkeyai.com] [model]
// A new key with zero balance works on budget models through its 10 free calls.
const BASE = String(process.argv[2] || 'https://ghostkeyai.com').replace(/\/+$/, '');
const model = process.argv[3] || 'openai/gpt-oss-120b';
const r = await fetch(`${BASE}/v1/chat/completions`, {
  method: 'POST',
  headers: { Authorization: `Bearer ${process.env.GHOSTKEY_KEY}`, 'Content-Type': 'application/json' },
  body: JSON.stringify({ model, messages: [{ role: 'user', content: 'Say hello in five words.' }] }),
});
const j = await r.json();
if (!r.ok) { console.log(r.status, j); process.exit(1); }
const rc = j.ghostkey_receipt;
console.log(`answer: ${j.choices[0].message.content}`);
console.log(`tokens: ${rc.tokensIn} in, ${rc.tokensOut} out · rates $${rc.rateIn} / $${rc.rateOut} per 1M`);
console.log(`OpenRouter usage.cost: ${j.usage?.cost ?? '(not returned)'} · billed: $${rc.costUsd} (${rc.paidBy})`);
const up = j.usage?.cost;
if (up != null) console.log(Math.abs(Math.round(up * 1e6) / 1e6 - rc.costUsd) < 1e-9 ? 'MATCH: billed = OpenRouter cost' : 'DIFFERENT from OpenRouter cost');
console.log('forwarded provider policy:', JSON.stringify(rc.forwarded.body.provider));
console.log('fields sent upstream:', Object.keys(rc.forwarded.body).join(', '));
