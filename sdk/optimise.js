"use strict";

// The selection loop, generalised.
//
// engine/evolve.js runs exactly this algorithm for one hardcoded genome. The
// only thing that changes when a product supplies its own trial is where the
// mutation seed comes from: a local run makes one up (sdk/seed.js's
// localSeed, in the same "simulated:" form engine/evolve.js uses), a chain
// run takes what a block hash actually decided. Selection itself --
// spawnAllowance, who gets to breed, what counts as a dead end -- is the same
// arithmetic either way, and is imported from engine/evolve.js rather than
// re-implemented, so a local run and an on-chain run can never quietly
// disagree about who earned a child.
//
// Provenance is optional by design. Pass a trial and nothing else and this
// runs entirely in memory: no wallet, no RPC, no cost. Pass a `chain` option
// -- a contract connected to a signer -- and the same run commits, reveals
// and attests on 0G as it goes, so a team can validate the search locally
// first and turn provenance on later without changing how they call this.

const { spawnAllowance } = require("../engine/evolve");
const { localSeed } = require("./seed");
const { waitForSeed, eventFrom } = require("./chain");

function assertTrial(trial) {
  if (
    !trial ||
    typeof trial.mutate !== "function" ||
    typeof trial.evaluate !== "function" ||
    typeof trial.root !== "function" ||
    typeof trial.label !== "function"
  ) {
    throw new Error("optimise() needs a trial created with defineTrial()");
  }
}

function normaliseGenerations(value) {
  const generations = value === undefined ? 10 : value;
  if (!Number.isInteger(generations) || generations < 1) {
    throw new Error("optimise(): generations must be a positive integer");
  }
  return generations;
}

function normaliseBps(value, name) {
  if (value === undefined) return undefined;
  const n = typeof value === "bigint" ? Number(value) : value;
  if (!Number.isInteger(n) || n < 0) {
    throw new Error("optimise(): " + name + " must be a non-negative integer of basis points");
  }
  return n;
}

// --- on-chain provenance ----------------------------------------------

async function connectChain(opts) {
  if (!opts || !opts.contract) {
    throw new Error("optimise(): chain.contract is required to record provenance on chain");
  }
  const signer = opts.signer || opts.contract.runner;
  if (!signer || typeof signer.getAddress !== "function") {
    throw new Error(
      "optimise(): chain.signer is required, or chain.contract must already be connected to one"
    );
  }
  const contract = opts.signer ? opts.contract.connect(opts.signer) : opts.contract;
  const address = typeof contract.getAddress === "function" ? await contract.getAddress() : null;
  return {
    contract,
    signer,
    address,
    steward: opts.steward,
    pollMs: opts.pollMs === undefined ? 2000 : opts.pollMs,
    pollTries: opts.pollTries === undefined ? 40 : opts.pollTries,
  };
}

// Attest only when the chain does not already carry this exact measurement.
// Re-attesting an identical score costs gas and rewrites the timestamp for
// no gain, and a failed evaluation has no evidence root to attest at all.
async function attestIfNeeded(chain, id, measured, log) {
  if (!measured.ok || !measured.evidenceRoot) return false;
  const onChain = await chain.contract.fitnessOf(id);
  const already =
    Number(onChain.score) === measured.fitnessBps &&
    String(onChain.evidenceRoot).toLowerCase() === String(measured.evidenceRoot).toLowerCase();
  if (already) return false;
  const tx = await chain.contract.attestFitness(
    id,
    measured.fitnessBps,
    measured.trialId,
    measured.evidenceRoot
  );
  const receipt = await tx.wait();
  if (log) {
    log("  attestFitness organism " + id + " -> " + measured.fitnessBps + " bps (tx " + receipt.hash + ")");
  }
  return true;
}

// Seed the trial's own configuration as generation zero, or find the
// organism that already carries it. Reproduction is enforced by the
// contract, not by this library, so an unfit or unmeasured seed simply earns
// no descendants once attested -- the same as it would locally.
async function foundOnChain(trial, chain, seedConfig, seedRoot, seedMeasured, log) {
  const alreadySeeded = await chain.contract.genomeSeen(seedRoot);
  let id;
  if (alreadySeeded) {
    const count = Number(await chain.contract.population());
    for (let i = 1; i <= count; i++) {
      const organism = await chain.contract.organismOf(i);
      if (String(organism.genomeRoot).toLowerCase() === seedRoot.toLowerCase()) {
        id = i;
        break;
      }
    }
    if (id === undefined) {
      throw new Error(
        "optimise(): the trial's seed configuration (" +
          seedRoot +
          ") is already claimed on chain but matches no organism this contract will admit to"
      );
    }
    if (log) log("trial seed already founded as organism " + id);
  } else {
    const curator = await chain.contract.curator();
    const signerAddress = await chain.signer.getAddress();
    if (String(curator).toLowerCase() !== signerAddress.toLowerCase()) {
      throw new Error(
        "optimise(): seedFounder is curator-only. The curator is " +
          curator +
          " but the connected signer is " +
          signerAddress +
          ". Either found the trial's seed configuration yourself and pass " +
          "chain.parentId, or connect the curator's key."
      );
    }
    const steward = chain.steward || signerAddress;
    const tx = await chain.contract.seedFounder(seedRoot, steward);
    const receipt = await tx.wait();
    const args = eventFrom(chain.contract, receipt, "Founded");
    id = Number(args.id);
    if (log) log("seedFounder -> organism " + id + " (tx " + receipt.hash + ")");
  }
  await attestIfNeeded(chain, id, seedMeasured, log);
  return id;
}

// The commit half of one honest reproduction: request the spawn and wait
// for the block the chain picked to be mined, so the seed exists. Returns
// the seed together with a reveal() closure that mints the child once the
// caller has derived it -- mirrors scripts/breed.js exactly, generalised to
// whatever trial is running.
async function commitAndWaitSeed(chain, parentOnChainId, log) {
  const requestTx = await chain.contract.requestSpawn(parentOnChainId);
  const requestReceipt = await requestTx.wait();
  if (log) {
    log(
      "  requestSpawn organism " + parentOnChainId + " (tx " + requestReceipt.hash + ")"
    );
  }

  const seedHex = await waitForSeed(chain.contract, parentOnChainId, {
    pollMs: chain.pollMs,
    pollTries: chain.pollTries,
    log,
  });

  return { seedHex, reveal: async (root) => {
    if (await chain.contract.genomeSeen(root)) {
      return { stillborn: true, seedHex };
    }
    const spawnTx = await chain.contract.spawn(parentOnChainId, root);
    const spawnReceipt = await spawnTx.wait();
    const args = eventFrom(chain.contract, spawnReceipt, "Spawned");
    const id = Number(args.id);
    if (log) log("  spawn -> organism " + id + " (tx " + spawnReceipt.hash + ")");
    return { stillborn: false, seedHex, id };
  } };
}

// --- the loop itself -----------------------------------------------------

/// Run selection over a trial. Returns the population it reached, the
/// generation-by-generation history, and the fittest configuration found.
///
/// Local by default: no option beyond `trial` is required, and nothing here
/// touches a network. Pass `chain: { contract, signer }` -- an ethers
/// Contract for Germline.sol, connected to a signer that can send
/// transactions -- to record the same lineage on 0G as it is bred, using the
/// mutation seed the chain actually produced instead of a locally-made one.
async function optimise(trial, options = {}) {
  assertTrial(trial);
  const generations = normaliseGenerations(options.generations);
  const salt = options.salt === undefined ? trial.name : String(options.salt);
  const context = options.context;
  const log = typeof options.log === "function" ? options.log : null;
  const onGeneration = typeof options.onGeneration === "function" ? options.onGeneration : null;

  const seedConfig = trial.seed;
  const seedRoot = trial.root(seedConfig);
  const founderMeasured = await trial.evaluate(seedConfig, context);

  let chain = null;
  let survivalThreshold = normaliseBps(options.survivalThreshold, "survivalThreshold");
  let fecundityStep = normaliseBps(options.fecundityStep, "fecundityStep");
  let baseFecundity = options.baseFecundity;

  if (options.chain) {
    chain = await connectChain(options.chain);
    // Once provenance is on, the deployed contract is the only place
    // spawnAllowance can legally be decided -- mirroring different numbers
    // locally would let this loop grant a child the contract would refuse
    // to mint. So the chain's own immutables win over any local override.
    const [chainThreshold, chainStep, chainBase] = await Promise.all([
      chain.contract.survivalThreshold(),
      chain.contract.fecundityStep(),
      chain.contract.baseFecundity(),
    ]);
    survivalThreshold = Number(chainThreshold);
    fecundityStep = Number(chainStep);
    baseFecundity = Number(chainBase);
  } else {
    // With no chain to enforce a threshold, the natural one is the trial's
    // own baseline: a configuration must beat what the trial already does
    // by default before it is allowed to have descendants, exactly as the
    // ARC deployment's threshold is the founder's own measured score.
    if (survivalThreshold === undefined) survivalThreshold = founderMeasured.fitnessBps;
    if (fecundityStep === undefined) fecundityStep = 500;
    if (baseFecundity === undefined) baseFecundity = 4;
  }
  if (!Number.isInteger(baseFecundity) || baseFecundity < 1) {
    throw new Error("optimise(): baseFecundity must be a positive integer");
  }
  if (!Number.isInteger(fecundityStep) || fecundityStep < 1) {
    throw new Error("optimise(): fecundityStep must be a positive integer");
  }

  let founderOnChainId = null;
  if (chain) {
    founderOnChainId = await foundOnChain(trial, chain, seedConfig, seedRoot, founderMeasured, log);
  }

  const population = [
    {
      id: 1,
      onChainId: founderOnChainId,
      parent: 0,
      generation: 0,
      config: seedConfig,
      root: seedRoot,
      label: trial.label(seedConfig),
      fitnessBps: founderMeasured.fitnessBps,
      ok: founderMeasured.ok,
      error: founderMeasured.error,
      evidence: founderMeasured.evidence,
      offspring: 0,
    },
  ];

  const history = [];
  let nextId = 2;

  const allowanceOf = (o) =>
    spawnAllowance(o.fitnessBps, survivalThreshold, fecundityStep, baseFecundity);

  for (let gen = 1; gen <= generations; gen++) {
    // A generation is one round of breeding across everyone still able to.
    // Fittest first, so a scarce budget is spent where it pays.
    const breeders = population
      .filter((o) => o.offspring < allowanceOf(o))
      .sort((a, b) => b.fitnessBps - a.fitnessBps);
    if (breeders.length === 0) break;

    const genRecords = [];

    for (const parent of breeders) {
      const ordinal = parent.offspring;
      parent.offspring += 1;

      let seedHex;
      let reveal = null;
      if (chain) {
        const commitment = await commitAndWaitSeed(chain, parent.onChainId, log);
        seedHex = commitment.seedHex;
        reveal = commitment.reveal;
      } else {
        seedHex = localSeed(parent.root, ordinal, salt + gen);
      }

      const childConfig = trial.mutate(parent.config, seedHex);
      const childRoot = trial.root(childConfig);

      // A configuration already in the population cannot be born again; the
      // contract enforces the same rule with genomeSeen, and reveal() checks
      // it again on chain right before minting.
      let onChainId = null;
      if (population.some((o) => o.root === childRoot)) {
        const record = {
          generation: gen,
          parent: parent.id,
          outcome: "stillborn",
          reason: "configuration already exists",
        };
        history.push(record);
        genRecords.push(record);
        continue;
      }

      if (chain) {
        const revealed = await reveal(childRoot);
        if (revealed.stillborn) {
          const record = {
            generation: gen,
            parent: parent.id,
            outcome: "stillborn",
            reason: "configuration already exists on chain",
          };
          history.push(record);
          genRecords.push(record);
          continue;
        }
        onChainId = revealed.id;
      }

      const measured = await trial.evaluate(childConfig, context);
      if (chain) await attestIfNeeded(chain, onChainId, measured, log);

      const child = {
        id: nextId++,
        onChainId,
        parent: parent.id,
        generation: parent.generation + 1,
        config: childConfig,
        root: childRoot,
        label: trial.label(childConfig),
        fitnessBps: measured.fitnessBps,
        ok: measured.ok,
        error: measured.error,
        evidence: measured.evidence,
        offspring: 0,
      };
      population.push(child);

      const record = {
        generation: gen,
        parent: parent.id,
        child: child.id,
        onChainId,
        label: child.label,
        fitnessBps: child.fitnessBps,
        delta: child.fitnessBps - parent.fitnessBps,
        allowance: allowanceOf(child),
        outcome: child.fitnessBps >= survivalThreshold ? "viable" : "dead end",
        error: child.error,
      };
      history.push(record);
      genRecords.push(record);
    }

    if (log) {
      for (const r of genRecords) {
        if (r.outcome === "stillborn") {
          log("gen " + gen + ": organism " + r.parent + " -> stillborn (" + r.reason + ")");
        } else {
          log(
            "gen " +
              gen +
              ": " +
              r.parent +
              " -> " +
              r.child +
              "  " +
              r.label +
              "  " +
              r.fitnessBps +
              " bps (" +
              (r.delta >= 0 ? "+" : "") +
              r.delta +
              ")" +
              (r.error ? "  [evaluate() failed: " + r.error + "]" : "")
          );
        }
      }
    }
    if (onGeneration) onGeneration(gen, genRecords, population);
  }

  const best = population.reduce((a, b) => (b.fitnessBps > a.fitnessBps ? b : a));

  return {
    trial: trial.name,
    generations,
    survivalThreshold,
    fecundityStep,
    baseFecundity,
    chain: chain ? { address: chain.address, founderId: founderOnChainId } : null,
    population,
    history,
    best,
    founder: population[0],
  };
}

module.exports = { optimise };
