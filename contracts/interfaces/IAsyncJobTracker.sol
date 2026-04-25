// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IAsyncJobTracker {
    enum JobStatus { PENDING, COMPLETED, FAILED, CANCELLED }

    struct Job {
        uint256 id;
        address requester;
        bytes payload;
        JobStatus status;
        uint256 createdAt;
        uint256 completedAt;
    }

    event JobSubmitted(uint256 indexed jobId, address indexed requester, bytes payload);
    event JobCompleted(uint256 indexed jobId, bytes result);
    event JobFailed(uint256 indexed jobId, string reason);

    function submitJob(bytes calldata payload) external payable returns (uint256 jobId);
    function getJob(uint256 jobId) external view returns (Job memory);
    function cancelJob(uint256 jobId) external;
    function estimateFee(bytes calldata payload) external view returns (uint256);
}
