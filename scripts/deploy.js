// Deploy Germline. Selection parameters are not taste: the survival
// threshold is the measured score of a predictor that uses nothing but the
// action, so an organism must be at least as useful as having no model.

const hre = require("hardhat");
const fs = require("fs");
const path = require("path");

// engine/fitness.js measures the action-only baseline at 3148 bps on the
// shipped corpus. Anything below that is not worth reproducing, because it is
// worse than having no world model at all.
const SURVIVAL_THRESHOLD = 3148;

// Each further 5 points of effective accuracy earns one more child.
const FECUNDITY_STEP = 500;

// Attempts a merely-viable organism gets. Measured rather than chosen: with
// one attempt the simulated lineage in engine/evolve.js dies at generation 1
// on its first unlucky mutation. Four lets selection actually choose.
const BASE_FECUNDITY = 4;

async function main() {
  const [deployer] = await hre.ethers.getSigners();
  const network = hre.network.name;
  const balance = await hre.ethers.provider.getBalance(deployer.address);

  console.log("network:  ", network);
  console.log("deployer: ", deployer.address);
  console.log("balance:  ", hre.ethers.formatEther(balance), "0G");

  if (balance === 0n) {
    throw new Error(
      "deployer has no balance; fund it before deploying to " + network
    );
  }

  const Germline = await hre.ethers.getContractFactory("Germline");
  const germline = await Germline.deploy(
    SURVIVAL_THRESHOLD,
    FECUNDITY_STEP,
    BASE_FECUNDITY
  );
  await germline.waitForDeployment();
  const address = await germline.getAddress();

  const tx = germline.deploymentTransaction();
  console.log("");
  console.log("Germline deployed");
  console.log("  address:  ", address);
  console.log("  tx:       ", tx.hash);
  console.log("  threshold:", SURVIVAL_THRESHOLD, "bps");
  console.log("  step:     ", FECUNDITY_STEP, "bps per child");
  console.log("  base:     ", BASE_FECUNDITY, "offspring when viable");
  if (network === "zerog") {
    console.log("  explorer: https://chainscan.0g.ai/address/" + address);
  }

  const dir = path.join(__dirname, "..", "deployments");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, network + ".json"),
    JSON.stringify(
      {
        network,
        chainId: Number((await hre.ethers.provider.getNetwork()).chainId),
        address,
        deployTx: tx.hash,
        deployer: deployer.address,
        survivalThreshold: SURVIVAL_THRESHOLD,
        fecundityStep: FECUNDITY_STEP,
        baseFecundity: BASE_FECUNDITY,
        deployedAt: new Date().toISOString(),
      },
      null,
      2
    ) + "\n"
  );
  console.log("  recorded: deployments/" + network + ".json");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
