// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// Benchmark baseline only: AgentVault without the guard, so
/// scripts/bench-guard.js can measure what the guard adds to each payment.
contract PlainVault {
    address public immutable agent;

    event Paid(address indexed to, uint256 amount, bytes32 configHead);

    error NotAgent();
    error TransferFailed();

    constructor(address agent_) {
        agent = agent_;
    }

    receive() external payable {}

    function pay(address payable to, uint256 amount, bytes32 configHead) external {
        if (msg.sender != agent) revert NotAgent();
        emit Paid(to, amount, configHead);
        (bool ok, ) = to.call{value: amount}("");
        if (!ok) revert TransferFailed();
    }
}
