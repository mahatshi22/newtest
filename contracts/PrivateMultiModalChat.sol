// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "./interfaces/IAsyncJobTracker.sol";
import "./interfaces/IAsyncDelivery.sol";
import "./interfaces/ISecretsACL.sol";

/**
 * @title PrivateMultiModalChat
 * @notice Private multi-modal on-chain ChatGPT built on Ritual Chain.
 *
 * Privacy Model
 * =============
 * - The user generates an ephemeral ECDH key pair in the browser.
 * - The public key is stored on-chain in the Session struct.
 * - All user messages are encrypted with AES-256-GCM before being written.
 * - The AES key is derived (HKDF) from a wallet-signed deterministic secret.
 * - When submitting a job to AsyncJobTracker, the payload includes:
 *     * The encrypted message ciphertext
 *     * The session ECDH public key (so the TEE can derive the shared secret)
 *     * The session ID
 * - The TEE node decrypts the message, calls the AI model, encrypts the
 *   response with the same shared secret, and delivers it via AsyncDelivery.
 *
 * Multi-Modal Support
 * ===================
 * - TEXT: ciphertext stored directly on-chain
 * - IMAGE / AUDIO: encrypted content uploaded to IPFS; CID stored on-chain
 *
 * Ritual Integration
 * ==================
 * - IAsyncJobTracker  : submit inference jobs
 * - IAsyncDelivery    : receive encrypted AI responses (callback)
 * - ISecretsACL       : optional secret management for API keys
 */
contract PrivateMultiModalChat is IAsyncDeliveryReceiver {

    // ── System contract addresses (Ritual Chain) ─────────────────────────────
    address public constant ASYNC_JOB_TRACKER  = 0xC069FFCa0389f44eCA2C626e55491b0ab045AEF5;
    address public constant ASYNC_DELIVERY     = 0x5A16214fF555848411544b005f7Ac063742f39F6;
    address public constant SECRETS_ACL        = 0xf9BF1BC8A3e79B9EBeD0fa2Db70D0513fecE32FD;

    // ── Types ────────────────────────────────────────────────────────────────

    enum Role         { USER, ASSISTANT }
    enum ModalityType { TEXT, IMAGE, AUDIO }
    enum SessionStatus{ ACTIVE, ARCHIVED, DELETED }

    struct Message {
        uint256 id;
        Role    role;
        ModalityType modality;
        bytes   ciphertext;   // AES-256-GCM encrypted content
        bytes   nonce;        // 12-byte GCM nonce
        string  ipfsCid;      // non-empty for IMAGE/AUDIO
        uint256 timestamp;
        bool    pending;      // true while waiting for AI response
        uint256 jobId;        // AsyncJobTracker job ID (0 if not applicable)
    }

    struct Session {
        uint256 id;
        address owner;
        string  title;
        bytes   ecdhPublicKey; // 65-byte uncompressed P-256 public key
        SessionStatus status;
        uint256 createdAt;
        uint256 updatedAt;
        uint256 messageCount;
    }

    // ── Storage ──────────────────────────────────────────────────────────────

    address public owner;

    /// @dev AI service identifier registered in TEEServiceRegistry
    bytes32 public aiServiceId;

    uint256 private _nextSessionId;
    uint256 private _nextMessageId;

    mapping(uint256 => Session)  private _sessions;
    mapping(uint256 => mapping(uint256 => Message)) private _messages;
    mapping(uint256 => uint256[]) private _messageIds;
    mapping(address => uint256[]) private _userSessions;

    /// @dev jobId => (sessionId, userMessageId) for callback routing
    mapping(uint256 => uint256) private _jobToSession;
    mapping(uint256 => uint256) private _jobToUserMessage;

    // ── Events ───────────────────────────────────────────────────────────────

    event SessionCreated(uint256 indexed sessionId, address indexed owner, string title, uint256 timestamp);
    event SessionUpdated(uint256 indexed sessionId, SessionStatus status);
    event MessageSent(uint256 indexed sessionId, uint256 indexed messageId, Role role, ModalityType modality, uint256 timestamp);
    event JobSubmitted(uint256 indexed sessionId, uint256 indexed messageId, uint256 jobId);
    event ResponseDelivered(uint256 indexed sessionId, uint256 indexed messageId, uint256 jobId);
    event ServiceIdUpdated(bytes32 oldId, bytes32 newId);

    // ── Modifiers ────────────────────────────────────────────────────────────

    modifier onlyOwner() {
        require(msg.sender == owner, "PMC: not owner");
        _;
    }

    modifier sessionExists(uint256 sid) {
        require(_sessions[sid].owner != address(0), "PMC: session not found");
        _;
    }

    modifier onlySessionOwner(uint256 sid) {
        require(_sessions[sid].owner == msg.sender, "PMC: not session owner");
        _;
    }

    modifier sessionActive(uint256 sid) {
        require(_sessions[sid].status == SessionStatus.ACTIVE, "PMC: session not active");
        _;
    }

    // ── Constructor ──────────────────────────────────────────────────────────

    constructor(bytes32 _aiServiceId) {
        owner = msg.sender;
        aiServiceId = _aiServiceId;
        _nextSessionId = 1;
        _nextMessageId = 1;
    }

    // ── Admin ────────────────────────────────────────────────────────────────

    function setAiServiceId(bytes32 _id) external onlyOwner {
        emit ServiceIdUpdated(aiServiceId, _id);
        aiServiceId = _id;
    }

    function transferOwnership(address newOwner) external onlyOwner {
        require(newOwner != address(0), "PMC: zero address");
        owner = newOwner;
    }

    receive() external payable {}

    function withdraw() external onlyOwner {
        (bool ok,) = owner.call{value: address(this).balance}("");
        require(ok, "PMC: withdraw failed");
    }

    // ── Session management ───────────────────────────────────────────────────

    function createSession(string calldata title, bytes calldata ecdhPubKey)
        external returns (uint256 sessionId)
    {
        require(ecdhPubKey.length == 65, "PMC: invalid pubkey length");
        sessionId = _nextSessionId++;
        _sessions[sessionId] = Session({
            id:           sessionId,
            owner:        msg.sender,
            title:        title,
            ecdhPublicKey: ecdhPubKey,
            status:       SessionStatus.ACTIVE,
            createdAt:    block.timestamp,
            updatedAt:    block.timestamp,
            messageCount: 0
        });
        _userSessions[msg.sender].push(sessionId);
        emit SessionCreated(sessionId, msg.sender, title, block.timestamp);
    }

    function archiveSession(uint256 sid)
        external sessionExists(sid) onlySessionOwner(sid)
    {
        _sessions[sid].status = SessionStatus.ARCHIVED;
        _sessions[sid].updatedAt = block.timestamp;
        emit SessionUpdated(sid, SessionStatus.ARCHIVED);
    }

    function deleteSession(uint256 sid)
        external sessionExists(sid) onlySessionOwner(sid)
    {
        _sessions[sid].status = SessionStatus.DELETED;
        _sessions[sid].updatedAt = block.timestamp;
        emit SessionUpdated(sid, SessionStatus.DELETED);
    }

    // ── Messaging ────────────────────────────────────────────────────────────

    function sendMessage(
        uint256 sid,
        ModalityType modality,
        bytes calldata ciphertext,
        bytes calldata nonce,
        string calldata ipfsCid,
        bool dispatchAI
    )
        external payable
        sessionExists(sid) onlySessionOwner(sid) sessionActive(sid)
        returns (uint256 messageId)
    {
        require(ciphertext.length > 0, "PMC: empty ciphertext");
        require(nonce.length == 12,    "PMC: invalid nonce");
        if (modality != ModalityType.TEXT) {
            require(bytes(ipfsCid).length > 0, "PMC: CID required for media");
        }

        messageId = _nextMessageId++;
        _messages[sid][messageId] = Message({
            id:         messageId,
            role:       Role.USER,
            modality:   modality,
            ciphertext: ciphertext,
            nonce:      nonce,
            ipfsCid:    ipfsCid,
            timestamp:  block.timestamp,
            pending:    dispatchAI,
            jobId:      0
        });
        _messageIds[sid].push(messageId);
        _sessions[sid].messageCount++;
        _sessions[sid].updatedAt = block.timestamp;

        emit MessageSent(sid, messageId, Role.USER, modality, block.timestamp);

        if (dispatchAI) {
            _dispatchJob(sid, messageId, ciphertext, nonce);
        }
    }

    function _dispatchJob(
        uint256 sid,
        uint256 mid,
        bytes calldata ciphertext,
        bytes calldata nonce
    ) internal {
        Session storage s = _sessions[sid];
        bytes memory payload = abi.encode(
            aiServiceId,
            sid,
            mid,
            s.ecdhPublicKey,
            uint8(s.status),
            ciphertext,
            nonce
        );

        IAsyncJobTracker tracker = IAsyncJobTracker(ASYNC_JOB_TRACKER);
        uint256 fee = 0;
        try tracker.estimateFee(payload) returns (uint256 f) {
            fee = f;
        } catch {}
        require(msg.value >= fee, "PMC: insufficient fee");

        uint256 jobId = tracker.submitJob{value: fee}(payload);
        _messages[sid][mid].jobId = jobId;
        _jobToSession[jobId]     = sid;
        _jobToUserMessage[jobId] = mid;

        uint256 excess = msg.value - fee;
        if (excess > 0) {
            (bool ok,) = msg.sender.call{value: excess}("");
            require(ok, "PMC: refund failed");
        }

        emit JobSubmitted(sid, mid, jobId);
    }

    // ── AsyncDelivery callback ───────────────────────────────────────────────

    function receiveDelivery(uint256 jobId, bytes calldata result)
        external override
    {
        require(msg.sender == ASYNC_DELIVERY, "PMC: caller not AsyncDelivery");

        uint256 sid = _jobToSession[jobId];
        uint256 userMid = _jobToUserMessage[jobId];
        require(sid != 0, "PMC: unknown job");

        if (_messages[sid][userMid].id != 0) {
            _messages[sid][userMid].pending = false;
        }

        (
            bytes memory ciphertext,
            bytes memory nonce,
            uint8 modality,
            string memory ipfsCid
        ) = abi.decode(result, (bytes, bytes, uint8, string));

        uint256 responseMid = _nextMessageId++;
        _messages[sid][responseMid] = Message({
            id:         responseMid,
            role:       Role.ASSISTANT,
            modality:   ModalityType(modality),
            ciphertext: ciphertext,
            nonce:      nonce,
            ipfsCid:    ipfsCid,
            timestamp:  block.timestamp,
            pending:    false,
            jobId:      jobId
        });
        _messageIds[sid].push(responseMid);
        _sessions[sid].messageCount++;
        _sessions[sid].updatedAt = block.timestamp;

        delete _jobToSession[jobId];
        delete _jobToUserMessage[jobId];

        emit MessageSent(sid, responseMid, Role.ASSISTANT, ModalityType(modality), block.timestamp);
        emit ResponseDelivered(sid, responseMid, jobId);
    }

    // ── Direct oracle fallback (for testing / non-Ritual deployments) ────────

    function submitResponseDirect(
        uint256 sid,
        uint256 userMid,
        bytes calldata ciphertext,
        bytes calldata nonce,
        ModalityType modality,
        string calldata ipfsCid
    )
        external
        onlyOwner
        sessionExists(sid)
        returns (uint256 responseId)
    {
        require(ciphertext.length > 0, "PMC: empty ciphertext");
        require(nonce.length == 12,    "PMC: invalid nonce");

        if (_messages[sid][userMid].id != 0) {
            _messages[sid][userMid].pending = false;
        }

        responseId = _nextMessageId++;
        _messages[sid][responseId] = Message({
            id:         responseId,
            role:       Role.ASSISTANT,
            modality:   modality,
            ciphertext: ciphertext,
            nonce:      nonce,
            ipfsCid:    ipfsCid,
            timestamp:  block.timestamp,
            pending:    false,
            jobId:      0
        });
        _messageIds[sid].push(responseId);
        _sessions[sid].messageCount++;
        _sessions[sid].updatedAt = block.timestamp;

        emit MessageSent(sid, responseId, Role.ASSISTANT, modality, block.timestamp);
    }

    // ── Read helpers ─────────────────────────────────────────────────────────

    function getSession(uint256 sid)
        external view sessionExists(sid) returns (Session memory)
    { return _sessions[sid]; }

    function getUserSessions(address user)
        external view returns (uint256[] memory)
    { return _userSessions[user]; }

    function getMessages(uint256 sid, uint256 offset, uint256 limit)
        external view sessionExists(sid)
        returns (Message[] memory msgs, uint256 total)
    {
        uint256[] storage ids = _messageIds[sid];
        total = ids.length;
        if (offset >= total) return (new Message[](0), total);
        uint256 end = offset + limit > total ? total : offset + limit;
        msgs = new Message[](end - offset);
        for (uint256 i = 0; i < end - offset; i++) {
            msgs[i] = _messages[sid][ids[offset + i]];
        }
    }

    function getMessage(uint256 sid, uint256 mid)
        external view sessionExists(sid) returns (Message memory)
    { return _messages[sid][mid]; }

    function totalSessions() external view returns (uint256) { return _nextSessionId - 1; }
    function totalMessages() external view returns (uint256) { return _nextMessageId - 1; }

    function getJobRoute(uint256 jobId)
        external view returns (uint256 sessionId, uint256 userMessageId)
    {
        return (_jobToSession[jobId], _jobToUserMessage[jobId]);
    }
}
