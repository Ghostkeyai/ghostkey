// Verify who receives a Pons coin's creator fees, straight from the Pons V2 factory.
// Usage: node tools/verify/fee-recipient.mjs <tokenAddress> [expectedRecipient]
import { Contract, JsonRpcProvider, getAddress } from 'ethers';

const RPC = process.env.RPC || 'https://robinhood-rpc.publicnode.com';
const FACTORY = '0x7eD598BcEf8bd9Edd8C97A195C6d13f40801EC7e';
const [token, expected] = process.argv.slice(2);
if (!/^0x[0-9a-fA-F]{40}$/.test(token || '')) {
  console.log('usage: node tools/verify/fee-recipient.mjs <token> [expected]');
  process.exit(1);
}
const abi = ['function getLaunchedToken(address) view returns (address token,address curve,address deployer,address creatorFeeRecipient,address pairToken,uint256 graduationThreshold,uint24 poolFee,int24 tickSpacing,uint16 creatorTaxBps)'];
const f = new Contract(FACTORY, abi, new JsonRpcProvider(RPC, 4663, { staticNetwork: true }));
const r = await f.getLaunchedToken(token);
console.log('token               ', r.token);
console.log('deployer            ', r.deployer);
console.log('creatorFeeRecipient ', r.creatorFeeRecipient);
console.log('creator tax         ', Number(r.creatorTaxBps) / 100 + '%');
if (expected) {
  const ok = getAddress(expected) === getAddress(r.creatorFeeRecipient);
  console.log(ok ? 'MATCH: fees go to the expected wallet' : 'MISMATCH');
  process.exit(ok ? 0 : 2);
}
