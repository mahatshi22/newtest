require("@nomicfoundation/hardhat-toolbox");
require("dotenv").config();
const { subtask } = require("hardhat/config");
const { TASK_COMPILE_SOLIDITY_GET_SOLC_BUILD } = require("hardhat/builtin-tasks/task-names");

subtask(TASK_COMPILE_SOLIDITY_GET_SOLC_BUILD, async (args, hre, runSuper) => {
  const solc = require("solc");
  const longVer = solc.version();           // e.g. "0.8.26+commit.8a97fa7a.Emscripten.clang"
  const shortVer = longVer.split("+")[0];   // "0.8.26"
  return {
    compilerPath: require.resolve("solc/soljson.js"),
    isSolcJs: true,
    version: shortVer,
    longVersion: longVer,
  };
});

module.exports = {
  gasReporter: {
    enabled: process.env.REPORT_GAS === "true",
  },
  solidity: {
    version: "0.8.26",
    settings: {
      optimizer: { enabled: true, runs: 200 },
    },
  },
  networks: {
    hardhat: {},
    localhost: { url: "http://127.0.0.1:8545" },
    ritual: {
      url: process.env.RITUAL_RPC_URL || "https://rpc.ritualfoundation.org",
      accounts: process.env.PRIVATE_KEY ? [process.env.PRIVATE_KEY] : [],
      chainId: 1979,
    },
  },
  etherscan: {
    apiKey: { ritual: process.env.RITUAL_EXPLORER_API_KEY || "" },
    customChains: [{
      network: "ritual",
      chainId: 1979,
      urls: {
        apiURL: "https://explorer.ritualfoundation.org/api",
        browserURL: "https://explorer.ritualfoundation.org",
      },
    }],
  },
};
