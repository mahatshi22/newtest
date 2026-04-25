// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "../interfaces/IAsyncJobTracker.sol";

contract MockAsyncJobTracker is IAsyncJobTracker {
    uint256 private _nextJobId = 1;
    uint256 public fixedFee = 0;

    mapping(uint256 => Job) private _jobs;

    function setFee(uint256 fee) external { fixedFee = fee; }

    function submitJob(bytes calldata payload) external payable override returns (uint256 jobId) {
        jobId = _nextJobId++;
        _jobs[jobId] = Job({
            id: jobId,
            requester: msg.sender,
            payload: payload,
            status: JobStatus.PENDING,
            createdAt: block.timestamp,
            completedAt: 0
        });
        emit JobSubmitted(jobId, msg.sender, payload);
    }

    function getJob(uint256 jobId) external view override returns (Job memory) {
        return _jobs[jobId];
    }

    function cancelJob(uint256 jobId) external override {
        _jobs[jobId].status = JobStatus.CANCELLED;
    }

    function estimateFee(bytes calldata) external view override returns (uint256) {
        return fixedFee;
    }
}
