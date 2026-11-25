// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {GhostLedger} from "../src/GhostLedger.sol";

/// Uji GhostLedger. Pohon Merkle di sini dibangun dengan aturan yang SAMA dengan server/merkle.mjs:
/// daun disortir menurut hash, pasangan disortir, simpul ganjil di ujung tingkat dinaikkan apa adanya.
contract GhostLedgerTest is Test {
    GhostLedger ledger;
    address poster = makeAddr("poster");
    address stranger = makeAddr("stranger");

    // 1_795_000_000 = 18 Nov 2026 UTC → jam ke-498_611. Jam contoh H (494_000) sudah lama lewat.
    uint256 constant NOW = 1_795_000_000;
    uint64 constant H = 494_000;

    event Posted(uint64 indexed hour, bytes32 root, uint128 poolMicro, uint32 entries, bytes32 uriHash);

    function setUp() public {
        vm.warp(NOW);
        ledger = new GhostLedger(poster);
    }

    // ───────── pembantu Merkle (cermin server/merkle.mjs) ─────────

    function _leaf(address w, uint64 hour, uint128 c) internal pure returns (bytes32) {
        return keccak256(abi.encode(w, hour, c));
    }

    function _hashPair(bytes32 a, bytes32 b) internal pure returns (bytes32) {
        return a < b ? keccak256(abi.encodePacked(a, b)) : keccak256(abi.encodePacked(b, a));
    }

    // Salinan tersortir menaik (insertion sort; n kecil di tes).
    function _sorted(bytes32[] memory xs) internal pure returns (bytes32[] memory out) {
        out = new bytes32[](xs.length);
        for (uint256 i = 0; i < xs.length; ++i) out[i] = xs[i];
        for (uint256 i = 1; i < out.length; ++i) {
            bytes32 k = out[i];
            uint256 j = i;
            while (j > 0 && out[j - 1] > k) {
                out[j] = out[j - 1];
                --j;
            }
            out[j] = k;
        }
    }

    function _nextLevel(bytes32[] memory level) internal pure returns (bytes32[] memory next) {
        next = new bytes32[]((level.length + 1) / 2);
        for (uint256 i = 0; i < level.length; i += 2) {
            next[i / 2] = i + 1 < level.length ? _hashPair(level[i], level[i + 1]) : level[i];
        }
    }

    function _root(bytes32[] memory leaves) internal pure returns (bytes32) {
        if (leaves.length == 0) return bytes32(0);
        bytes32[] memory level = _sorted(leaves);
        while (level.length > 1) level = _nextLevel(level);
        return level[0];
    }

    // Bukti untuk daun `leaf` (dicari posisinya di daftar tersortir).
    function _proof(bytes32[] memory leaves, bytes32 leaf) internal pure returns (bytes32[] memory proof) {
        bytes32[] memory level = _sorted(leaves);
        uint256 i = type(uint256).max;
        for (uint256 k = 0; k < level.length; ++k) {
            if (level[k] == leaf) {
                i = k;
                break;
            }
        }
        require(i != type(uint256).max, "leaf not in tree");
        bytes32[] memory buf = new bytes32[](64);
        uint256 n;
        while (level.length > 1) {
            uint256 sib = i ^ 1;
            if (sib < level.length) buf[n++] = level[sib]; // tanpa pasangan → tidak menambah bukti
            level = _nextLevel(level);
            i /= 2;
        }
        proof = new bytes32[](n);
        for (uint256 k = 0; k < n; ++k) proof[k] = buf[k];
    }

    // Buat n entri contoh: dompet + kredit berbeda-beda.
    function _entries(uint256 n, uint64 hour)
        internal
        returns (address[] memory ws, uint128[] memory cs, bytes32[] memory leaves)
    {
        ws = new address[](n);
        cs = new uint128[](n);
        leaves = new bytes32[](n);
        for (uint256 i = 0; i < n; ++i) {
            ws[i] = makeAddr(string(abi.encodePacked("holder-", vm.toString(i))));
            cs[i] = uint128(1_000_000 * (i + 1) + i * 7);
            leaves[i] = _leaf(ws[i], hour, cs[i]);
        }
    }

    function _post(uint64 hour, bytes32 root, uint32 entries) internal {
        vm.prank(poster);
        ledger.post(hour, root, 5_000_000, entries, keccak256("hour.json"));
    }

    // ───────── konstruktor ─────────

    function test_ConstructorSetsPoster() public view {
        assertEq(ledger.poster(), poster);
        assertEq(ledger.postedCount(), 0);
        assertEq(ledger.latestHour(), 0);
    }

    function test_ConstructorRejectsZeroPoster() public {
        vm.expectRevert(GhostLedger.ZeroPoster.selector);
        new GhostLedger(address(0));
    }

    // ───────── post ─────────

    function test_OnlyPosterCanPost() public {
        vm.prank(stranger);
        vm.expectRevert(GhostLedger.NotPoster.selector);
        ledger.post(H, bytes32(uint256(1)), 1, 1, bytes32(0));
    }

    function testFuzz_NonPosterAlwaysReverts(address who) public {
        vm.assume(who != poster);
        vm.prank(who);
        vm.expectRevert(GhostLedger.NotPoster.selector);
        ledger.post(H, bytes32(uint256(1)), 1, 1, bytes32(0));
    }

    function test_DoublePostReverts() public {
        _post(H, bytes32(uint256(1)), 1);
        vm.prank(poster);
        vm.expectRevert(abi.encodeWithSelector(GhostLedger.AlreadyPosted.selector, H));
        ledger.post(H, bytes32(uint256(2)), 9, 2, bytes32(0));
        // data lama tidak berubah
        (bytes32 root, uint128 pool,,) = ledger.hourOf(H);
        assertEq(root, bytes32(uint256(1)));
        assertEq(pool, 5_000_000);
    }

    function test_CurrentHourReverts() public {
        uint64 cur = uint64(block.timestamp / 3600);
        vm.prank(poster);
        vm.expectRevert(abi.encodeWithSelector(GhostLedger.HourNotPast.selector, cur, uint256(cur)));
        ledger.post(cur, bytes32(uint256(1)), 1, 1, bytes32(0));
    }

    function test_FutureHourReverts() public {
        uint64 cur = uint64(block.timestamp / 3600);
        vm.prank(poster);
        vm.expectRevert(abi.encodeWithSelector(GhostLedger.HourNotPast.selector, cur + 5, uint256(cur)));
        ledger.post(cur + 5, bytes32(uint256(1)), 1, 1, bytes32(0));
    }

    function test_PreviousHourAllowedRightAtBoundary() public {
        // Tepat di detik pertama jam baru, jam sebelumnya sudah boleh diposting.
        uint256 boundary = (NOW / 3600 + 1) * 3600;
        vm.warp(boundary);
        uint64 prev = uint64(boundary / 3600 - 1);
        _post(prev, bytes32(uint256(1)), 1);
        assertEq(ledger.latestHour(), prev);
    }

    function test_ZeroRootWithEntriesReverts() public {
        vm.prank(poster);
        vm.expectRevert(GhostLedger.EmptyRoot.selector);
        ledger.post(H, bytes32(0), 1, 3, bytes32(0));
    }

    function test_ZeroRootWithZeroEntriesAllowed() public {
        _post(H, bytes32(0), 0);
        (bytes32 root,, uint32 entries, uint64 postedAt) = ledger.hourOf(H);
        assertEq(root, bytes32(0));
        assertEq(entries, 0);
        assertEq(postedAt, uint64(NOW));
        assertEq(ledger.postedCount(), 1);
        // Jam kosong: verify tetap false untuk apa pun.
        assertFalse(ledger.verify(H, stranger, 0, new bytes32[](0)));
    }

    function test_PostStoresAndEmits() public {
        bytes32 root = keccak256("root");
        bytes32 uriHash = keccak256("data/ledger/hour-494000.json");
        vm.expectEmit(true, false, false, true, address(ledger));
        emit Posted(H, root, 12_345_678, 42, uriHash);
        vm.prank(poster);
        ledger.post(H, root, 12_345_678, 42, uriHash);

        (bytes32 r, uint128 pool, uint32 entries, uint64 postedAt) = ledger.hourOf(H);
        assertEq(r, root);
        assertEq(pool, 12_345_678);
        assertEq(entries, 42);
        assertEq(postedAt, uint64(NOW));
    }

    function test_LatestHourAndPostedCount() public {
        assertEq(ledger.latestHour(), 0);
        _post(H, bytes32(uint256(1)), 1);
        assertEq(ledger.latestHour(), H);
        assertEq(ledger.postedCount(), 1);
        _post(H + 3, bytes32(uint256(2)), 1);
        assertEq(ledger.latestHour(), H + 3);
        assertEq(ledger.postedCount(), 2);
        // Posting menyusul jam lebih lama: hitungan naik, latestHour tetap yang tertinggi.
        _post(H + 1, bytes32(uint256(3)), 1);
        assertEq(ledger.latestHour(), H + 3);
        assertEq(ledger.postedCount(), 3);
    }

    // ───────── verify ─────────

    function _checkAllLeaves(uint256 n) internal {
        (address[] memory ws, uint128[] memory cs, bytes32[] memory leaves) = _entries(n, H);
        bytes32 root = _root(leaves);
        _post(H, root, uint32(n));
        for (uint256 i = 0; i < n; ++i) {
            bytes32[] memory p = _proof(leaves, leaves[i]);
            assertTrue(ledger.verify(H, ws[i], cs[i], p), "leaf should verify");
        }
    }

    function test_VerifyOneLeaf() public {
        (address[] memory ws, uint128[] memory cs, bytes32[] memory leaves) = _entries(1, H);
        bytes32 root = _root(leaves);
        assertEq(root, leaves[0]); // pohon 1 daun: akar = daun
        _post(H, root, 1);
        assertTrue(ledger.verify(H, ws[0], cs[0], new bytes32[](0)));
    }

    function test_VerifyTwoLeaves() public {
        _checkAllLeaves(2);
    }

    function test_VerifyFiveLeaves() public {
        _checkAllLeaves(5);
    }

    function test_VerifyManySizes() public {
        // Ukuran ganjil/genap campur, tiap ukuran di jam berbeda.
        uint256[6] memory sizes = [uint256(3), 4, 6, 7, 9, 17];
        for (uint256 s = 0; s < sizes.length; ++s) {
            uint64 hour = H + uint64(s) + 10;
            (address[] memory ws, uint128[] memory cs, bytes32[] memory leaves) = _entries(sizes[s], hour);
            _post(hour, _root(leaves), uint32(sizes[s]));
            for (uint256 i = 0; i < sizes[s]; ++i) {
                assertTrue(ledger.verify(hour, ws[i], cs[i], _proof(leaves, leaves[i])));
            }
        }
    }

    function test_VerifyFalseCases() public {
        (address[] memory ws, uint128[] memory cs, bytes32[] memory leaves) = _entries(5, H);
        _post(H, _root(leaves), 5);
        bytes32[] memory p = _proof(leaves, leaves[2]);

        assertTrue(ledger.verify(H, ws[2], cs[2], p));
        // kredit salah
        assertFalse(ledger.verify(H, ws[2], cs[2] + 1, p));
        // dompet salah
        assertFalse(ledger.verify(H, stranger, cs[2], p));
        // jam salah (jam lain yang juga sudah diposting dengan akar lain)
        _post(H + 1, keccak256("other"), 5);
        assertFalse(ledger.verify(H + 1, ws[2], cs[2], p));
        // jam belum diposting
        assertFalse(ledger.verify(H + 2, ws[2], cs[2], p));
        // bukti dirusak
        bytes32[] memory bad = _proof(leaves, leaves[2]);
        bad[0] = bytes32(uint256(bad[0]) ^ 1);
        assertFalse(ledger.verify(H, ws[2], cs[2], bad));
        // bukti milik daun lain
        assertFalse(ledger.verify(H, ws[2], cs[2], _proof(leaves, leaves[3])));
        // bukti kosong
        assertFalse(ledger.verify(H, ws[2], cs[2], new bytes32[](0)));
    }

    function testFuzz_VerifyWrongCredit(uint128 delta) public {
        vm.assume(delta != 0);
        (address[] memory ws, uint128[] memory cs, bytes32[] memory leaves) = _entries(5, H);
        _post(H, _root(leaves), 5);
        unchecked {
            assertFalse(ledger.verify(H, ws[0], cs[0] + delta, _proof(leaves, leaves[0])));
        }
    }

    // ───────── vektor dari server/merkle.mjs (bukti JS == Solidity) ─────────

    function test_VectorsFromJs() public {
        string memory json = vm.readFile(string.concat(vm.projectRoot(), "/test/vectors.json"));
        uint64 hour = uint64(vm.parseJsonUint(json, ".hour"));
        bytes32 jsRoot = vm.parseJsonBytes32(json, ".root");
        uint256 n = 5;

        bytes32[] memory leaves = new bytes32[](n);
        address[] memory ws = new address[](n);
        uint128[] memory cs = new uint128[](n);
        for (uint256 i = 0; i < n; ++i) {
            string memory k = string.concat(".leaves[", vm.toString(i), "]");
            ws[i] = vm.parseJsonAddress(json, string.concat(k, ".wallet"));
            cs[i] = uint128(vm.parseJsonUint(json, string.concat(k, ".creditMicro")));
            leaves[i] = _leaf(ws[i], hour, cs[i]);
            // daun JS == daun Solidity
            assertEq(leaves[i], vm.parseJsonBytes32(json, string.concat(k, ".leaf")), "leaf mismatch");
        }
        // akar JS == akar Solidity
        assertEq(_root(leaves), jsRoot, "root mismatch");

        _post(hour, jsRoot, uint32(n));
        for (uint256 i = 0; i < n; ++i) {
            bytes32[] memory jsProof = vm.parseJsonBytes32Array(json, string.concat(".proofs[", vm.toString(i), "]"));
            // bukti JS == bukti Solidity, dan diterima kontrak
            assertEq(keccak256(abi.encode(jsProof)), keccak256(abi.encode(_proof(leaves, leaves[i]))), "proof mismatch");
            assertTrue(ledger.verify(hour, ws[i], cs[i], jsProof), "js proof rejected");
        }
    }
}
