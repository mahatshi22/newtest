const { expect } = require("chai");
const { ethers, network } = require("hardhat");
const { loadFixture } = require("@nomicfoundation/hardhat-network-helpers");

const ASYNC_DELIVERY_ADDR = "0x5A16214fF555848411544b005f7Ac063742f39F6";

// 65-byte fake ECDH public key
const FAKE_PUBKEY = "0x04" + "ab".repeat(32) + "cd".repeat(32);

async function deployFixture() {
  const [owner, alice, bob] = await ethers.getSigners();

  // Deploy mock tracker
  const MockTracker = await ethers.getContractFactory("MockAsyncJobTracker");
  const mockTracker = await MockTracker.deploy();
  await mockTracker.waitForDeployment();

  // Deploy main contract
  const aiServiceId = ethers.id("gpt-4-multimodal-v1");
  const Factory = await ethers.getContractFactory("PrivateMultiModalChat");
  const chat = await Factory.deploy(aiServiceId);
  await chat.waitForDeployment();

  return { chat, mockTracker, owner, alice, bob, aiServiceId };
}

function makeNonce() {
  return ethers.hexlify(ethers.randomBytes(12)); // 12 bytes
}

function makeCipher() {
  return ethers.hexlify(ethers.randomBytes(64)); // some ciphertext
}

describe("PrivateMultiModalChat", function () {

  // ── Deployment ────────────────────────────────────────────────────────────

  describe("Deployment", function () {
    it("sets owner correctly", async function () {
      const { chat, owner } = await loadFixture(deployFixture);
      expect(await chat.owner()).to.equal(owner.address);
    });

    it("sets aiServiceId correctly", async function () {
      const { chat, aiServiceId } = await loadFixture(deployFixture);
      expect(await chat.aiServiceId()).to.equal(aiServiceId);
    });

    it("starts with zero sessions and messages", async function () {
      const { chat } = await loadFixture(deployFixture);
      expect(await chat.totalSessions()).to.equal(0);
      expect(await chat.totalMessages()).to.equal(0);
    });

    it("has correct system contract constants", async function () {
      const { chat } = await loadFixture(deployFixture);
      expect(await chat.ASYNC_JOB_TRACKER()).to.equal("0xC069FFCa0389f44eCA2C626e55491b0ab045AEF5");
      expect(await chat.ASYNC_DELIVERY()).to.equal(ASYNC_DELIVERY_ADDR);
      expect(await chat.SECRETS_ACL()).to.equal("0xf9BF1BC8A3e79B9EBeD0fa2Db70D0513fecE32FD");
    });
  });

  // ── Admin ─────────────────────────────────────────────────────────────────

  describe("Admin", function () {
    it("owner can set AI service ID", async function () {
      const { chat, owner } = await loadFixture(deployFixture);
      const newId = ethers.id("new-service");
      await expect(chat.connect(owner).setAiServiceId(newId))
        .to.emit(chat, "ServiceIdUpdated");
      expect(await chat.aiServiceId()).to.equal(newId);
    });

    it("non-owner cannot set AI service ID", async function () {
      const { chat, alice } = await loadFixture(deployFixture);
      await expect(chat.connect(alice).setAiServiceId(ethers.id("x")))
        .to.be.revertedWith("PMC: not owner");
    });

    it("owner can transfer ownership", async function () {
      const { chat, owner, alice } = await loadFixture(deployFixture);
      await chat.connect(owner).transferOwnership(alice.address);
      expect(await chat.owner()).to.equal(alice.address);
    });

    it("cannot transfer to zero address", async function () {
      const { chat, owner } = await loadFixture(deployFixture);
      await expect(chat.connect(owner).transferOwnership(ethers.ZeroAddress))
        .to.be.revertedWith("PMC: zero address");
    });

    it("owner can withdraw ETH", async function () {
      const { chat, owner } = await loadFixture(deployFixture);
      // fund the contract
      await owner.sendTransaction({ to: await chat.getAddress(), value: ethers.parseEther("1") });
      const before = await ethers.provider.getBalance(owner.address);
      const tx = await chat.connect(owner).withdraw();
      const receipt = await tx.wait();
      const gasUsed = receipt.gasUsed * receipt.gasPrice;
      const after = await ethers.provider.getBalance(owner.address);
      expect(after + gasUsed).to.be.greaterThan(before);
    });
  });

  // ── Session CRUD ──────────────────────────────────────────────────────────

  describe("Session management", function () {
    it("creates a session and emits event", async function () {
      const { chat, alice } = await loadFixture(deployFixture);
      await expect(chat.connect(alice).createSession("My Chat", FAKE_PUBKEY))
        .to.emit(chat, "SessionCreated");
      expect(await chat.totalSessions()).to.equal(1);
    });

    it("session owner is correct", async function () {
      const { chat, alice } = await loadFixture(deployFixture);
      await chat.connect(alice).createSession("Test", FAKE_PUBKEY);
      const s = await chat.getSession(1);
      expect(s.owner).to.equal(alice.address);
      expect(s.title).to.equal("Test");
      expect(s.messageCount).to.equal(0);
    });

    it("rejects invalid pubkey length", async function () {
      const { chat, alice } = await loadFixture(deployFixture);
      await expect(chat.connect(alice).createSession("Bad", "0x1234"))
        .to.be.revertedWith("PMC: invalid pubkey length");
    });

    it("tracks user sessions", async function () {
      const { chat, alice } = await loadFixture(deployFixture);
      await chat.connect(alice).createSession("A", FAKE_PUBKEY);
      await chat.connect(alice).createSession("B", FAKE_PUBKEY);
      const sessions = await chat.getUserSessions(alice.address);
      expect(sessions.length).to.equal(2);
      expect(sessions[0]).to.equal(1);
      expect(sessions[1]).to.equal(2);
    });

    it("archives a session", async function () {
      const { chat, alice } = await loadFixture(deployFixture);
      await chat.connect(alice).createSession("A", FAKE_PUBKEY);
      await expect(chat.connect(alice).archiveSession(1))
        .to.emit(chat, "SessionUpdated")
        .withArgs(1, 1); // ARCHIVED = 1
      const s = await chat.getSession(1);
      expect(s.status).to.equal(1); // ARCHIVED
    });

    it("deletes a session", async function () {
      const { chat, alice } = await loadFixture(deployFixture);
      await chat.connect(alice).createSession("A", FAKE_PUBKEY);
      await expect(chat.connect(alice).deleteSession(1))
        .to.emit(chat, "SessionUpdated")
        .withArgs(1, 2); // DELETED = 2
    });

    it("non-owner cannot archive session", async function () {
      const { chat, alice, bob } = await loadFixture(deployFixture);
      await chat.connect(alice).createSession("A", FAKE_PUBKEY);
      await expect(chat.connect(bob).archiveSession(1))
        .to.be.revertedWith("PMC: not session owner");
    });

    it("getSession reverts for non-existent session", async function () {
      const { chat } = await loadFixture(deployFixture);
      await expect(chat.getSession(999))
        .to.be.revertedWith("PMC: session not found");
    });
  });

  // ── Messaging ─────────────────────────────────────────────────────────────

  describe("sendMessage", function () {
    async function sessionFixture() {
      const base = await deployFixture();
      await base.chat.connect(base.alice).createSession("Test Session", FAKE_PUBKEY);
      return { ...base, sid: 1 };
    }

    it("sends a text message", async function () {
      const { chat, alice, sid } = await loadFixture(sessionFixture);
      const ct = makeCipher();
      const nonce = makeNonce();
      await expect(
        chat.connect(alice).sendMessage(sid, 0, ct, nonce, "", false)
      ).to.emit(chat, "MessageSent");
      expect(await chat.totalMessages()).to.equal(1);
    });

    it("increments session messageCount", async function () {
      const { chat, alice, sid } = await loadFixture(sessionFixture);
      await chat.connect(alice).sendMessage(sid, 0, makeCipher(), makeNonce(), "", false);
      const s = await chat.getSession(sid);
      expect(s.messageCount).to.equal(1);
    });

    it("sends an image message with IPFS CID", async function () {
      const { chat, alice, sid } = await loadFixture(sessionFixture);
      await expect(
        chat.connect(alice).sendMessage(sid, 1, makeCipher(), makeNonce(), "QmFakeCID123", false)
      ).to.emit(chat, "MessageSent");
    });

    it("rejects image message without CID", async function () {
      const { chat, alice, sid } = await loadFixture(sessionFixture);
      await expect(
        chat.connect(alice).sendMessage(sid, 1, makeCipher(), makeNonce(), "", false)
      ).to.be.revertedWith("PMC: CID required for media");
    });

    it("rejects empty ciphertext", async function () {
      const { chat, alice, sid } = await loadFixture(sessionFixture);
      await expect(
        chat.connect(alice).sendMessage(sid, 0, "0x", makeNonce(), "", false)
      ).to.be.revertedWith("PMC: empty ciphertext");
    });

    it("rejects invalid nonce length", async function () {
      const { chat, alice, sid } = await loadFixture(sessionFixture);
      await expect(
        chat.connect(alice).sendMessage(sid, 0, makeCipher(), "0x1234", "", false)
      ).to.be.revertedWith("PMC: invalid nonce");
    });

    it("non-owner cannot send to session", async function () {
      const { chat, bob, sid } = await loadFixture(sessionFixture);
      await expect(
        chat.connect(bob).sendMessage(sid, 0, makeCipher(), makeNonce(), "", false)
      ).to.be.revertedWith("PMC: not session owner");
    });

    it("cannot send to archived session", async function () {
      const { chat, alice, sid } = await loadFixture(sessionFixture);
      await chat.connect(alice).archiveSession(sid);
      await expect(
        chat.connect(alice).sendMessage(sid, 0, makeCipher(), makeNonce(), "", false)
      ).to.be.revertedWith("PMC: session not active");
    });
  });

  // ── submitResponseDirect ──────────────────────────────────────────────────

  describe("submitResponseDirect", function () {
    async function sessionWithMessageFixture() {
      const base = await deployFixture();
      await base.chat.connect(base.alice).createSession("Test", FAKE_PUBKEY);
      await base.chat.connect(base.alice).sendMessage(1, 0, makeCipher(), makeNonce(), "", false);
      return { ...base, sid: 1, userMid: 1 };
    }

    it("owner can submit direct response", async function () {
      const { chat, owner, sid, userMid } = await loadFixture(sessionWithMessageFixture);
      await expect(
        chat.connect(owner).submitResponseDirect(sid, userMid, makeCipher(), makeNonce(), 0, "")
      ).to.emit(chat, "MessageSent");
      const s = await chat.getSession(sid);
      expect(s.messageCount).to.equal(2); // user + assistant
    });

    it("response has ASSISTANT role", async function () {
      const { chat, owner, sid, userMid } = await loadFixture(sessionWithMessageFixture);
      await chat.connect(owner).submitResponseDirect(sid, userMid, makeCipher(), makeNonce(), 0, "");
      const msg = await chat.getMessage(sid, 2);
      expect(msg.role).to.equal(1); // ASSISTANT
    });

    it("non-owner cannot submit direct response", async function () {
      const { chat, alice, sid, userMid } = await loadFixture(sessionWithMessageFixture);
      await expect(
        chat.connect(alice).submitResponseDirect(sid, userMid, makeCipher(), makeNonce(), 0, "")
      ).to.be.revertedWith("PMC: not owner");
    });

    it("rejects empty ciphertext in response", async function () {
      const { chat, owner, sid, userMid } = await loadFixture(sessionWithMessageFixture);
      await expect(
        chat.connect(owner).submitResponseDirect(sid, userMid, "0x", makeNonce(), 0, "")
      ).to.be.revertedWith("PMC: empty ciphertext");
    });
  });

  // ── receiveDelivery callback ──────────────────────────────────────────────

  describe("receiveDelivery", function () {
    async function jobFixture() {
      const base = await deployFixture();
      const { chat, alice } = base;

      // Fund ASYNC_DELIVERY impersonation
      await network.provider.send("hardhat_setBalance", [
        ASYNC_DELIVERY_ADDR,
        "0x" + ethers.parseEther("10").toString(16),
      ]);
      await network.provider.send("hardhat_impersonateAccount", [ASYNC_DELIVERY_ADDR]);
      const deliverySigner = await ethers.getSigner(ASYNC_DELIVERY_ADDR);

      // Create session
      await chat.connect(alice).createSession("Test", FAKE_PUBKEY);

      // Deploy mock tracker, get its bytecode, set it at the hardcoded address
      const mockTrackerFactory = await ethers.getContractFactory("MockAsyncJobTracker");
      const mockTracker = await mockTrackerFactory.deploy();
      await mockTracker.waitForDeployment();
      const mockCode = await ethers.provider.getCode(await mockTracker.getAddress());
      await network.provider.send("hardhat_setCode", [
        "0xC069FFCa0389f44eCA2C626e55491b0ab045AEF5",
        mockCode,
      ]);

      // Send message with dispatchAI=true (fee=0 from mock)
      // NOTE: hardhat_setCode sets bytecode only; storage starts at 0.
      // So MockAsyncJobTracker._nextJobId slot = 0, meaning submitJob returns jobId=0.
      await chat.connect(alice).sendMessage(1, 0, makeCipher(), makeNonce(), "", true, { value: 0 });

      // Job ID from mock tracker is 0 (storage starts zeroed after hardhat_setCode)
      const jobId = 0n;

      return { ...base, chat, alice, deliverySigner, jobId, sid: 1n };
    }

    it("receiveDelivery from AsyncDelivery stores response message", async function () {
      const { chat, deliverySigner, jobId, sid } = await loadFixture(jobFixture);

      const responseCt = makeCipher();
      const responseNonce = makeNonce();
      const resultPayload = ethers.AbiCoder.defaultAbiCoder().encode(
        ["bytes", "bytes", "uint8", "string"],
        [responseCt, responseNonce, 0, ""]
      );

      await expect(
        chat.connect(deliverySigner).receiveDelivery(jobId, resultPayload)
      ).to.emit(chat, "ResponseDelivered");

      // The session should now have 2 messages (user + assistant)
      const s = await chat.getSession(sid);
      expect(s.messageCount).to.equal(2);
    });

    it("receiveDelivery rejects caller that is not AsyncDelivery", async function () {
      const { chat, alice, jobId } = await loadFixture(jobFixture);
      const fakeResult = ethers.AbiCoder.defaultAbiCoder().encode(
        ["bytes", "bytes", "uint8", "string"],
        [makeCipher(), makeNonce(), 0, ""]
      );
      await expect(
        chat.connect(alice).receiveDelivery(jobId, fakeResult)
      ).to.be.revertedWith("PMC: caller not AsyncDelivery");
    });

    it("receiveDelivery rejects unknown jobId", async function () {
      const { chat, deliverySigner } = await loadFixture(jobFixture);
      const fakeResult = ethers.AbiCoder.defaultAbiCoder().encode(
        ["bytes", "bytes", "uint8", "string"],
        [makeCipher(), makeNonce(), 0, ""]
      );
      await expect(
        chat.connect(deliverySigner).receiveDelivery(9999n, fakeResult)
      ).to.be.revertedWith("PMC: unknown job");
    });

    it("receiveDelivery clears job routing maps", async function () {
      const { chat, deliverySigner, jobId } = await loadFixture(jobFixture);
      const resultPayload = ethers.AbiCoder.defaultAbiCoder().encode(
        ["bytes", "bytes", "uint8", "string"],
        [makeCipher(), makeNonce(), 0, ""]
      );
      await chat.connect(deliverySigner).receiveDelivery(jobId, resultPayload);
      const [sessionId, userMid] = await chat.getJobRoute(jobId);
      expect(sessionId).to.equal(0);
      expect(userMid).to.equal(0);
    });
  });

  // ── getMessages pagination ────────────────────────────────────────────────

  describe("getMessages pagination", function () {
    async function manyMessagesFixture() {
      const base = await deployFixture();
      const { chat, alice } = base;
      await chat.connect(alice).createSession("Test", FAKE_PUBKEY);
      for (let i = 0; i < 5; i++) {
        await chat.connect(alice).sendMessage(1, 0, makeCipher(), makeNonce(), "", false);
      }
      return { ...base, sid: 1 };
    }

    it("returns all messages with large limit", async function () {
      const { chat, sid } = await loadFixture(manyMessagesFixture);
      const [msgs, total] = await chat.getMessages(sid, 0, 100);
      expect(total).to.equal(5);
      expect(msgs.length).to.equal(5);
    });

    it("paginates correctly", async function () {
      const { chat, sid } = await loadFixture(manyMessagesFixture);
      const [page1] = await chat.getMessages(sid, 0, 3);
      const [page2] = await chat.getMessages(sid, 3, 3);
      expect(page1.length).to.equal(3);
      expect(page2.length).to.equal(2);
    });

    it("returns empty array when offset >= total", async function () {
      const { chat, sid } = await loadFixture(manyMessagesFixture);
      const [msgs, total] = await chat.getMessages(sid, 10, 5);
      expect(msgs.length).to.equal(0);
      expect(total).to.equal(5);
    });
  });

  // ── Fee refund logic ──────────────────────────────────────────────────────

  describe("Fee refund", function () {
    it("refunds excess ETH when fee < value sent", async function () {
      const { chat, alice } = await loadFixture(deployFixture);
      // Set up ASYNC_JOB_TRACKER mock with zero fee
      const mockTrackerFactory = await ethers.getContractFactory("MockAsyncJobTracker");
      const mockTracker = await mockTrackerFactory.deploy();
      await mockTracker.waitForDeployment();
      const mockCode = await ethers.provider.getCode(await mockTracker.getAddress());
      await network.provider.send("hardhat_setCode", [
        "0xC069FFCa0389f44eCA2C626e55491b0ab045AEF5",
        mockCode,
      ]);

      await chat.connect(alice).createSession("Fee Test", FAKE_PUBKEY);

      const aliceBefore = await ethers.provider.getBalance(alice.address);
      const excess = ethers.parseEther("0.1");
      const tx = await chat.connect(alice).sendMessage(1, 0, makeCipher(), makeNonce(), "", true, { value: excess });
      const receipt = await tx.wait();
      const gasSpent = receipt.gasUsed * receipt.gasPrice;
      const aliceAfter = await ethers.provider.getBalance(alice.address);

      // Alice should get back the excess (fee=0, sent 0.1 ETH)
      // aliceBefore - gasSpent ≈ aliceAfter (excess refunded)
      const diff = aliceBefore - aliceAfter - gasSpent;
      expect(diff).to.be.closeTo(0n, ethers.parseEther("0.001"));
    });
  });
});
