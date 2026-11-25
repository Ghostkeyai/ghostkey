// Show where the ETH of GHOSTKEY fee-claim transactions went (25% treasury / 75% owner split check).
// Usage: node tools/verify/harvest.mjs <txHash> [<txHash> ...]
import { JsonRpcProvider, formatEther } from 'ethers';

const p = new JsonRpcProvider(process.env.RPC || 'https://robinhood-rpc.publicnode.com', 4663, { staticNetwork: true });
for (const h of process.argv.slice(2)) {
  const t = await p.getTransaction(h);
  if (!t) { console.log(h, 'not found'); continue; }
  console.log(`${h}\n  from ${t.from}\n  to   ${t.to}\n  ETH  ${formatEther(t.value)}`);
}
