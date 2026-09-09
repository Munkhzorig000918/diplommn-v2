// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @title AnchorRegistry — diplom.mn daily Merkle root anchor
/// @notice Append-only registry of daily Merkle roots for the diplom.mn
///         credential platform. Each batch's root commits to the salted
///         hashes of that day's issued credentials; anyone can verify a
///         credential offline by recomputing its salted hash and checking a
///         Merkle proof against the root stored here.
///
///         Deliberately minimal and immutable: no proxy, no upgrade path, no
///         owner, no pause switch. The only privileged action is anchoring a
///         new root, restricted to a single fixed anchorer address. Stores
///         nothing but batch id → (root, timestamp) — never credential data,
///         never PII.
/// @dev    Batch numbering and the daily cutoff policy live off-chain in the
///         anchor service, so no timezone or calendar rule is baked into
///         immutable code. A batch id is anchored at most once; the anchor
///         service treats AlreadyAnchored as idempotent success on retry.
contract AnchorRegistry {
    /// @notice Sole address permitted to anchor roots (anchor service wallet).
    address public immutable anchorer;

    mapping(uint256 batchId => bytes32) private _roots;
    mapping(uint256 batchId => uint64) private _anchoredAt;

    event RootAnchored(uint256 indexed batchId, bytes32 root, uint64 anchoredAt);

    error NotAnchorer();
    error ZeroAnchorer();
    error ZeroRoot();
    error AlreadyAnchored(uint256 batchId);

    constructor(address anchorer_) {
        if (anchorer_ == address(0)) revert ZeroAnchorer();
        anchorer = anchorer_;
    }

    /// @notice Anchor the Merkle root of one batch. Callable once per batch id.
    function anchorRoot(uint256 batchId, bytes32 root) external {
        if (msg.sender != anchorer) revert NotAnchorer();
        if (root == bytes32(0)) revert ZeroRoot();
        if (_roots[batchId] != bytes32(0)) revert AlreadyAnchored(batchId);

        uint64 timestamp = uint64(block.timestamp);
        _roots[batchId] = root;
        _anchoredAt[batchId] = timestamp;
        emit RootAnchored(batchId, root, timestamp);
    }

    /// @notice Merkle root of a batch, or zero if the batch is not anchored.
    function rootOf(uint256 batchId) external view returns (bytes32) {
        return _roots[batchId];
    }

    /// @notice Block timestamp at which a batch was anchored, or zero.
    function anchoredAt(uint256 batchId) external view returns (uint64) {
        return _anchoredAt[batchId];
    }
}
