// Check everything that can be checked before spending real tokens.
//
// Run this before deploying to mainnet. It confirms the chain is who it says
// it is, prices the deployment, and tells you whether the funded account can
// actually afford the run -- all read-only, so it costs nothing and needs no
// key unless you want the balance check.
//
//   npx hardhat run scripts/preflight.js --network zerog

const hre = require("hardhat");

// The chain each network name must turn out to be. A mismatch means the RPC
// is pointing somewhere unexpected, and deploying into it would burn real
// tokens on the wrong chain.
const EXPECTED_CHAIN = { zerog: 16661n, galileo: 16601n };

// Deploy is the largest single cost, but a demo also founds an organism and
// breeds a few times. These are measured shapes, not guesses: seeding and
// attesting are cheap, spawn writes a whole organism record.
const DEMO_WRITES = {
  seedFounder: 200000n,
  attestFitness: 120000n,
  requestSpawn: 60000n,
  spawn: 280000n,
};
const DEMO_ORGANISMS = 10n;

async function main() {
  const provider = hre.ethers.provider;
  const name = hre.network.name;

  const network = await provider.getNetwork();
  const expected = EXPECTED_CHAIN[name];
  const chainOk = expected === undefined || network.chainId === expected;

  console.log("network:      ", name);
  console.log(
    "chain id:     ",
    Number(network.chainId),
    chainOk ? "(as expected)" : "MISMATCH, expected " + expected
  );
  console.log("block height: ", await provider.getBlockNumber());

  const fees = await provider.getFeeData();
  const gasPrice = fees.gasPrice ?? fees.maxFeePerGas ?? 0n;
  console.log("gas price:    ", hre.ethers.formatUnits(gasPrice, "gwei"), "gwei");

  const factory = await hre.ethers.getContractFactory("Germline");
  const deployTx = await factory.getDeployTransaction(3148, 500, 4);
  const size = (deployTx.data.length - 2) / 2;
  const deployGas = await provider.estimateGas({ data: deployTx.data });

  const perOrganism =
    DEMO_WRITES.requestSpawn + DEMO_WRITES.spawn + DEMO_WRITES.attestFitness;
  const demoGas =
    deployGas +
    DEMO_WRITES.seedFounder +
    DEMO_WRITES.attestFitness +
    perOrganism * DEMO_ORGANISMS;

  console.log("");
  console.log("contract size:", size, "bytes of", 24576, "allowed");
  console.log("deploy gas:   ", deployGas.toString());
  console.log(
    "deploy cost:  ",
    hre.ethers.formatEther(deployGas * gasPrice),
    "0G"
  );
  console.log(
    "full demo:    ",
    hre.ethers.formatEther(demoGas * gasPrice),
    "0G  (deploy, found, and",
    Number(DEMO_ORGANISMS),
    "organisms bred)"
  );

  // The balance check only works once a key is configured, and it is the one
  // failure that wastes a deadline: discovering an empty account at deploy.
  const signers = await hre.ethers.getSigners();
  console.log("");
  if (signers.length === 0) {
    console.log("deployer:      none configured");
    console.log("              set DEPLOYER_KEY in .env to check the balance");
  } else {
    const deployer = signers[0];
    const balance = await provider.getBalance(deployer.address);
    console.log("deployer:     ", deployer.address);
    console.log("balance:      ", hre.ethers.formatEther(balance), "0G");
    const needed = demoGas * gasPrice;
    if (balance >= needed) {
      console.log("verdict:       funded, enough for the full demo");
    } else if (balance >= deployGas * gasPrice) {
      console.log("verdict:       enough to deploy, may run short during breeding");
    } else {
      console.log("verdict:       NOT ENOUGH to deploy");
      process.exitCode = 1;
    }
  }

  if (!chainOk) process.exitCode = 1;
}

main().catch((error) => {
  console.error("preflight failed:", error.shortMessage || error.message);
  process.exitCode = 1;
});
