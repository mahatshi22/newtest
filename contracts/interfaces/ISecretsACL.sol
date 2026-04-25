// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface ISecretsACL {
    event SecretRegistered(bytes32 indexed secretId, address indexed owner);
    event AccessGranted(bytes32 indexed secretId, address indexed grantee);
    event AccessRevoked(bytes32 indexed secretId, address indexed grantee);

    function registerSecret(bytes32 secretId, bytes calldata encryptedSecret) external;
    function grantAccess(bytes32 secretId, address grantee) external;
    function revokeAccess(bytes32 secretId, address grantee) external;
    function hasAccess(bytes32 secretId, address account) external view returns (bool);
    function getEncryptedSecret(bytes32 secretId) external view returns (bytes memory);
}
