// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

/// @dev TEST FIXTURE ONLY — this contract must never be deployed.
///
/// A voter that refuses to receive ether. It exists to exercise the
/// `TransferFailed` branches of `Voting.refund` and `Voting.sweepUnclaimed`:
/// without a counterparty that rejects the transfer, those guards can never be
/// executed and would silently rot.
///
/// Tests drive it with `vm.prank(address(this contract))`, so no forwarding
/// helper is needed — and the revert observed at the top level stays
/// `Voting.TransferFailed` rather than being wrapped by a helper.
contract EthRejectingVoter {
    receive() external payable {
        revert("ether refused");
    }
}
