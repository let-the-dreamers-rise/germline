"use strict";

// Check that an organism really is the child it claims to be.
//
// This is the heart of the demo, and the whole argument in executable form.
// Nothing here trusts the breeder, an indexer, or a web page: it reads the
// lineage from the chain, recovers the parent configuration, re-runs the
// mutation the chain itself seeded, and compares. A forged child fails
// arithmetic, not an audit.
//
//     npx hardhat run scripts/verify.js --network zerog
//
// With no CHILD_ID it checks the newest organism that has a parent, which is
// what a demo wants and what a shell-neutral command requires -- VAR=value
// prefixes are bash-only and fail on PowerShell and cmd. Set CHILD_ID to
// check a specific one:
//
//     $env:CHILD_ID=7; npx hardhat run scripts/verify.js --network zerog   (PowerShell)
//     CHILD_ID=7 npx hardhat run scripts/verify.js --network zerog         (bash)
//
// CONTRACT overrides the address in deployments/<network>.json, for checking
// a lineage this working copy did not deploy. Exits non-zero if the child's
// heredity, attested score, or attested evidence root fails to reproduce.

const hre = require("hardhat");

const { genomeRoot, phenotype, canonical } = require("../engine/genome");
const { mutate } = require("../engine/mutate");
const { evaluate } = require("../engine/fitness");
const { genomeForRoot } = require("../engine/space");
const genomes = require("../lib/genomes");
const { loadDeployment, assertChainMatches } = require("../lib/chain");

// Recover the ordinal this child was born under -- the number of siblings the
// parent had already produced -- and the block it was born in. The contract
// folds the ordinal into the seed and then keeps only the running total, so
// the count has to come back out of the log.
async function birthOf(germline, parentId, childId) {
  const events = await germline.queryFilter(
    germline.filters.Spawned(null, parentId)
  );
  const ordered = events.sort(
    (a, b) => a.blockNumber - b.blockNumber || a.index - b.index
  );
  const position = ordered.findIndex((e) => e.args.id === BigInt(childId));
  if (position < 0) {
    throw new Error("no Spawned event links " + childId + " to " + parentId);
  }
  return { ordinal: position, spawnBlock: ordered[position].blockNumber };
}

// The contract stores only a root. Recovering the configuration behind it
// first tries the enumerated gene space -- every genome mutation can reach,
// which is small enough to search directly and needs no file from anyone --
// and only falls back to the local content-addressed cache, which is what
// found.js and breed.js populate as they go.
function resolveGenome(root, log) {
  const fromSpace = genomeForRoot(root);
  if (fromSpace) return fromSpace;
  if (genomes.has(root)) {
    log("  (root not in the enumerated gene space; using the local cache)");
    return genomes.get(root);
  }
  return null;
}

async function resolveContract(hre) {
  if (process.env.CONTRACT) return { address: process.env.CONTRACT };
  const record = loadDeployment(hre);
  await assertChainMatches(hre, record);
  return { address: record.address };
}

/// Verify one organism's lineage and attestation. Throws on any mismatch, so
/// a caller that wants a non-zero exit code needs to do nothing further.
async function verify(options = {}) {
  const log = options.log || console.log;
  const { address } = await resolveContract(hre);
  const germline = await hre.ethers.getContractAt("Germline", address);

  let childId =
    options.childId != null ? String(options.childId) : process.env.CHILD_ID;
  if (!childId) {
    // Default to the newest organism that descends from something. A founder
    // has no heredity to verify, so walk back past any that sit on top.
    const population = Number(await germline.population());
    for (let id = population; id >= 1; id--) {
      const organism = await germline.organismOf(id);
      if (Number(organism.parent) !== 0) {
        childId = String(id);
        break;
      }
    }
    if (!childId) {
      throw new Error(
        "no organism has a parent yet; run scripts/breed.js first, or set CHILD_ID"
      );
    }
    log("CHILD_ID not set; checking the newest bred organism, #" + childId);
    log("");
  }

  const child = await germline.organismOf(childId);
  if (child.parent === 0n) {
    throw new Error(
      "organism " +
        childId +
        " is a founder; it has no parent and nothing to derive from"
    );
  }
  const parent = await germline.organismOf(child.parent);

  log("contract         " + address);
  log("child            " + childId + "  generation " + Number(child.generation));
  log("parent           " + child.parent.toString());
  log("");

  // A root the gene set cannot produce, and that is not in the local cache
  // either, means the genome cannot be recovered at all -- every check below
  // would be meaningless. Stop rather than guess.
  const parentGenome = resolveGenome(parent.genomeRoot, log);
  if (!parentGenome) {
    throw new Error(
      "parent root " +
        parent.genomeRoot +
        " resolves to no genome: not in the enumerated gene space and not " +
        "in the local cache (" +
        genomes.dir() +
        ")"
    );
  }
  log("parent genome    " + phenotype(parentGenome));
  log("  root           " + parent.genomeRoot);
  log("  canonical      " + canonical(parentGenome));
  log("");

  const mismatches = [];

  // 1. Heredity. The recorded seed and the parent must produce exactly the
  // child the chain minted.
  const derived = mutate(parentGenome, child.mutationSeed);
  const derivedRoot = genomeRoot(derived);
  const heredityHolds = derivedRoot === child.genomeRoot;
  if (!heredityHolds) mismatches.push("heredity");

  log("mutation seed    " + child.mutationSeed);
  log("derived child    " + phenotype(derived));
  log("  derived root   " + derivedRoot);
  log("  on-chain root  " + child.genomeRoot);
  log("  heredity       " + (heredityHolds ? "VERIFIED" : "FORGED"));
  log("");

  // 2. The seed itself. Re-derive it from the block hash the chain committed
  // to, so the seed is not merely trusted as recorded. This is best effort:
  // block hashes and logs age out on a live chain, and that is a limit of
  // what a node will serve, not evidence against the lineage.
  let seedCheck = null;
  try {
    const birth = await birthOf(germline, child.parent, childId);
    const ordinal = birth.ordinal;
    const requests = await germline.queryFilter(
      germline.filters.SpawnRequested(child.parent)
    );
    // The commitment this birth consumed is the parent's latest request made
    // before the child was minted; earlier ones were spent by its siblings.
    const request = requests
      .filter((e) => Number(e.args.requestBlock) < birth.spawnBlock)
      .sort((a, b) => Number(b.args.requestBlock) - Number(a.args.requestBlock))[0];
    if (!request) throw new Error("no SpawnRequested event precedes this birth");

    const requestBlock = Number(request.args.requestBlock);
    const block = await hre.ethers.provider.getBlock(requestBlock);
    if (!block) throw new Error("block " + requestBlock + " is no longer served");

    const seed = hre.ethers.solidityPackedKeccak256(
      ["bytes32", "bytes32", "uint256", "uint32"],
      [parent.genomeRoot, block.hash, child.parent, ordinal]
    );
    const seedHolds = seed === child.mutationSeed;
    log("seed derivation");
    log("  request block  " + requestBlock);
    log("  blockhash      " + block.hash);
    log("  ordinal        " + ordinal);
    log("  recomputed     " + seed);
    log("  seed           " + (seedHolds ? "VERIFIED" : "MISMATCH"));
    seedCheck = { requestBlock, ordinal, recomputed: seed, holds: seedHolds };
    // A seed that fails to re-derive from the block the contract itself
    // named is not a forged reveal -- childGenomeRoot is the only field a
    // breeder controls -- it would mean the recorded mutationSeed disagrees
    // with the contract's own formula, which is a deeper fault worth
    // surfacing the same way.
    if (!seedHolds) mismatches.push("seed derivation");
  } catch (error) {
    log("seed derivation  not re-derivable: " + error.message);
  }
  log("");

  // 3. The attested score. Re-measure the child and compare with what the
  // chain was told, so a flattering attestation is as visible as a forged
  // genome.
  const fitness = await germline.fitnessOf(childId);
  let fitnessCheck = null;
  if (fitness.attestedAt === 0n) {
    log("fitness          not attested");
  } else {
    // Score the genome the chain records, not the one derived above. Where
    // those two differ the lineage is already forged, and measuring the
    // derivation instead would quietly hide it.
    const onChainGenome = resolveGenome(child.genomeRoot, log);
    if (!onChainGenome) {
      log("fitness          not checkable: the child root resolves to no genome");
    } else {
      const measured = evaluate(onChainGenome);
      const scoreHolds = BigInt(measured.fitnessBps) === fitness.score;
      const evidenceHolds = measured.evidenceRoot === fitness.evidenceRoot;
      const sameTrial = fitness.trialId === measured.trialId;
      log("attested score   " + fitness.score.toString() + " bps");
      log("re-measured      " + measured.fitnessBps + " bps");
      log("  score          " + (scoreHolds ? "VERIFIED" : "MISMATCH"));
      log("  trial          " + (sameTrial ? "same corpus" : "DIFFERENT CORPUS"));
      log("  evidence root  " + (evidenceHolds ? "VERIFIED" : "MISMATCH"));
      fitnessCheck = {
        attestedScore: Number(fitness.score),
        measuredScore: measured.fitnessBps,
        scoreHolds,
        evidenceHolds,
        sameTrial,
      };
      if (!scoreHolds) mismatches.push("fitness score");
      if (!evidenceHolds) mismatches.push("evidence root");
    }
  }
  log("");

  const genuine = mismatches.length === 0;
  log(genuine ? "VERDICT: GENUINE" : "VERDICT: FORGED");
  if (genuine) {
    log(
      "organism " +
        childId +
        " descends from " +
        child.parent.toString() +
        " exactly as recorded, and its attested fitness reproduces."
    );
  } else {
    log(
      "organism " +
        childId +
        " does not check out -- " +
        mismatches.join(", ") +
        " failed to reproduce."
    );
  }

  const result = {
    childId: Number(childId),
    parentId: Number(child.parent),
    genuine,
    mismatches,
    heredity: { holds: heredityHolds, derivedRoot, onChainRoot: child.genomeRoot },
    seed: seedCheck,
    fitness: fitnessCheck,
  };

  if (!genuine) {
    const error = new Error(
      "organism " + childId + " failed verification: " + mismatches.join(", ")
    );
    error.result = result;
    throw error;
  }
  return result;
}

if (require.main === module) {
  verify().catch((error) => {
    console.error(error.message || error);
    process.exitCode = 1;
  });
}

module.exports = { verify };
