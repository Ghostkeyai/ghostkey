// Penilai request fitur dari member grup (dipakai guard.mjs). Tanpa dependensi.
// classifyRequest(text) → { kind, verdict, title, reason, match } lewat OpenRouter (ZDR dipaksa), suhu 0.
//   kind    : 'feature_request' | 'not_a_request'
//   verdict : 'good' | 'on_roadmap' | 'conflicts_privacy' | 'market_request' | 'vague'
// Daftar ROADMAP di bawah WAJIB disamakan dengan web/roadmap.html setiap kali roadmap berubah.

export const ROADMAP = {
  shipped: ['243 AI models on zero-data-retention routes', 'OpenRouter price with no markup and a Compare button', 'Privacy inspector',
    'OpenAI-compatible API with keys', 'GhostLedger contract (hourly Merkle roots)', 'Proof page and public code on GitHub',
    '$GHOST on Pons with a fixed 2% creator tax', 'Hourly Ghost Credit for holders (25% of creator fees)',
    'Holder perks: 30 free messages/day, 30 free API calls/day, 600 API requests/min', 'Live creator-fee meter',
    'Telegram agent and anti-spam filter', 'On-chain buy alerts and hourly payout posts in the group', 'DEX Screener chart on the site', 'A receipt for every request (generation ID, cost, hash, check against OpenRouter, CSV export)',
    'Spend caps on API keys: a daily USD limit per key and an expiry date', 'Personas saved only in your browser, not our database; their instructions pass through the server with each message like any prompt and are not stored (shown in What we sent)',
    'Monthly fee report at ghostkeyai.com/report: fees claimed, 25% holders, 75% team, gas kept, Ghost Credit paid, nine checks, and a script that re-checks every transfer and root on-chain',
    'Chat with your PDFs, privately (text extracted in the browser, file never uploaded)',
    'Confidential (TEE) models at NEAR AI, labelled with attestation links',
    'Web search, off by default, one message at a time: Exa through OpenRouter, sources listed, $0.007 per search, the screen says Exa keeps its own logs'],
  next: [],
  later: ['Private image generation (zero-retention models only)', 'Encrypted chat history export, then cross-device sync',
    'Side-by-side answers from several models with cost', 'Voice input through audio models', 'Team workspaces',
    'Holders suggest which models to add', 'Use GHOSTKEY from Telegram DMs (labelled as not private)'],
};

// pesan yang mungkin berisi usulan (saringan murah sebelum memanggil model)
export const REQ_HINT = /\b(you should|we should|u should|devs? should|team should|add|adding|feature|request|would be (nice|great|cool|good|sick|awesome|dope|helpful)|can (you|we|u|the team|devs?) (add|make|build|get|do|support|integrate)|please (add|make|build|support|integrate)|should (add|have|support|build|integrate)|suggest\w*|idea|wish|integrat\w*|support for|implement\w*|could you|why not|how about|need(s)? (a|an|to have)|would love)\b/i;

const SYSTEM = `You triage feature requests posted in the Telegram group of GHOSTKEY, a private AI gateway with a token.

## What GHOSTKEY is
- Chat and an OpenAI-compatible API for 243 AI models via OpenRouter. Every request is forced to zero-data-retention providers. The server strips wallet, IP, device and cookies before forwarding, and never stores prompts or answers (only model, tokens, cost, time). Chat history lives in the user's browser.
- Price = OpenRouter's cost, no markup. Prepaid balance in USDG or ETH on Robinhood Chain.
- $GHOST token on Pons (Robinhood Chain). 2% creator tax; every hour 25% of creator fees becomes AI credit ("Ghost Credit") for wallets averaging 100k+ $GHOST, 75% goes to the team; each hour's list gets a Merkle root on an ownerless contract.
- Culture: every claim must be checkable; no promises about price or profit; small team.

## Roadmap
Shipped: ${ROADMAP.shipped.join('; ')}
Next (being built): ${ROADMAP.next.join('; ') || 'every Next item has shipped; new ones will be picked from Later and announced'}
Later (no dates): ${ROADMAP.later.join('; ')}

## Decide
kind:
- "feature_request": the message asks for or suggests something the PRODUCT or the group bot could do or change.
- "not_a_request": questions about how things work, price talk, greetings, complaints with no concrete ask, jokes, anything else.

verdict (only for feature_request; otherwise use "none"):
- "on_roadmap": essentially the same as a Shipped, Next or Later item. Put that item's exact title in "match". If it is already Shipped, say so in "reason".
- "good": fits a private AI gateway, keeps the privacy promise (no stored prompts, nothing identifying sent to models), is realistically buildable by a small team on OpenRouter + Robinhood Chain + Telegram, and clearly helps people use GHOSTKEY or makes holding $GHOST more useful inside the product.
- "conflicts_privacy": would need storing chats or prompts on the server, KYC, sending wallet/IP/identity to models or third parties, analytics or tracking of users, or calling something private when it is not.
- "market_request": about price, chart, pumps, trending, listings (CEX, CoinGecko, CMC), buybacks, burns, marketing, KOLs, giveaways, airdrops, yield/staking APY, partnerships. Not a product feature.
- "vague": too vague to act on ("more utility", "make it better", "add AI stuff") or unrealistic for a small team.

Be strict. A request that sounds nice but quietly breaks the privacy promise is "conflicts_privacy". A token-price mechanic dressed as a feature is "market_request".

Return ONLY one JSON object, no prose:
{"kind":"feature_request|not_a_request","verdict":"good|on_roadmap|conflicts_privacy|market_request|vague|none","title":"short product-style title, max 8 words, empty if not a request","reason":"one short friendly sentence to the member in plain English, no promises of dates, no emoji","match":"exact roadmap title or empty"}`;

export async function classifyRequest(text, { orKey, model = 'anthropic/claude-sonnet-5.5', timeoutMs = 45_000 } = {}) {
  if (!orKey) return null;
  const r = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: { authorization: `Bearer ${orKey}`, 'content-type': 'application/json', 'HTTP-Referer': 'https://ghostkeyai.com', 'X-Title': 'GHOSTKEY Guard triage' },
    body: JSON.stringify({ model, max_tokens: 2000, reasoning: { effort: 'low' }, provider: { zdr: true, data_collection: 'deny' },
      messages: [{ role: 'system', content: SYSTEM }, { role: 'user', content: `Message from a group member:\n"""${String(text).slice(0, 800)}"""` }] }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const j = await r.json();
  const out = j.choices?.[0]?.message?.content || '';
  const m = out.match(/\{[\s\S]*\}/);
  if (!m) return null;
  try {
    const v = JSON.parse(m[0]);
    const kinds = ['feature_request', 'not_a_request'], verdicts = ['good', 'on_roadmap', 'conflicts_privacy', 'market_request', 'vague', 'none'];
    if (!kinds.includes(v.kind) || !verdicts.includes(v.verdict)) return null;
    return { kind: v.kind, verdict: v.verdict, title: String(v.title || '').slice(0, 80), reason: String(v.reason || '').slice(0, 300), match: String(v.match || '').slice(0, 120) };
  } catch { return null; }
}
