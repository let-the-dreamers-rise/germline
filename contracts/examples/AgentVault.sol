// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "../GermlineGuard.sol";

/// @title AgentVault -- an example of an AI agent spending under a guard
///
/// The owner funds the vault. The agent can pay out of it, but only while its
/// anchored configuration has settled (see GermlineGuard). The owner can
/// withdraw at any time, so when the operator publishes a config change the
/// owner doesn't like, they have `guard.delay()` seconds to leave before the
/// agent can act under it. Deliberately minimal: an example, not audited
/// production code.
contract AgentVault is GermlineGuarded {
    address public immutable owner;
    address public immutable agent;

    event Paid(address indexed to, uint256 amount, bytes32 configHead);
    event Withdrawn(uint256 amount);

    error NotOwner();
    error NotAgent();
    error TransferFailed();

    constructor(GermlineGuard guard_, address agent_) GermlineGuarded(guard_) {
        owner = msg.sender;
        agent = agent_;
    }

    receive() external payable {}

    /// The agent pays `amount` to `to`, stating the config head it runs under.
    function pay(address payable to, uint256 amount, bytes32 configHead) external onlySettledConfig(configHead) {
        if (msg.sender != agent) revert NotAgent();
        emit Paid(to, amount, configHead);
        (bool ok, ) = to.call{value: amount}("");
        if (!ok) revert TransferFailed();
    }

    /// The owner's exit, never gated.
    function withdraw() external {
        if (msg.sender != owner) revert NotOwner();
        uint256 amount = address(this).balance;
        emit Withdrawn(amount);
        (bool ok, ) = payable(owner).call{value: amount}("");
        if (!ok) revert TransferFailed();
    }
}
