"use strict";

// One honest reproduction.
//
// The whole point of the two-step commitment is that the breeder does not
// choose the mutation. This script therefore has no discretion anywhere in
// it: it commits, waits for the block the chain picked, reads the seed that
// block produced, and derives the only child that seed allows. If the result
// is worse than its parent, that child is still what gets recorded -- hiding
// it would be exactly the grinding the commit-reveal exists to prevent, and
// the lineage is only worth something because the bad rolls are in it too.
//
// Run:  npx hardhat run scripts/breed.js --network zerog
//       PARENT_ID=3 npx hardhat run scripts/breed.js --network zerog

const hre = require("hardhat");
const { canonical, genomeRoot, phenotype } = require("../engine/genome");
const { mutate } = require("../engine/mutate");
const { evaluate } = require("../engine/fitness");
const genomes = require("../lib/genomes");
const publisher = require("../lib/publish");
const census = require("../lib/census");
const {
  loadDeployment,
  assertChainMatches,
  txLink,
  eventFrom,
  revertName,
  sleep,
} = require("../lib/chain");

// Blocks on 0G come every couple of seconds, so a two second poll costs one
// extra round trip at worst. Forty attempts is over a minute of patience,
// which is generous for a chain that is running and quick to give up on one
// that is not.
function pollDelay() {
  return Number(process.env.GERMLINE_POLL_MS || 2000);
}

function pollTries() {
  return Number(process.env.GERMLINE_SEED_TRIES || 40);
}

// mutationSeedFor reverts with TooEarly until the block the commitment named
// has been mined, because until then its hash does not exist. That is the
// mechanism working, not a failure, so it is polled rather than reported.
async function waitForSeed(germline, parentId, provider, log) {
  const tries = pollTries();
  for (let attempt = 1; attempt <= tries; attempt++) {
    try {
      return await germline.mutationSeedFor(parentId);
    } catch (error) {
      const name = revertName(error);
      if (name === "RequestExpired") {
        throw new Error(
          "the commitment expired before its block could be read. The chain " +
            "moved more than 250 blocks between the request and now; re-run " +
            "this script to make a fresh commitment."
        );
      }
      if (name !== "TooEarly") throw error;
      const height = await provider.getBlockNumber();
      log(
        "  waiting for the seeding block (attempt " +
          attempt +
          " of " +
          tries +
          ", height " +
          height +
          ")"
      );
      await sleep(pollDelay());
    }
  }
  throw new Error(
    "the seeding block was still unmined after " +
      tries +
      " attempts, so the chain is stalled or the RPC is behind. The " +
      "commitment stays usable for 250 blocks: re-run this script once the " +
      "network is moving again."
  );
}

async function breed(options = {}) {
  const log = options.log || console.log;
  const network = hre.network.name;
  const record = loadDeployment(hre);
  await assertChainMatches(hre, record);

  const provider = hre.ethers.provider;
  const [signer] = await hre.ethers.getSigners();
  const germline = await hre.ethers.getContractAt(
    "Germline",
    record.address,
    signer
  );

  const rows = await census.readPopulation(germline);
  if (rows.length === 0) {
    throw new Error(
      "the population is empty. Found the first organism:  npx hardhat run " +
        "scripts/found.js --network " +
        network
    );
  }

  // Default to the fittest organism this key stewards that still has
  // offspring left, which is where an attempt is most likely to pay.
  const requested = options.parentId || process.env.PARENT_ID;
  let parent;
  if (requested) {
    const id = Number(requested);
    if (!Number.isInteger(id) || id < 1) {
      throw new Error("PARENT_ID must be a positive integer, got: " + requested);
    }
    parent = rows.find((row) => row.id === id);
    if (!parent) {
      throw new Error(
        "organism " + id + " does not exist; the population is " + rows.length
      );
    }
  } else {
    parent = census.fittestBreeder(rows, signer.address);
    if (!parent) {
      throw new Error(
        "no organism this key stewards has offspring left to spend. Either " +
          "attest fitness for one that has not been measured, or breed from " +
          "a fitter line."
      );
    }
  }

  if (parent.steward.toLowerCase() !== signer.address.toLowerCase()) {
    throw new Error(
      "organism " +
        parent.id +
        " is stewarded by " +
        parent.steward +
        ", not by " +
        signer.address +
        ". Only the steward may breed from it."
    );
  }
  if (parent.remaining === 0) {
    throw new Error(
      "organism " +
        parent.id +
        " has no offspring left: it scored " +
        parent.score +
        " bps and has used " +
        parent.offspring +
        " of the " +
        parent.allowance +
        " children that score earns. " +
        (parent.allowance === 0
          ? "It is below the survival threshold, so its line ends here."
          : "Breed from a fitter organism.")
    );
  }

  // The parent configuration has to come from somewhere the chain can be
  // checked against. The cache is content addressed, so a file that has been
  // tampered with cannot masquerade as the parent.
  const parentGenome = genomes.get(parent.genomeRoot);

  log("network:   " + network);
  log("contract:  " + record.address);
  log("parent:    organism " + parent.id + "  " + phenotype(parentGenome));
  log(
    "           " +
      parent.score +
      " bps, generation " +
      parent.generation +
      ", " +
      parent.remaining +
      " of " +
      parent.allowance +
      " offspring left"
  );
  log("");

  // The ordinal that goes into the seed is the parent's offspring count at
  // the moment of the reveal. Remember what it was at the commitment so a
  // spawn that raced another can be spotted afterwards.
  const ordinalAtRequest = parent.offspring;

  const requestTx = await germline.requestSpawn(parent.id);
  const requestReceipt = await requestTx.wait();
  log("requestSpawn");
  log("  request block:  " + requestReceipt.blockNumber);
  log("  tx:             " + requestReceipt.hash);
  const requestLink = txLink(network, requestReceipt.hash);
  if (requestLink) log("  explorer:       " + requestLink);
  log(
    "  the seed is keccak(parent root, blockhash(" +
      requestReceipt.blockNumber +
      "), parent id, ordinal), and that hash does not exist yet"
  );

  const seed = await waitForSeed(germline, parent.id, provider, log);
  log("  seed:           " + seed);
  log("");

  const childGenome = mutate(parentGenome, seed);
  const childRoot = genomeRoot(childGenome);
  log("derived child");
  log("  phenotype:      " + phenotype(childGenome));
  log("  genome root:    " + childRoot);

  // A mutation that lands on a genome already born cannot be minted; the
  // contract enforces that with genomeSeen. This is a real outcome of
  // descent rather than a bug, so name it for what it is.
  if (await germline.genomeSeen(childRoot)) {
    throw new Error(
      "stillborn: the seed produced " +
        childRoot +
        ", a genome that already exists in this population. The commitment " +
        "is spent; re-run this script and the next block will fix a " +
        "different seed."
    );
  }

  const spawnTx = await germline.spawn(parent.id, childRoot);
  const spawnReceipt = await spawnTx.wait();
  const spawned = eventFrom(germline, spawnReceipt, "Spawned");
  const childId = Number(spawned.id);
  log("  organism id:    " + childId);
  log("  tx:             " + spawnReceipt.hash);
  const spawnLink = txLink(network, spawnReceipt.hash);
  if (spawnLink) log("  explorer:       " + spawnLink);
  log("");

  // The seed depends on the parent's offspring count, so another spawn
  // landing between the read and the reveal would change it, and the child
  // just minted would not be the child this seed derives. That is precisely
  // the condition verify.js calls a forgery, so it must be caught here and
  // shouted about rather than left for someone else to find.
  const recordedSeed = spawned.mutationSeed;
  const seedHeld = recordedSeed.toLowerCase() === seed.toLowerCase();
  if (!seedHeld) {
    throw new Error(
      "the chain recorded seed " +
        recordedSeed +
        " but this child was derived under " +
        seed +
        " (ordinal was " +
        ordinalAtRequest +
        " at the commitment). Another reproduction from the same parent " +
        "raced this one. Organism " +
        childId +
        " will not verify and should be treated as void."
    );
  }

  const cached = genomes.put(childGenome);
  const measured = evaluate(childGenome);
  const result = measured.transcript.result;

  const genomePublished = await publisher.publish({
    kind: "genome",
    name: "organism-" + childId,
    root: childRoot,
    bytes: canonical(childGenome),
  });
  const transcriptPublished = await publisher.publish({
    kind: "transcript",
    name: "organism-" + childId + "-trial",
    root: measured.evidenceRoot,
    bytes: JSON.stringify(measured.transcript),
  });

  log("evidence");
  log("  cached:         " + cached.path);
  log("  genome:         " + publisher.describe(genomePublished));
  log("  transcript:     " + publisher.describe(transcriptPublished));
  log("");

  const attestTx = await germline.attestFitness(
    childId,
    measured.fitnessBps,
    measured.trialId,
    measured.evidenceRoot
  );
  const attestReceipt = await attestTx.wait();
  log("attestFitness");
  log("  score:          " + measured.fitnessBps + " bps");
  log(
    "  coverage:       " +
      result.coverage +
      "   accuracy when answering " +
      result.accuracyWhenAnswering
  );
  log("  tx:             " + attestReceipt.hash);
  const attestLink = txLink(network, attestReceipt.hash);
  if (attestLink) log("  explorer:       " + attestLink);

  const delta = measured.fitnessBps - parent.score;
  const allowance = Number(await germline.spawnAllowance(childId));
  log("");
  log(
    "organism " +
      parent.id +
      " -> organism " +
      childId +
      "   " +
      (delta >= 0 ? "+" : "") +
      delta +
      " bps"
  );
  log(
    "  " +
      phenotype(parentGenome) +
      "  (" +
      parent.score +
      ")  ->  " +
      phenotype(childGenome) +
      "  (" +
      measured.fitnessBps +
      ")"
  );
  log(
    "  " +
      (allowance === 0
        ? "below the survival threshold: this line ends here"
        : "earned " + allowance + " offspring of its own")
  );
  log("");
  log(
    "verify it:  CHILD_ID=" +
      childId +
      " npx hardhat run scripts/verify.js --network " +
      network
  );

  return {
    parentId: parent.id,
    childId,
    seed,
    recordedSeed,
    childRoot,
    parentRoot: parent.genomeRoot,
    phenotype: phenotype(childGenome),
    parentPhenotype: phenotype(parentGenome),
    fitnessBps: measured.fitnessBps,
    parentFitnessBps: parent.score,
    delta,
    allowance,
    trialId: measured.trialId,
    evidenceRoot: measured.evidenceRoot,
    requestBlock: requestReceipt.blockNumber,
    requestTx: requestReceipt.hash,
    spawnTx: spawnReceipt.hash,
    attestTx: attestReceipt.hash,
    storage: {
      genome: genomePublished,
      transcript: transcriptPublished,
      cachedAt: cached.path,
    },
  };
}

if (require.main === module) {
  breed().catch((error) => {
    console.error(error.message || error);
    process.exitCode = 1;
  });
}

module.exports = { breed };
