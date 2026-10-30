// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title GermlineAnchor -- an append-only registry of audit-log heads
///
/// An audit log is a hash chain: each entry carries the hash of the one before
/// it, so editing, removing or reordering an entry is detectable by anyone who
/// holds the file. What a hash chain cannot show on its own is that the whole
/// file was not rewritten, consistently, by whoever holds it. This contract
/// closes that gap.
///
/// Each anchor records (entries, head): "after `entries` entries, the log's
/// head hash was `head`". Anchors are keyed by the log's id AND the sender, so
/// nobody can write into someone else's history, and they are append-only per
/// key: a later anchor must cover strictly more entries than the one before.
/// Every anchor is kept, not just the latest, so a verifier can read the full
/// history with plain view calls -- no event scanning, no indexer, no trust in
/// the vendor -- and check that every head ever anchored is still the head of
/// the log at that position. A rewritten history cannot pass that check
/// without forging keccak256.
///
/// There is no owner, no upgrade path and no way to delete or amend an anchor.
/// That is the whole point: a customer's evidence must not depend on anyone,
/// including us, behaving well after the fact.
contract GermlineAnchor {
    struct Anchor {
        // How many log entries this head covers. Not called `entries`: that
        // name collides with a method on the result objects ethers returns.
        uint64 covered;
        uint64 timestamp; // block time when anchored
        uint64 blockNumber;
        bytes32 head; // hash of entry `entries - 1`
        bytes32 storageRoot; // 0G Storage root of the log at this point, or zero
    }

    mapping(bytes32 => mapping(address => Anchor[])) private _history;

    event Anchored(
        bytes32 indexed logId,
        address indexed anchorer,
        uint256 indexed index,
        uint64 entries,
        bytes32 head,
        bytes32 storageRoot
    );

    error EmptyAnchor();
    error NotAppendOnly(uint64 previous, uint64 attempted);

    /// Record that `logId`'s log, as kept by the caller, had head `head` after
    /// `entries` entries. Reverts unless `entries` exceeds the caller's last
    /// anchor for this log.
    function anchor(
        bytes32 logId,
        uint64 entries,
        bytes32 head,
        bytes32 storageRoot
    ) external returns (uint256 index) {
        if (logId == bytes32(0) || head == bytes32(0) || entries == 0) revert EmptyAnchor();
        Anchor[] storage history = _history[logId][msg.sender];
        index = history.length;
        if (index > 0) {
            uint64 previous = history[index - 1].covered;
            if (entries <= previous) revert NotAppendOnly(previous, entries);
        }
        history.push(
            Anchor({
                covered: entries,
                timestamp: uint64(block.timestamp),
                blockNumber: uint64(block.number),
                head: head,
                storageRoot: storageRoot
            })
        );
        emit Anchored(logId, msg.sender, index, entries, head, storageRoot);
    }

    function anchorCount(bytes32 logId, address anchorer) external view returns (uint256) {
        return _history[logId][anchorer].length;
    }

    function anchorAt(
        bytes32 logId,
        address anchorer,
        uint256 index
    ) external view returns (Anchor memory) {
        return _history[logId][anchorer][index];
    }

    /// A page of the history, so a long-lived log never needs one huge call.
    function anchorsOf(
        bytes32 logId,
        address anchorer,
        uint256 from,
        uint256 count
    ) external view returns (Anchor[] memory page) {
        Anchor[] storage history = _history[logId][anchorer];
        if (from >= history.length) return new Anchor[](0);
        uint256 end = from + count;
        if (end > history.length) end = history.length;
        page = new Anchor[](end - from);
        for (uint256 i = from; i < end; i++) page[i - from] = history[i];
    }

    function latest(bytes32 logId, address anchorer) external view returns (Anchor memory a) {
        Anchor[] storage history = _history[logId][anchorer];
        if (history.length > 0) a = history[history.length - 1];
    }
}
