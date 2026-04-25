// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface ITEEServiceRegistry {
    struct Service {
        address operator;
        bytes32 serviceId;
        string endpoint;
        bool active;
        uint256 registeredAt;
    }

    function getService(bytes32 serviceId) external view returns (Service memory);
    function isServiceActive(bytes32 serviceId) external view returns (bool);
    function listActiveServices() external view returns (bytes32[] memory);
}
