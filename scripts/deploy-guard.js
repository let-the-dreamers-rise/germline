// Deploy a GermlineGuard for one agent's log (see docs/AGENTS.md).
//
//   GUARD_LOG_ID=0x… GUARD_ANCHORER=0x… GUARD_DELAY=86400 \
//     npx hardhat run scripts/deploy-guard.js --network zerog
//
// GUARD_REGISTRY defaults to the GermlineAnchor recorded in
// deployments/<network>-anchor.json. The guard has no owner; its parameters
// can't be changed after this.

const fs = require("fs");
const path = require("path");
const hre = require("hardhat");

function required(name, pattern) {
  const value = process.env[name];
  if (!value || !pattern.test(value)) throw new Error(name + " must be set (" + pattern + ")");
  return value;
}

async function main() {
  const logId = required("GUARD_LOG_ID", /^0x[0-9a-fA-F]{64}$/);
  const anchorer = required("GUARD_ANCHORER", /^0x[0-9a-fA-F]{40}$/);
  const delay = Number(required("GUARD_DELAY", /^[0-9]+$/));
  let registry = process.env.GUARD_REGISTRY;
  if (!registry) {
    const file = path.join(__dirname, "..", "deployments", hre.network.name + "-anchor.json");
    if (!fs.existsSync(file)) throw new Error("no GermlineAnchor recorded for " + hre.network.name + "; set GUARD_REGISTRY");
    registry = JSON.parse(fs.readFileSync(file, "utf8")).address;
  }
  const [deployer] = await hre.ethers.getSigners();
  if (!deployer) throw new Error("no deployer account: set DEPLOYER_KEY");
  console.log("deploying GermlineGuard on " + hre.network.name + ": log " + logId + ", operator " + anchorer + ", delay " + delay + "s");
  const guard = await (await hre.ethers.getContractFactory("GermlineGuard")).deploy(registry, logId, anchorer, delay);
  const receipt = await guard.deploymentTransaction().wait();
  console.log("GermlineGuard at " + (await guard.getAddress()) + " (tx " + receipt.hash + ")");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
