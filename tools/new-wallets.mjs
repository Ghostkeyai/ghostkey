// Buat dompet server GHOSTKEY sekali saja. Hasil disimpan di .secrets/ (chmod 600), TIDAK pernah dicetak ke layar:
//   GHOST_MNEMONIC  m/44'/60'/0'/0/0 = dompet fee $GHOST (creatorFeeRecipient saat launch di Pons)
//                   m/44'/60'/1'/0/0 = dompet gas + poster GhostLedger (isi sedikit ETH)
//   TREASURY        dompet terpisah: tujuan top-up + pool Ghost Credit (25%)
// OWNER_WALLET (75%) adalah dompet milik pemilik sendiri — tidak dibuat di sini.
// Tidak menimpa berkas yang sudah ada.
import { Wallet, HDNodeWallet } from 'ethers';
import { existsSync, writeFileSync, chmodSync, mkdirSync } from 'node:fs';

const DIR = new URL('../.secrets/', import.meta.url);
const JSON_OUT = new URL('ghostkey-wallets.json', DIR);
const ENV_OUT = new URL('ghostkey-wallets.env', DIR);
mkdirSync(DIR, { recursive: true, mode: 0o700 });
if (existsSync(JSON_OUT) || existsSync(ENV_OUT)) {
  console.log('.secrets/ghostkey-wallets.* already exists — not overwritten.');
  process.exit(0);
}

const phrase = Wallet.createRandom().mnemonic.phrase;
const at = (path) => HDNodeWallet.fromPhrase(phrase, undefined, path).address;
const treasury = Wallet.createRandom();
const data = {
  createdAt: new Date().toISOString(),
  GHOST_MNEMONIC: phrase,
  feeWallet: at("m/44'/60'/0'/0/0"),
  gasAndPosterWallet: at("m/44'/60'/1'/0/0"),
  TREASURY_ADDRESS: treasury.address,
  treasuryPrivateKey: treasury.privateKey,
  note: 'feeWallet = creatorFeeRecipient for $GHOST on Pons. gasAndPosterWallet pays gas for fee claims and is the GhostLedger poster (deploy the contract with this address). Treasury receives top-ups and the holder share; import its private key into a wallet to move funds.',
};
writeFileSync(JSON_OUT, JSON.stringify(data, null, 2), { mode: 0o600 });
writeFileSync(ENV_OUT, `# Salin baris ini ke .env server (JANGAN commit)\nGHOST_MNEMONIC=${phrase}\nTREASURY_ADDRESS=${treasury.address}\n`, { mode: 0o600 });
chmodSync(JSON_OUT, 0o600);
chmodSync(ENV_OUT, 0o600);

// Hanya alamat publik yang dicetak — mnemonic & kunci privat tetap di .secrets/
console.log('Saved to .secrets/ghostkey-wallets.json and .secrets/ghostkey-wallets.env (mode 600).');
console.log('Fee wallet (set as $GHOST creator fee recipient at launch):', data.feeWallet);
console.log('Gas + ledger poster wallet (send ~0.003 ETH):        ', data.gasAndPosterWallet);
console.log('Treasury (top-ups + holder pool):                    ', data.TREASURY_ADDRESS);
