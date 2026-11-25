// Dompet HD server dari env GHOST_MNEMONIC.
//   feeWallet(0): m/44'/60'/0'/0/0  — penerima creator fee $GHOST di Pons (dipanen tiap jam)
//   gasWallet():  m/44'/60'/1'/0/0  — sumber gas untuk dompet fee + pengirim (poster) GhostLedger
// Mnemonic tidak pernah dicatat ke log.
import { HDNodeWallet, Mnemonic } from 'ethers';
import { chainConfig } from './config.mjs';
import { provider } from './rpc.mjs';

let cacheFrase = null;
let cacheMnemonic = null;

function mnemonic() {
  const frase = chainConfig().mnemonic.trim();
  if (!frase) throw new Error('GHOST_MNEMONIC belum diisi');
  if (frase !== cacheFrase) {
    cacheMnemonic = Mnemonic.fromPhrase(frase); // melempar kalau frase tidak sah
    cacheFrase = frase;
  }
  return cacheMnemonic;
}

function turunkan(path) {
  const signer = HDNodeWallet.fromMnemonic(mnemonic(), path).connect(provider());
  return { address: signer.address, signer };
}

export function feeWallet(index) {
  const i = Number(index);
  if (!Number.isInteger(i) || i < 0 || i >= 2 ** 31) throw new Error(`index dompet fee tidak sah: ${index}`);
  return turunkan(`m/44'/60'/0'/0/${i}`);
}

export function gasWallet() {
  return turunkan(`m/44'/60'/1'/0/0`);
}

export function hasMnemonic() {
  return Boolean(chainConfig().mnemonic.trim());
}
