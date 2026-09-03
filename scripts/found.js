"use strict";

// Bring the founder to life.
//
// Generation zero is the action-only predictor: the genome that reads nothing
// about the world at all. That is deliberate. It is the floor the contract's
// survival threshold was measured from, so every organism born after it has
// to beat the agent that has no model whatsoever before it earns the right to
// leave descendants. Founding with an already-good configuration would hand
// the lineage its answer and make the search a formality.
//
// Run:  npx hardhat run scripts/found.js --network zerog

const hre = require("hardhat");
const { FOUNDER, canonical, genomeRoot, phenotype } = require("../engine/genome");
const { evaluate } = require("../engine/fitness");
const genomes = require("../lib/genomes");
const publisher = require("../lib/publish");
const census = require("../lib/census");
const {
  loadDeployment,
  assertChainMatches,
  addressLink,
  txLink,
  eventFrom,
} = require("../lib/chain");

async function found(options = {}) {
  const log = options.log || console.log;
  const network = hre.network.name;
  const record = loadDeployment(hre);
  await assertChainMatches(hre, record);

  const [signer] = await hre.ethers.getSigners();
  const germline = await hre.ethers.getContractAt(
    "Germline",
    record.address,
    signer
  );

  // Fail on the permissions before spending anything on gas. Both of these
  // are held by the deployer on a fresh deployment, so a mismatch means the
  // wrong key is in DEPLOYER_KEY and the operator should hear that plainly.
  const curator = await germline.curator();
  if (curator.toLowerCase() !== signer.address.toLowerCase()) {
    throw new Error(
      "seedFounder is curator-only. The curator is " +
        curator +
        " but DEPLOYER_KEY holds " +
        signer.address
    );
  }
  if (!(await germline.isAttestor(signer.address))) {
    throw new Error(
      "this key may not attest fitness. Grant it with setAttestor(" +
        signer.address +
        ", true) from the curator."
    );
  }

  log("network:   " + network);
  log("contract:  " + record.address);
  log("steward:   " + signer.address);
  log("");

  // Measure before touching the chain. An attestation without a transcript
  // behind it is an opinion, and the contract will not accept one.
  const measured = evaluate(FOUNDER);
  const root = genomeRoot(FOUNDER);
  const result = measured.transcript.result;

  log("the founder genome");
  log("  phenotype:      " + phenotype(FOUNDER));
  log("  fitness:        " + measured.fitnessBps + " bps");
  log(
    "  coverage:       " +
      result.coverage +
      "   accuracy when answering " +
      result.accuracyWhenAnswering
  );
  log("  genome root:    " + root);
  log("  evidence root:  " + measured.evidenceRoot);
  log("  trial:          " + measured.trialId);
  log("");

  const cached = genomes.put(FOUNDER);
  const genomePublished = await publisher.publish({
    kind: "genome",
    name: "founder",
    root,
    bytes: canonical(FOUNDER),
  });
  const transcriptPublished = await publisher.publish({
    kind: "transcript",
    name: "founder-trial",
    root: measured.evidenceRoot,
    bytes: JSON.stringify(measured.transcript),
  });

  log("evidence");
  log("  cached:         " + cached.path);
  log("  genome:         " + publisher.describe(genomePublished));
  log("  transcript:     " + publisher.describe(transcriptPublished));
  log("");

  // Founding twice would revert with GenomeAlreadyUsed, which tells an
  // operator nothing. Re-running this script should be safe on mainnet, so
  // recognise the organism that already carries this genome and carry on to
  // the attestation.
  let id;
  let foundTx = null;
  let alreadyFounded = false;

  if (await germline.genomeSeen(root)) {
    const rows = await census.readPopulation(germline);
    const existing = census.findByGenomeRoot(rows, root);
    if (!existing) {
      throw new Error(
        "the founder genome " +
          root +
          " is already claimed on chain but belongs to no organism this " +
          "contract will admit to. Refusing to guess."
      );
    }
    id = existing.id;
    alreadyFounded = true;
    log("already founded as organism " + id + "; nothing to mint");
  } else {
    const tx = await germline.seedFounder(root, signer.address);
    const receipt = await tx.wait();
    const args = eventFrom(germline, receipt, "Founded");
    id = Number(args.id);
    foundTx = receipt.hash;
    log("seedFounder");
    log("  organism id:    " + id);
    log("  tx:             " + receipt.hash);
    const link = txLink(network, receipt.hash);
    if (link) log("  explorer:       " + link);
  }
  log("");

  // Attest only when the chain does not already carry this exact measurement.
  // Re-attesting an identical score costs gas and rewrites the timestamp for
  // no gain.
  const onChain = await germline.fitnessOf(id);
  const alreadyAttested =
    Number(onChain.score) === measured.fitnessBps &&
    onChain.evidenceRoot.toLowerCase() === measured.evidenceRoot.toLowerCase() &&
    onChain.trialId.toLowerCase() === measured.trialId.toLowerCase();

  let attestTx = null;
  if (alreadyAttested) {
    log("attestFitness");
    log("  unchanged:      " + measured.fitnessBps + " bps already attested");
  } else {
    const tx = await germline.attestFitness(
      id,
      measured.fitnessBps,
      measured.trialId,
      measured.evidenceRoot
    );
    const receipt = await tx.wait();
    attestTx = receipt.hash;
    log("attestFitness");
    log("  score:          " + measured.fitnessBps + " bps");
    log("  tx:             " + receipt.hash);
    const link = txLink(network, receipt.hash);
    if (link) log("  explorer:       " + link);
  }

  const allowance = Number(await germline.spawnAllowance(id));
  log("");
  log("organism " + id + " is alive");
  log("  phenotype:      " + phenotype(FOUNDER));
  log("  fitness:        " + measured.fitnessBps + " bps");
  log("  offspring:      " + allowance + " earned");
  const contractLink = addressLink(network, record.address);
  if (contractLink) log("  contract:       " + contractLink);
  log("");
  log("next:  npx hardhat run scripts/breed.js --network " + network);

  return {
    id,
    genomeRoot: root,
    fitnessBps: measured.fitnessBps,
    phenotype: phenotype(FOUNDER),
    trialId: measured.trialId,
    evidenceRoot: measured.evidenceRoot,
    allowance,
    alreadyFounded,
    foundTx,
    attestTx,
    storage: {
      genome: genomePublished,
      transcript: transcriptPublished,
      cachedAt: cached.path,
    },
  };
}

if (require.main === module) {
  found().catch((error) => {
    console.error(error.message || error);
    process.exitCode = 1;
  });
}

module.exports = { found };
