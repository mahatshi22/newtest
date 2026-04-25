import { ethers } from "ethers";
import { PRIVATE_MULTI_MODAL_CHAT_ABI } from "./abi";

export interface SessionInfo {
  id: bigint;
  owner: string;
  title: string;
  ecdhPublicKey: string;
  status: number;
  createdAt: bigint;
  updatedAt: bigint;
  messageCount: bigint;
}

export interface MessageInfo {
  id: bigint;
  role: number;         // 0=USER, 1=ASSISTANT
  modality: number;     // 0=TEXT, 1=IMAGE, 2=AUDIO
  ciphertext: string;
  nonce: string;
  ipfsCid: string;
  timestamp: bigint;
  pending: boolean;
  jobId: bigint;
  plaintextContent?: string; // populated after decryption
}

export interface EncryptedMessage {
  ciphertext: Uint8Array;
  nonce: Uint8Array;
}

/**
 * Manages deterministic per-session AES-256-GCM keys derived from wallet signatures.
 */
export class SessionKeyManager {
  private keyCache = new Map<bigint, CryptoKey>();

  constructor(private readonly signer: ethers.Signer) {}

  /**
   * Derive a deterministic AES-256-GCM key for a session using a wallet signature.
   * The user signs a domain-specific message; the signature is used as HKDF input.
   */
  async getSessionKey(sessionId: bigint): Promise<CryptoKey> {
    if (this.keyCache.has(sessionId)) {
      return this.keyCache.get(sessionId)!;
    }

    const message = `Ritual Chat Session Key\nSession: ${sessionId}\nThis signature generates your encryption key.`;
    const signature = await this.signer.signMessage(message);
    const sigBytes = ethers.getBytes(signature);

    // Import signature as HKDF key material
    const keyMaterial = await crypto.subtle.importKey(
      "raw",
      sigBytes,
      { name: "HKDF" },
      false,
      ["deriveKey"]
    );

    // Derive AES-256-GCM key
    const key = await crypto.subtle.deriveKey(
      {
        name: "HKDF",
        hash: "SHA-256",
        salt: new TextEncoder().encode(`ritual-chat-v1-session-${sessionId}`),
        info: new TextEncoder().encode("aes-gcm-key"),
      },
      keyMaterial,
      { name: "AES-GCM", length: 256 },
      false,
      ["encrypt", "decrypt"]
    );

    this.keyCache.set(sessionId, key);
    return key;
  }

  clearCache(): void {
    this.keyCache.clear();
  }
}

/**
 * Generate an ephemeral ECDH P-256 key pair for a session.
 * The public key is stored on-chain; the private key stays in memory.
 */
export async function generateSessionKeyPair(): Promise<{
  publicKeyBytes: Uint8Array; // 65-byte uncompressed
  keyPair: CryptoKeyPair;
}> {
  const keyPair = await crypto.subtle.generateKey(
    { name: "ECDH", namedCurve: "P-256" },
    true,
    ["deriveKey", "deriveBits"]
  );

  const rawPublic = await crypto.subtle.exportKey("raw", keyPair.publicKey);
  return {
    publicKeyBytes: new Uint8Array(rawPublic), // 65 bytes, starts with 0x04
    keyPair,
  };
}

/**
 * Encrypt a plaintext string using AES-256-GCM.
 */
export async function encryptMessage(
  plaintext: string,
  key: CryptoKey
): Promise<EncryptedMessage> {
  const nonce = crypto.getRandomValues(new Uint8Array(12));
  const encoded = new TextEncoder().encode(plaintext);
  const cipherBuf = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: nonce },
    key,
    encoded
  );
  return {
    ciphertext: new Uint8Array(cipherBuf),
    nonce,
  };
}

/**
 * Decrypt AES-256-GCM ciphertext.
 */
export async function decryptMessage(
  ciphertext: Uint8Array,
  nonce: Uint8Array,
  key: CryptoKey
): Promise<string> {
  const plainBuf = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: nonce },
    key,
    ciphertext
  );
  return new TextDecoder().decode(plainBuf);
}

/**
 * Main ChatClient for interacting with PrivateMultiModalChat on-chain.
 */
export class ChatClient {
  private contract: ethers.Contract;
  private keyManager: SessionKeyManager;

  constructor(
    contractAddress: string,
    signerOrProvider: ethers.Signer | ethers.Provider
  ) {
    this.contract = new ethers.Contract(
      contractAddress,
      PRIVATE_MULTI_MODAL_CHAT_ABI,
      signerOrProvider
    );
    this.keyManager = new SessionKeyManager(signerOrProvider as ethers.Signer);
  }

  // ── Sessions ──────────────────────────────────────────────────────────────

  async createSession(title: string): Promise<{ sessionId: bigint; publicKeyBytes: Uint8Array; keyPair: CryptoKeyPair }> {
    const { publicKeyBytes, keyPair } = await generateSessionKeyPair();
    const tx = await this.contract.createSession(title, publicKeyBytes);
    const receipt = await tx.wait();

    // Parse SessionCreated event
    const iface = this.contract.interface;
    let sessionId = 0n;
    for (const log of receipt.logs) {
      try {
        const parsed = iface.parseLog(log);
        if (parsed?.name === "SessionCreated") {
          sessionId = parsed.args.sessionId;
          break;
        }
      } catch {}
    }

    return { sessionId, publicKeyBytes, keyPair };
  }

  async getSession(sessionId: bigint): Promise<SessionInfo> {
    return this.contract.getSession(sessionId);
  }

  async getUserSessions(address: string): Promise<bigint[]> {
    return this.contract.getUserSessions(address);
  }

  async archiveSession(sessionId: bigint): Promise<ethers.TransactionReceipt> {
    const tx = await this.contract.archiveSession(sessionId);
    return tx.wait();
  }

  // ── Messages ──────────────────────────────────────────────────────────────

  async sendMessage(
    sessionId: bigint,
    content: string,
    modality: 0 | 1 | 2 = 0,
    dispatchAI = true,
    ipfsCid = "",
    value = 0n
  ): Promise<{ messageId: bigint }> {
    const key = await this.keyManager.getSessionKey(sessionId);
    const { ciphertext, nonce } = await encryptMessage(content, key);

    const tx = await this.contract.sendMessage(
      sessionId,
      modality,
      ciphertext,
      nonce,
      ipfsCid,
      dispatchAI,
      { value }
    );
    const receipt = await tx.wait();

    const iface = this.contract.interface;
    let messageId = 0n;
    for (const log of receipt.logs) {
      try {
        const parsed = iface.parseLog(log);
        if (parsed?.name === "MessageSent" && parsed.args.role === 0n) {
          messageId = parsed.args.messageId;
          break;
        }
      } catch {}
    }

    return { messageId };
  }

  async getMessages(
    sessionId: bigint,
    offset = 0,
    limit = 50
  ): Promise<{ messages: MessageInfo[]; total: bigint }> {
    const [rawMsgs, total] = await this.contract.getMessages(sessionId, offset, limit);
    const key = await this.keyManager.getSessionKey(sessionId);

    const messages: MessageInfo[] = await Promise.all(
      rawMsgs.map(async (m: MessageInfo) => {
        let plaintextContent: string | undefined;
        try {
          const ct = ethers.getBytes(m.ciphertext);
          const n = ethers.getBytes(m.nonce);
          plaintextContent = await decryptMessage(ct, n, key);
        } catch {}
        return { ...m, plaintextContent };
      })
    );

    return { messages, total };
  }
}
