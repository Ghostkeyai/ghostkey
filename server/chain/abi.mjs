// ABI terverifikasi (Sourcify, chain 4663) dari folder contracts-abi/.
// - PonsV2LaunchFactory.json : Sourcify exact_match 0x7eD598BcEf8bd9Edd8C97A195C6d13f40801EC7e
// - PonsV2FeeEscrow.json     : Sourcify match       0xd3AFEB2a57f70eF218Aa82451c51B2fb0416Ac9e
// - PonsV2BondingCurve.json  : kurva = klon CREATE2 tak terverifikasi → ABI dikompilasi (solc 0.8.35)
//                              dari pohon sumber factory contracts/src/v2/PonsV2BondingCurve.sol
// - PonsV2LauncherToken.json : idem, contracts/src/v2/PonsV2LauncherToken.sol
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const folder = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'contracts-abi');
const baca = (nama) => JSON.parse(readFileSync(join(folder, nama), 'utf8'));

export const FACTORY_ABI = baca('PonsV2LaunchFactory.json');
export const FEE_ESCROW_ABI = baca('PonsV2FeeEscrow.json');
export const CURVE_ABI = baca('PonsV2BondingCurve.json');
export const LAUNCHER_TOKEN_ABI = baca('PonsV2LauncherToken.json');

// ERC-20 minimal (standar, bukan tebakan kontrak tertentu)
export const ERC20_ABI = [
  'function balanceOf(address) view returns (uint256)',
  'function decimals() view returns (uint8)',
  'function symbol() view returns (string)',
  'function totalSupply() view returns (uint256)',
  'event Transfer(address indexed from, address indexed to, uint256 value)',
];
