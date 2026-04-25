// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IAsyncDelivery {
    function deliver(
        uint256 jobId,
        address target,
        bytes calldata callbackData
    ) external;
}

interface IAsyncDeliveryReceiver {
    function receiveDelivery(
        uint256 jobId,
        bytes calldata result
    ) external;
}
