// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Script, console2} from "forge-std/Script.sol";
import {GhostLedger} from "../src/GhostLedger.sol";

/// Pasang GhostLedger. Alternatif untuk tools/deploy-ledger.sh (yang memakai forge create).
///   POSTER=0x… forge script script/Deploy.s.sol --rpc-url <url> --private-key <kunci> --broadcast
/// POSTER = dompet poster (m/44'/60'/1'/0/0 dari GHOST_MNEMONIC). Tidak bisa diganti setelah terpasang.
contract Deploy is Script {
    function run() external returns (GhostLedger ledger) {
        address poster = vm.envAddress("POSTER");
        vm.startBroadcast();
        ledger = new GhostLedger(poster);
        vm.stopBroadcast();
        console2.log("GhostLedger:", address(ledger));
        console2.log("poster:", poster);
    }
}
