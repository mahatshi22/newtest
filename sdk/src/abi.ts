export const PRIVATE_MULTI_MODAL_CHAT_ABI = [
  // Constructor
  "constructor(bytes32 _aiServiceId)",

  // Admin
  "function owner() view returns (address)",
  "function aiServiceId() view returns (bytes32)",
  "function setAiServiceId(bytes32 _id) external",
  "function transferOwnership(address newOwner) external",
  "function withdraw() external",

  // System contracts
  "function ASYNC_JOB_TRACKER() view returns (address)",
  "function ASYNC_DELIVERY() view returns (address)",
  "function SECRETS_ACL() view returns (address)",

  // Sessions
  "function createSession(string calldata title, bytes calldata ecdhPubKey) external returns (uint256 sessionId)",
  "function archiveSession(uint256 sid) external",
  "function deleteSession(uint256 sid) external",
  "function getSession(uint256 sid) view returns (tuple(uint256 id, address owner, string title, bytes ecdhPublicKey, uint8 status, uint256 createdAt, uint256 updatedAt, uint256 messageCount))",
  "function getUserSessions(address user) view returns (uint256[])",
  "function totalSessions() view returns (uint256)",

  // Messages
  "function sendMessage(uint256 sid, uint8 modality, bytes calldata ciphertext, bytes calldata nonce, string calldata ipfsCid, bool dispatchAI) external payable returns (uint256 messageId)",
  "function submitResponseDirect(uint256 sid, uint256 userMid, bytes calldata ciphertext, bytes calldata nonce, uint8 modality, string calldata ipfsCid) external returns (uint256 responseId)",
  "function receiveDelivery(uint256 jobId, bytes calldata result) external",
  "function getMessage(uint256 sid, uint256 mid) view returns (tuple(uint256 id, uint8 role, uint8 modality, bytes ciphertext, bytes nonce, string ipfsCid, uint256 timestamp, bool pending, uint256 jobId))",
  "function getMessages(uint256 sid, uint256 offset, uint256 limit) view returns (tuple(uint256 id, uint8 role, uint8 modality, bytes ciphertext, bytes nonce, string ipfsCid, uint256 timestamp, bool pending, uint256 jobId)[] msgs, uint256 total)",
  "function totalMessages() view returns (uint256)",
  "function getJobRoute(uint256 jobId) view returns (uint256 sessionId, uint256 userMessageId)",

  // Events
  "event SessionCreated(uint256 indexed sessionId, address indexed owner, string title, uint256 timestamp)",
  "event SessionUpdated(uint256 indexed sessionId, uint8 status)",
  "event MessageSent(uint256 indexed sessionId, uint256 indexed messageId, uint8 role, uint8 modality, uint256 timestamp)",
  "event JobSubmitted(uint256 indexed sessionId, uint256 indexed messageId, uint256 jobId)",
  "event ResponseDelivered(uint256 indexed sessionId, uint256 indexed messageId, uint256 jobId)",
  "event ServiceIdUpdated(bytes32 oldId, bytes32 newId)",
] as const;
