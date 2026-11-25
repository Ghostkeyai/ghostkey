#!/usr/bin/env bash
# deploy-ledger.sh — memasang kontrak GhostLedger di Robinhood Chain (4663) lalu verifikasi sumber di Sourcify.
#
#   bash tools/deploy-ledger.sh [path/.secrets/ledger.json]            → SIMULASI: build, uji, cek saldo, dry-run. Tidak mengirim apa pun.
#   bash tools/deploy-ledger.sh [path/.secrets/ledger.json] --kirim    → pasang SUNGGUHAN + verifikasi Sourcify
#
# Kunci & poster (pilih salah satu cara):
#   a) env:   DEPLOYER_KEY=0x…  POSTER_ADDRESS=0x…
#   b) file JSON (argumen pertama): { "deployerKey": "0x…", "poster": "0x…" }
#   Kalau poster kosong tapi GHOST_MNEMONIC ada → poster = m/44'/60'/1'/0/0 (dompet gas/poster server).
# Skrip ini TIDAK pernah membuat kunci. Kunci tidak pernah dicetak.
# DEPLOY_RPC=http://127.0.0.1:8545 → uji di anvil (--chain-id 4663); verifikasi Sourcify dilewati.
set -euo pipefail
cd "$(dirname "$0")/.."
ROOT="$(pwd)"
export PATH="$HOME/.local/node/node-v22.23.2-darwin-arm64/bin:$HOME/.foundry/bin:$PATH"

RPC="${DEPLOY_RPC:-https://rpc.mainnet.chain.robinhood.com}"
CHAIN=4663
EXPLORER="https://robinhoodchain.blockscout.com"

SECRETS=""
KIRIM=""
for a in "$@"; do
  case "$a" in
    --kirim) KIRIM=1 ;;
    -h|--help) sed -n '2,13p' "$0"; exit 0 ;;
    *) SECRETS="$a" ;;
  esac
done

# ---- kunci & poster ----
DEPLOYER_KEY="${DEPLOYER_KEY:-}"
POSTER_ADDRESS="${POSTER_ADDRESS:-}"
if [ -n "$SECRETS" ]; then
  [ -f "$SECRETS" ] || { echo "!! File rahasia tidak ditemukan: $SECRETS"; exit 1; }
  # Baca lewat node (tanpa mencetak kunci ke layar).
  DEPLOYER_KEY="${DEPLOYER_KEY:-$(node -e 'const j=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));process.stdout.write(j.deployerKey||j.deployerPrivateKey||j.privateKey||"")' "$SECRETS")}"
  POSTER_ADDRESS="${POSTER_ADDRESS:-$(node -e 'const j=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));process.stdout.write(j.poster||j.posterAddress||"")' "$SECRETS")}"
fi
if [ -z "$POSTER_ADDRESS" ] && [ -n "${GHOST_MNEMONIC:-}" ]; then
  POSTER_ADDRESS="$(node --input-type=module -e "import {HDNodeWallet,Mnemonic} from 'ethers';process.stdout.write(HDNodeWallet.fromMnemonic(Mnemonic.fromPhrase(process.env.GHOST_MNEMONIC.trim()),\"m/44'/60'/1'/0/0\").address)")"
  echo "== poster diturunkan dari GHOST_MNEMONIC (m/44'/60'/1'/0/0): $POSTER_ADDRESS"
fi

if [ -z "$DEPLOYER_KEY" ]; then
  cat <<'EOF'
!! DEPLOYER_KEY belum ada.
   Isi env DEPLOYER_KEY=0x… (kunci privat dompet pembayar gas deploy, butuh ±0,0005 ETH di Robinhood Chain),
   atau beri file JSON: bash tools/deploy-ledger.sh .secrets/ledger.json  berisi {"deployerKey":"0x…","poster":"0x…"}
EOF
  exit 1
fi
if ! [[ "$POSTER_ADDRESS" =~ ^0x[0-9a-fA-F]{40}$ ]]; then
  echo "!! POSTER_ADDRESS tidak sah atau kosong: '$POSTER_ADDRESS'"
  echo "   Poster = dompet server yang memanggil post() tiap jam (m/44'/60'/1'/0/0 dari GHOST_MNEMONIC). Tidak bisa diganti setelah deploy."
  exit 1
fi
DEPLOYER="$(cast wallet address --private-key "$DEPLOYER_KEY")"

# ---- build + uji ----
echo "== build + uji kontrak"
( cd contracts && forge build -q && forge test -q )
node -e "const o=require('./contracts/out/GhostLedger.sol/GhostLedger.json');require('fs').writeFileSync('contracts/abi/GhostLedger.json',JSON.stringify(o.abi,null,2)+'\n')"
echo "   lulus; ABI → contracts/abi/GhostLedger.json"

# ---- cek jaringan & saldo ----
ID="$(cast chain-id --rpc-url "$RPC")"
if [ "$ID" != "$CHAIN" ]; then echo "!! RPC $RPC memberi chain id $ID, bukan $CHAIN. Berhenti."; exit 1; fi
SALDO="$(cast balance "$DEPLOYER" --rpc-url "$RPC" --ether)"
echo "== jaringan  : Robinhood Chain ($CHAIN) via $RPC"
echo "   deployer  : $DEPLOYER  saldo $SALDO ETH"
echo "   poster    : $POSTER_ADDRESS  (permanen)"

# Catatan: --constructor-args bersifat variadik → selalu ditaruh PALING AKHIR.
CREATE=(forge create src/GhostLedger.sol:GhostLedger --rpc-url "$RPC" --chain "$CHAIN" --private-key "$DEPLOYER_KEY")

if [ -z "$KIRIM" ]; then
  echo "== SIMULASI (tanpa --kirim): dry-run forge create, tidak ada transaksi yang dikirim"
  ( cd contracts && "${CREATE[@]}" --constructor-args "$POSTER_ADDRESS" >/dev/null 2>&1 ) \
    && echo "   dry-run forge create: OK" || echo "!! dry-run forge create gagal — periksa RPC/kunci"
  KODE="$(node -e 'process.stdout.write(require("./contracts/out/GhostLedger.sol/GhostLedger.json").bytecode.object)')"
  ARGS="$(cast abi-encode 'constructor(address)' "$POSTER_ADDRESS")"
  GAS="$(cast estimate --from "$DEPLOYER" --rpc-url "$RPC" --create "${KODE}${ARGS#0x}" 2>/dev/null || echo '?')"
  HARGA="$(cast gas-price --rpc-url "$RPC" 2>/dev/null || echo 0)"
  echo "   taksiran gas deploy: $GAS  (harga gas sekarang $HARGA wei)"
  cat <<EOF

Siap? Jalankan lagi dengan --kirim untuk memasang sungguhan:
  bash tools/deploy-ledger.sh ${SECRETS:-} --kirim
EOF
  exit 0
fi

# ---- pasang sungguhan ----
echo "== memasang GhostLedger…"
OUT="$(cd contracts && "${CREATE[@]}" --broadcast --json --constructor-args "$POSTER_ADDRESS")"
ADDR="$(node -e 'const s=process.argv[1];const j=JSON.parse(s.slice(s.indexOf("{")));process.stdout.write(j.deployedTo)' "$OUT")"
TX="$(node -e 'const s=process.argv[1];const j=JSON.parse(s.slice(s.indexOf("{")));process.stdout.write(j.transactionHash||"")' "$OUT")"
[[ "$ADDR" =~ ^0x[0-9a-fA-F]{40}$ ]] || { echo "!! Gagal membaca alamat dari keluaran forge:"; echo "$OUT"; exit 1; }

# Pastikan poster di kontrak benar sebelum mengumumkan apa pun.
POSTER_ONCHAIN="$(cast call "$ADDR" 'poster()(address)' --rpc-url "$RPC")"
if [ "$(echo "$POSTER_ONCHAIN" | tr A-F a-f)" != "$(echo "$POSTER_ADDRESS" | tr A-F a-f)" ]; then
  echo "!! poster() di kontrak = $POSTER_ONCHAIN, bukan $POSTER_ADDRESS"; exit 1
fi

# Catatan deploy: mainnet → contracts/deployment.json, RPC lokal → contracts/deployment.local.json
CATATAN="contracts/deployment.json"
if [[ "$RPC" == *127.0.0.1* || "$RPC" == *localhost* ]]; then CATATAN="contracts/deployment.local.json"; fi
node -e '
const [addr, poster, tx, rpc, file] = process.argv.slice(1);
require("fs").writeFileSync(file, JSON.stringify({ contract: "GhostLedger", chainId: 4663, address: addr, poster, txHash: tx, rpc, deployedAt: new Date().toISOString() }, null, 2) + "\n");
' "$ADDR" "$POSTER_ADDRESS" "$TX" "$RPC" "$CATATAN"
echo "== terpasang: $ADDR  (tx $TX) → dicatat di $CATATAN"

# ---- verifikasi Sourcify (hanya di jaringan sungguhan) ----
if [[ "$RPC" == *127.0.0.1* || "$RPC" == *localhost* ]]; then
  echo "== RPC lokal → verifikasi Sourcify dilewati"
else
  echo "== verifikasi sumber di Sourcify…"
  ( cd contracts && forge verify-contract "$ADDR" src/GhostLedger.sol:GhostLedger \
      --chain "$CHAIN" --rpc-url "$RPC" --verifier sourcify \
      --constructor-args "$(cast abi-encode 'constructor(address)' "$POSTER_ADDRESS")" --watch ) \
    || echo "!! Verifikasi belum berhasil — kontrak TETAP terpasang. Ulangi perintah forge verify-contract di atas beberapa menit lagi."
fi

cat <<EOF

================ SELESAI ================
GhostLedger : $ADDR
poster      : $POSTER_ADDRESS
Blockscout  : $EXPLORER/address/$ADDR
Sourcify    : https://repo.sourcify.dev/contracts/full_match/$CHAIN/$ADDR/

Langkah berikutnya:
  1. Tulis di .env server:   LEDGER_ADDRESS=$ADDR
  2. Isi dompet poster ($POSTER_ADDRESS) dengan sedikit ETH untuk gas post() tiap jam (±75k gas per jam).
  3. Restart server, lalu cek: node tools/verify/check-wallet.mjs --base <PUBLIC_URL> --wallet <dompet pemegang>
EOF
