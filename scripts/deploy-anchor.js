// Deploy the GermlineAnchor registry, once per chain.
//
//   npx hardhat run scripts/deploy-anchor.js --network zerog
//
// The registry has no owner and no settings, so one deployment serves every
// customer on that chain. The address is written to
// deployments/<network>-anchor.json, which the CLI reads to find it.

const fs = require("fs");
const path = require("path");
const hre = require("hardhat");

async function main() {
  const [deployer] = await hre.ethers.getSigners();
  if (!deployer) throw new Error("no deployer account: set DEPLOYER_KEY");
  const network = await hre.ethers.provider.getNetwork();
  console.log("deploying GermlineAnchor to " + hre.network.name + " (chain " + network.chainId + ") from " + deployer.address);

  const factory = await hre.ethers.getContractFactory("GermlineAnchor");
  const registry = await factory.deploy();
  const receipt = await registry.deploymentTransaction().wait();
  const address = await registry.getAddress();

  const record = {
    network: hre.network.name,
    chainId: Number(network.chainId),
    address,
    deployTx: receipt.hash,
    block: receipt.blockNumber,
    deployer: deployer.address,
    deployedAt: new Date().toISOString(),
  };
  const dir = process.env.GERMLINE_DEPLOYMENTS || path.join(__dirname, "..", "deployments");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, hre.network.name + "-anchor.json");
  fs.writeFileSync(file, JSON.stringify(record, null, 2) + "\n");
  console.log("GermlineAnchor at " + address);
  console.log("recorded in " + file);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
