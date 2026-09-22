// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

/// @dev TEST FIXTURE ONLY — this contract must never be deployed.
///
/// Forcibly sends ether to a target without giving it a chance to react. It
/// stands in for the two ways ether enters a contract without going through
/// `vote`:
///
///   1. `selfdestruct(target)` — the historical forced-transfer primitive.
///   2. A plain `transfer`, which a contract with no `receive` cannot refuse.
///
/// Its only job is to make `Poll.address(this).balance > Poll.totalStaked()`
/// reachable in a test. Without that gap, the difference between "sweep the
/// balance" and "sweep what the contract is accounted to hold" cannot be
/// observed at all — which is exactly why the original `sweepUnclaimed` shipped
/// with the weaker behaviour.
contract ForcedEtherSender {
    /// @dev Sends `amount` to `target` via `selfdestruct`, which cannot be
    ///      rejected by the recipient.
    function forceSend(address payable target) external payable {
        selfdestruct(target);
    }
}
