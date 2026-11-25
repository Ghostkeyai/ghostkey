// Pembaca token $GHOST untuk mesin Ghost Credit (produksi). Tes memakai pembaca tiruan dengan bentuk yang sama:
//   { token, decimals(), latestBlock(), blockAt(ts), holders(toBlock), balancesAt(addresses, block), systemExclusions() }
// Semua lewat rpc.mjs (titik RPC berotasi). Membaca saldo di blok lama butuh titik RPC arsip.
import { Interface, getAddress } from 'ethers';
import { provider, rpcCall } from './rpc.mjs';
import { ERC20_ABI } from './abi.mjs';
import { ponsSystemAddresses } from './pons.mjs';

const MULTICALL3 = '0xcA11bde05977b3631167028862bE2a173976CA11';   // dicek on-chain: ada di chain 4663
const mcIface = new Interface(['function aggregate3((address target,bool allowFailure,bytes callData)[] calls) view returns ((bool success,bytes returnData)[])']);
const erc20 = new Interface(ERC20_ABI);
const TOPIC_TRANSFER = erc20.getEvent('Transfer').topicHash;
const hex = (n) => '0x' + BigInt(n).toString(16);

// Penyimpan status sederhana (dipakai untuk cache pemegang). Bawaan: memori; server memberi kv DB.
export function createTokenReader(token, { store, deployBlock = 0, logChunk = 50_000 } = {}) {
  const tok = getAddress(token);
  const p = provider();
  const mem = new Map();
  const st = store || { get: (k) => mem.get(k) ?? null, set: (k, v) => mem.set(k, v) };
  const tsCache = new Map();

  async function blockTs(n) {
    if (tsCache.has(n)) return tsCache.get(n);
    const b = await p.getBlock(n);
    if (!b) throw new Error(`block ${n} not found`);
    tsCache.set(n, b.timestamp);
    if (tsCache.size > 5000) tsCache.clear();
    return b.timestamp;
  }

  // Blok deploy token: dari env, cache, atau pencarian biner eth_getCode (butuh RPC arsip)
  async function findDeployBlock() {
    if (deployBlock > 0) return deployBlock;
    const cached = st.get(`deploy:${tok}`);
    if (cached) return cached;
    let lo = 0, hi = await p.getBlockNumber();
    while (lo < hi) {
      const mid = Math.floor((lo + hi) / 2);
      const code = await rpcCall('eth_getCode', [tok, hex(mid)]).catch(() => '0x');
      if (code && code !== '0x') hi = mid; else lo = mid + 1;
    }
    st.set(`deploy:${tok}`, lo);
    return lo;
  }

  return {
    token: tok,
    async decimals() {
      const r = await rpcCall('eth_call', [{ to: tok, data: erc20.encodeFunctionData('decimals', []) }, 'latest']);
      return Number(erc20.decodeFunctionResult('decimals', r)[0]);
    },
    latestBlock: () => p.getBlockNumber(),

    // Blok terakhir dengan timestamp ≤ ts (keadaan rantai pada detik itu)
    async blockAt(ts, minBlock = 0) {
      let lo = Math.max(0, minBlock), hi = await p.getBlockNumber();
      if ((await blockTs(hi)) <= ts) return hi;
      if ((await blockTs(lo)) > ts) throw new Error(`no block at or before ${ts}`);
      while (hi - lo > 1) {
        const mid = Math.floor((lo + hi) / 2);
        if ((await blockTs(mid)) <= ts) lo = mid; else hi = mid;
      }
      return lo;
    },

    // Semua alamat yang pernah MENERIMA $GHOST (event Transfer) sampai toBlock; dipindai bertahap & disimpan.
    async holders(toBlock) {
      const key = `holders:${tok}`;
      const saved = st.get(key) || { scanned: (await findDeployBlock()) - 1, list: [] };
      const set = new Set(saved.list);
      let from = saved.scanned + 1, chunk = logChunk;
      while (from <= toBlock) {
        const to = Math.min(toBlock, from + chunk - 1);
        let logs;
        try {
          logs = await rpcCall('eth_getLogs', [{ address: tok, topics: [TOPIC_TRANSFER], fromBlock: hex(from), toBlock: hex(to) }]);
        } catch (e) {
          if (chunk > 500) { chunk = Math.floor(chunk / 4); continue; }   // rentang terlalu besar → perkecil
          throw e;
        }
        for (const l of logs) if (l.topics?.[2]) set.add(('0x' + l.topics[2].slice(26)).toLowerCase());
        st.set(key, { scanned: to, list: [...set] });
        from = to + 1;
      }
      return [...set];
    },

    // Saldo banyak alamat pada satu blok lewat Multicall3 (batch 150). → Map(alamat → bigint)
    async balancesAt(addresses, block) {
      const out = new Map();
      for (let i = 0; i < addresses.length; i += 150) {
        const part = addresses.slice(i, i + 150);
        const calls = part.map((a) => ({ target: tok, allowFailure: true, callData: erc20.encodeFunctionData('balanceOf', [a]) }));
        const data = mcIface.encodeFunctionData('aggregate3', [calls]);
        const r = await rpcCall('eth_call', [{ to: MULTICALL3, data }, hex(block)]);
        const [res] = mcIface.decodeFunctionResult('aggregate3', r);
        res.forEach((x, j) => {
          if (!x.success) throw new Error(`balanceOf failed for ${part[j]} at block ${block}`);
          out.set(part[j].toLowerCase(), BigInt(erc20.decodeFunctionResult('balanceOf', x.returnData)[0]));
        });
      }
      return out;
    },

    systemExclusions: () => ponsSystemAddresses(tok),
  };
}
