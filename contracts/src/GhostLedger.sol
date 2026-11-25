// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @title GhostLedger
/// @notice Public, append-only record of GHOSTKEY Holder Credit. Once per hour the poster publishes
///         the Merkle root of every (wallet, hour, creditMicro) allocation for that hour, together
///         with the pool size and the number of entries. Anyone can then check a single wallet's
///         credit with `verify` — no trust in the GHOSTKEY server is needed.
/// @dev    No owner, no proxy, no upgrade path, no function that edits or deletes a posted hour.
///         The only write is `post`, and only the immutable `poster` can call it, once per hour.
///
///         Leaf rule:  leaf = keccak256(abi.encode(address wallet, uint64 hour, uint128 creditMicro)).
///         Tree rule:  node = keccak256(min(a, b) ++ max(a, b)) — OpenZeppelin MerkleProof "sorted
///                     pair" rule. Off-chain (server/merkle.mjs) leaves are sorted by hash before the
///                     tree is built and an odd node at the end of a level is carried up unchanged;
///                     that only affects how proofs are made, not how they are checked here.
contract GhostLedger {
    // Satu jam = satu akar Merkle. Dikemas jadi 2 slot: root (32 B) + poolMicro/entries/postedAt (28 B).
    struct Hour {
        bytes32 root; // akar Merkle alokasi jam ini (0x0 hanya kalau entries == 0)
        uint128 poolMicro; // besar pool jam ini, mikro-USD (1 USD = 1_000_000)
        uint32 entries; // jumlah daun (dompet yang dapat kredit)
        uint64 postedAt; // waktu blok saat diposting; 0 = belum pernah diposting
    }

    /// @notice The only address allowed to post. Fixed at deployment; it can never be changed.
    address public immutable poster;

    /// @notice Posted data per hour number (hour = floor(unix / 3600)). `postedAt == 0` means not posted.
    /// @dev    Named `hourOf` because `hours` is a reserved time-unit keyword in Solidity.
    mapping(uint64 hour => Hour) public hourOf;

    /// @notice Number of hours posted so far.
    // uint64 + _latestHour di bawahnya berbagi satu slot → tiap post hanya menulis 1 slot tambahan.
    uint64 public postedCount;

    // Jam tertinggi yang pernah diposting (0 kalau belum ada). Dibaca lewat latestHour().
    uint64 private _latestHour;

    /// @notice Emitted once per posted hour. `uriHash` = keccak256 of the public JSON file for that hour.
    event Posted(uint64 indexed hour, bytes32 root, uint128 poolMicro, uint32 entries, bytes32 uriHash);

    error ZeroPoster();
    error NotPoster();
    error AlreadyPosted(uint64 hour);
    error HourNotPast(uint64 hour, uint256 currentHour);
    error EmptyRoot();

    /// @param poster_ Address that will be allowed to post hours. Must not be zero.
    constructor(address poster_) {
        if (poster_ == address(0)) revert ZeroPoster();
        poster = poster_;
    }

    /// @notice Publish the Holder Credit allocation of one finished hour.
    /// @param hour      Hour number, floor(unix / 3600). Must be strictly before the current hour.
    /// @param root      Merkle root of all leaves. May be zero only when `entries == 0`.
    /// @param poolMicro Pool for this hour in micro-USD.
    /// @param entries   Number of leaves under `root`.
    /// @param uriHash   keccak256 of the published hour file (data/ledger/hour-<n>.json); event only.
    function post(uint64 hour, bytes32 root, uint128 poolMicro, uint32 entries, bytes32 uriHash) external {
        if (msg.sender != poster) revert NotPoster();
        // Jam berjalan belum selesai → belum boleh diposting (snapshot :60 belum ada).
        uint256 currentHour = block.timestamp / 3600;
        if (hour >= currentHour) revert HourNotPast(hour, currentHour);
        if (hourOf[hour].postedAt != 0) revert AlreadyPosted(hour);
        if (root == bytes32(0) && entries != 0) revert EmptyRoot();

        hourOf[hour] = Hour({root: root, poolMicro: poolMicro, entries: entries, postedAt: uint64(block.timestamp)});
        unchecked {
            ++postedCount; // tidak mungkin meluap: maksimal satu per jam
        }
        // Jam bisa diposting tidak berurutan (mis. menyusul); latestHour selalu yang tertinggi.
        if (hour > _latestHour) _latestHour = hour;

        emit Posted(hour, root, poolMicro, entries, uriHash);
    }

    /// @notice Check that `wallet` was credited exactly `creditMicro` in `hour`.
    /// @dev    Returns false (never reverts) when the hour was not posted, so one eth_call always
    ///         gives a yes/no answer.
    /// @param hour        Hour number.
    /// @param wallet      Holder wallet.
    /// @param creditMicro Credit in micro-USD for that wallet and hour.
    /// @param proof       Sibling hashes from the leaf up to the root (sorted-pair rule).
    function verify(uint64 hour, address wallet, uint128 creditMicro, bytes32[] calldata proof)
        external
        view
        returns (bool)
    {
        Hour storage h = hourOf[hour];
        if (h.postedAt == 0) return false;
        bytes32 computed = keccak256(abi.encode(wallet, hour, creditMicro));
        uint256 n = proof.length;
        for (uint256 i = 0; i < n; ++i) {
            computed = _hashPair(computed, proof[i]);
        }
        return computed == h.root;
    }

    /// @notice Highest hour number posted so far, or 0 if nothing has been posted.
    function latestHour() external view returns (uint64) {
        return _latestHour;
    }

    // Pasangan diurutkan dulu (yang lebih kecil di depan) — sama dengan MerkleProof OpenZeppelin,
    // jadi pemeriksa tidak perlu tahu posisi kiri/kanan tiap saudara.
    function _hashPair(bytes32 a, bytes32 b) private pure returns (bytes32 h) {
        (bytes32 lo, bytes32 hi) = a < b ? (a, b) : (b, a);
        assembly ("memory-safe") {
            mstore(0x00, lo)
            mstore(0x20, hi)
            h := keccak256(0x00, 0x40)
        }
    }
}
