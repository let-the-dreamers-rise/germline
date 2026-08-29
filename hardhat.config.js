require("@nomicfoundation/hardhat-toolbox");
require("dotenv").config();

// 0G network details, from docs.0g.ai. Mainnet is chain 16661; Galileo is the
// public testnet and the only one with a faucet.
const DEPLOYER = process.env.DEPLOYER_KEY ? [process.env.DEPLOYER_KEY] : [];

module.exports = {
  solidity: {
    version: "0.8.24",
    settings: {
      optimizer: { enabled: true, runs: 200 },
      // Target paris rather than cancun. 0G is EVM-compatible but its exact
      // EVM revision is not documented, and a contract that emits mcopy or
      // tstore would fail on deploy -- on mainnet, with real tokens. Paris
      // runs everywhere an EVM chain runs.
      evmVersion: "paris",
    },
  },
  networks: {
    hardhat: {},
    zerog: {
      url: process.env.ZEROG_RPC || "https://evmrpc.0g.ai",
      chainId: 16661,
      accounts: DEPLOYER,
    },
    galileo: {
      url: process.env.GALILEO_RPC || "https://evmrpc-testnet.0g.ai",
      chainId: 16601,
      accounts: DEPLOYER,
    },
  },
  etherscan: {
    apiKey: { zerog: "none" },
    customChains: [
      {
        network: "zerog",
        chainId: 16661,
        urls: {
          apiURL: "https://chainscan.0g.ai/open/api",
          browserURL: "https://chainscan.0g.ai",
        },
      },
    ],
  },
};
