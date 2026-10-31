// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// The read side of GermlineAnchor, which is all a guard needs.
interface IGermlineAnchor {
    struct Anchor {
        uint64 covered;
        uint64 timestamp;
        uint64 blockNumber;
        bytes32 head;
        bytes32 storageRoot;
    }

    function latest(bytes32 logId, address anchorer) external view returns (Anchor memory);
}

/// @title GermlineGuard -- a timelock on an AI agent's configuration
///
/// An AI agent that moves money is only as trustworthy as its prompt, model
/// and tool policy, and those can change overnight without anyone noticing.
/// Germline already records every such change in a hash-chained log whose head
/// is anchored in GermlineAnchor. This contract lets other contracts act on
/// that record.
///
/// A guard watches one log, as anchored by one key (the agent's operator). The
/// rule it enforces: the agent may act only under the configuration that is
/// currently anchored, and only once that anchor is at least `delay` seconds
/// old. So every config change the operator publishes opens a window, `delay`
/// long, in which the agent cannot act through a guarded contract, and in
/// which the people exposed to it can read the change (with `germline
/// verify` or the browser verifier) and leave if they don't like it. It is the
/// governance timelock pattern, applied to what an agent is told to do.
///
/// What it does not do: it cannot see a change the operator never anchors.
/// It binds the operator's public claim about which config is live. A
/// verifier holding the published log catches a head that was never
/// anchored; binding the claim to what actually runs needs attested
/// execution (for example 0G Compute's TEE-verified inference), which is on
/// the roadmap rather than in this contract. See docs/AGENTS.md.
///
/// Like GermlineAnchor it has no owner and no upgrade path. Its parameters
/// are fixed at deployment, so a depositor can read exactly what they agreed
/// to.
contract GermlineGuard {
    IGermlineAnchor public immutable registry;
    bytes32 public immutable logId;
    address public immutable anchorer;
    uint64 public immutable delay;

    error ZeroParameter();
    error DelayTooLong();
    error NoAnchor();
    error WrongHead(bytes32 claimed, bytes32 anchored);
    error NotSettled(bytes32 head, uint64 settlesAt);

    constructor(IGermlineAnchor registry_, bytes32 logId_, address anchorer_, uint64 delay_) {
        if (address(registry_) == address(0) || logId_ == bytes32(0) || anchorer_ == address(0)) revert ZeroParameter();
        // A delay this long would overflow `timestamp + delay` and brick the guard.
        if (delay_ > 3650 days) revert DelayTooLong();
        registry = registry_;
        logId = logId_;
        anchorer = anchorer_;
        delay = delay_;
    }

    /// The anchored head and when it takes effect. `settlesAt` is zero when
    /// the log has never been anchored.
    function current() public view returns (bytes32 head, uint64 covered, uint64 anchoredAt, uint64 settlesAt) {
        IGermlineAnchor.Anchor memory a = registry.latest(logId, anchorer);
        if (a.covered == 0) return (bytes32(0), 0, 0, 0);
        return (a.head, a.covered, a.timestamp, a.timestamp + delay);
    }

    /// True when the anchored configuration has been public for `delay`.
    function settled() external view returns (bool) {
        (, , , uint64 settlesAt) = current();
        return settlesAt != 0 && block.timestamp >= settlesAt;
    }

    /// Reverts unless `claimedHead` is the anchored head and has settled.
    /// A guarded contract calls this with the head the agent says it is
    /// running under, before letting the agent act.
    function check(bytes32 claimedHead) public view {
        (bytes32 head, , , uint64 settlesAt) = current();
        if (settlesAt == 0) revert NoAnchor();
        if (claimedHead != head) revert WrongHead(claimedHead, head);
        if (block.timestamp < settlesAt) revert NotSettled(head, settlesAt);
    }
}

/// Inherit this to gate functions on a settled agent configuration.
abstract contract GermlineGuarded {
    GermlineGuard public immutable guard;

    constructor(GermlineGuard guard_) {
        guard = guard_;
    }

    modifier onlySettledConfig(bytes32 claimedHead) {
        guard.check(claimedHead);
        _;
    }
}
