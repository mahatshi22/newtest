const { ethers } = require("hardhat");

async function main() {
  const [deployer] = await ethers.getSigners();
  console.log("Deployer:", deployer.address);
  console.log("Balance:", ethers.formatEther(await ethers.provider.getBalance(deployer.address)), "RITUAL");

  const aiServiceId = process.env.AI_SERVICE_ID
    ? ethers.zeroPadValue(ethers.toUtf8Bytes(process.env.AI_SERVICE_ID), 32)
    : ethers.id("gpt-4-multimodal-v1");

  console.log("AI Service ID:", aiServiceId);

  const Factory = await ethers.getContractFactory("PrivateMultiModalChat");
  const chat = await Factory.deploy(aiServiceId);
  await chat.waitForDeployment();

  const addr = await chat.getAddress();
  console.log("PrivateMultiModalChat deployed to:", addr);
  console.log("Ritual Explorer:", `https://explorer.ritualfoundation.org/address/${addr}`);

  const fs = require("fs");
  const info = {
    network: "ritual",
    chainId: 1979,
    contractAddress: addr,
    aiServiceId,
    deployedBy: deployer.address,
    deployedAt: new Date().toISOString(),
    ritualSystemContracts: {
      AsyncJobTracker:    "0xC069FFCa0389f44eCA2C626e55491b0ab045AEF5",
      AsyncDelivery:      "0x5A16214fF555848411544b005f7Ac063742f39F6",
      SecretsACL:         "0xf9BF1BC8A3e79B9EBeD0fa2Db70D0513fecE32FD",
      TEEServiceRegistry: "0x9644e8562cE0Fe12b4deeC4163c064A8862Bf47F",
      Scheduler:          "0x56e776BAE2DD60664b69Bd5F865F1180ffB7D58B",
      RitualWallet:       "0x532F0dF0896F353d8C3DD8cc134e8129DA2a3948",
    },
  };

  if (!fs.existsSync("deployments")) fs.mkdirSync("deployments");
  fs.writeFileSync("deployments/1979.json", JSON.stringify(info, null, 2));
  console.log("Deployment info saved to deployments/1979.json");
}

main().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1); });
