// Data publik yang dipakai API (/api/config, /api/stats, /api/proof) dan halaman /proof.
// Semua angka dari DB; alamat yang belum diisi = null (tidak pernah alamat palsu).
import { config, microToUsd, codeUrl } from './config.mjs';
import { q } from './db.mjs';
import { creditStats, ledgerList } from './credit.mjs';
import { recentHarvests } from './harvester.mjs';
import { ZDR_LIST_URL } from './privacy.mjs';

export const BLOCKSCOUT = config.blockscout;
export const addrUrl = (a) => `${BLOCKSCOUT}/address/${a}`;
export const txUrl = (h) => `${BLOCKSCOUT}/tx/${h}`;
export const tokenUrl = (a) => `${BLOCKSCOUT}/token/${a}`;
export const sourcifyUrl = (a) => `https://repo.sourcify.dev/contracts/full_match/${config.chainId}/${a}/`;

const link = (a) => (a ? { address: a, url: addrUrl(a) } : null);

// Alamat dompet fee (penerima creator fee Pons): dari mnemonic server, atau FEE_WALLET untuk tampilan.
let feeAddrCache;
export async function feeWalletAddress() {
  if (feeAddrCache !== undefined) return feeAddrCache;
  try {
    const { hasMnemonic, feeWallet } = await import('./chain/wallets.mjs');
    feeAddrCache = hasMnemonic() ? feeWallet(0).address : (config.feeWalletOverride || null);
  } catch { feeAddrCache = config.feeWalletOverride || null; }
  return feeAddrCache;
}

export function configData() {
  return {
    appTitle: config.appTitle,
    chainId: config.chainId,
    treasury: config.treasury || null,
    owner: config.ownerWallet || null,
    ghostToken: config.ghostToken || null,
    ledger: config.ledgerAddress || null,
    holderShareBps: config.holderShareBps,
    minTokens: config.holderMinTokens,
    freeMessages: config.freeMessages,
    freeApiCalls: config.freeApiCalls,
    freeMaxOutPerM: config.freeMaxOutPerM,
    freeMaxTokens: config.freeMaxTokens,
    holderFreePerDay: config.holderFreePerDay,
    apiRpm: config.apiRpm,
    holderApiRpm: config.holderApiRpm,
    topUpFeeBps: 0,
    minDepositUsd: config.minDepositUsd,
    maxDepositUsd: config.maxDepositUsd,
    usdg: process.env.USDG || '0x5fc5360d0400a0fd4f2af552add042d716f1d168',
    links: config.links,
    blockscout: BLOCKSCOUT,
    publicUrl: config.publicUrl,
    mock: !config.openrouterKey,
  };
}

export function statsData() {
  const u = q.one('SELECT COUNT(*) n, COALESCE(SUM(tokens_in+tokens_out),0) t, COALESCE(SUM(cost_micro),0) c FROM usage');
  const c = creditStats();
  return {
    messages: u.n,
    tokensServed: u.t,
    accounts: q.one("SELECT COUNT(*) n FROM accounts WHERE status='active'").n,
    billedUsd: microToUsd(u.c),
    holderCreditPaidUsd: c.holderCreditPaidUsd,
    hoursPosted: c.hoursPosted,
    lastHour: c.lastHour,
    updatedAt: Date.now(),
  };
}

export async function proofData() {
  const fee = await feeWalletAddress();
  const t = config.ghostToken;
  const l = config.ledgerAddress;
  return {
    chainId: config.chainId,
    blockscout: BLOCKSCOUT,
    contracts: {
      ledger: l ? { address: l, url: addrUrl(l), sourcify: sourcifyUrl(l) } : null,
      token: t ? { address: t, url: tokenUrl(t), pons: config.links.pons || null } : null,
    },
    wallets: {
      fee: link(fee),
      treasury: link(config.treasury),
      owner: link(config.ownerWallet),
      team: config.teamWallets.map(link),
    },
    split: { holderShareBps: config.holderShareBps, ownerShareBps: 10000 - config.holderShareBps },
    minTokens: config.holderMinTokens,
    checks: {
      models: '/api/models',
      openrouterModels: 'https://openrouter.ai/api/v1/models',
      zdrList: ZDR_LIST_URL,
      inspect: '/api/inspect',
      export: '/api/me/export',
      ledger: '/api/ledger',
      depositQuote: '/api/deposit/quote?usd=20',
    },
    code: {
      repo: config.links.github || null,
      privacy: codeUrl('server/privacy.mjs'),
      schema: codeUrl('server/db.mjs'),
      credit: codeUrl('server/credit.mjs'),
      harvester: codeUrl('server/harvester.mjs'),
      recompute: codeUrl('tools/verify/recompute-hour.mjs'),
      comparePrices: codeUrl('tools/verify/compare-prices.mjs'),
      feeRecipient: codeUrl('tools/verify/fee-recipient.mjs'),
      contract: codeUrl('contracts/src/GhostLedger.sol'),
    },
    latestHours: ledgerList(12).map((h) => ({ ...h, txUrl: h.txHash ? txUrl(h.txHash) : null })),
    harvests: recentHarvests(10).map((h) => ({ ...h, txs: h.txs.map((x) => ({ ...x, url: x.txHash ? txUrl(x.txHash) : null })) })),
    stats: statsData(),
    updatedAt: Date.now(),
  };
}
