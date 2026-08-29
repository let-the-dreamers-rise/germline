"use strict";

// The selection loop, kept deliberately separate from the chain so the same
// code drives both a local simulation and a real on-chain lineage. The only
// difference between them is where the mutation seed comes from: a local run
// makes one up, a real one takes what the block hash decided.

const { keccak256, toUtf8Bytes } = require("ethers");
const { FOUNDER, genomeRoot, phenotype } = require("./genome");
const { mutate } = require("./mutate");
const { evaluate } = require("./fitness");

// Mirrors Germline.spawnAllowance. Kept in step with the contract by the
// test in test/engine.test.js, which checks the two agree.
function spawnAllowance(
  fitnessBps,
  survivalThreshold,
  fecundityStep,
  baseFecundity
) {
  if (fitnessBps < survivalThreshold) return 0;
  return (
    baseFecundity + Math.floor((fitnessBps - survivalThreshold) / fecundityStep)
  );
}

// A stand-in for blockhash, for simulations that never touch a chain. Named
// so nobody mistakes a simulated lineage for a real one.
function simulatedSeed(parentRoot, ordinal, salt) {
  return keccak256(
    toUtf8Bytes("simulated:" + parentRoot + ":" + ordinal + ":" + salt)
  );
}

/// Run a local evolutionary simulation and report the trajectory.
function simulate(options = {}) {
  const {
    generations = 12,
    survivalThreshold = 3148,
    fecundityStep = 500,
    baseFecundity = 4,
    salt = "germline",
  } = options;

  const founderEval = evaluate(FOUNDER);
  const population = [
    {
      id: 1,
      parent: 0,
      generation: 0,
      genome: FOUNDER,
      root: genomeRoot(FOUNDER),
      phenotype: phenotype(FOUNDER),
      fitnessBps: founderEval.fitnessBps,
      offspring: 0,
    },
  ];

  const history = [];
  let nextId = 2;

  const allowanceOf = (o) =>
    spawnAllowance(
      o.fitnessBps,
      survivalThreshold,
      fecundityStep,
      baseFecundity
    );

  for (let gen = 1; gen <= generations; gen++) {
    // A generation is one round of breeding across everyone still able to.
    // Fittest first, so a scarce budget is spent where it pays.
    const breeders = population
      .filter((o) => o.offspring < allowanceOf(o))
      .sort((a, b) => b.fitnessBps - a.fitnessBps);
    if (breeders.length === 0) break;

    for (const parent of breeders) {
      const seed = simulatedSeed(parent.root, parent.offspring, salt + gen);
      const childGenome = mutate(parent.genome, seed);
      const childRoot = genomeRoot(childGenome);
      parent.offspring += 1;

      // A genome already in the population cannot be born again; the
      // contract enforces the same rule with genomeSeen.
      if (population.some((o) => o.root === childRoot)) {
        history.push({
          generation: gen,
          parent: parent.id,
          outcome: "stillborn",
          reason: "genome already exists",
        });
        continue;
      }

      const scored = evaluate(childGenome);
      const child = {
        id: nextId++,
        parent: parent.id,
        generation: parent.generation + 1,
        genome: childGenome,
        root: childRoot,
        phenotype: phenotype(childGenome),
        fitnessBps: scored.fitnessBps,
        offspring: 0,
      };
      population.push(child);

      history.push({
        generation: gen,
        parent: parent.id,
        child: child.id,
        phenotype: child.phenotype,
        fitnessBps: child.fitnessBps,
        delta: child.fitnessBps - parent.fitnessBps,
        allowance: allowanceOf(child),
        outcome: child.fitnessBps >= survivalThreshold ? "viable" : "dead end",
      });
    }
  }

  const best = population.reduce((a, b) =>
    b.fitnessBps > a.fitnessBps ? b : a
  );
  return { population, history, best, founder: population[0] };
}

module.exports = { simulate, spawnAllowance, simulatedSeed };
