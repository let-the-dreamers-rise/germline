"use strict";

// Reading the population back off the chain. Three of the four lifecycle
// scripts need the same view -- who exists, what they scored, and who is
// still allowed to breed -- so it is assembled once here.
//
// The phenotype is not on chain and never will be: the chain holds the root,
// and the readable name comes from the configuration behind it. Where the
// local cache does not hold that configuration the name is simply unknown,
// which is honest and is worth showing as such rather than inventing.

const { phenotype } = require("../engine/genome");
const genomes = require("./genomes");

async function readOrganism(germline, id) {
  const [organism, fitness, allowance, remaining] = await Promise.all([
    germline.organismOf(id),
    germline.fitnessOf(id),
    germline.spawnAllowance(id),
    germline.remainingOffspring(id),
  ]);

  let name = null;
  let cached = false;
  if (genomes.has(organism.genomeRoot)) {
    // A cached file that fails its own hash check is a real problem, but it
    // is not this function's problem to raise: a census should still print.
    try {
      name = phenotype(genomes.get(organism.genomeRoot));
      cached = true;
    } catch (error) {
      name = null;
    }
  }

  return {
    id: Number(id),
    parent: Number(organism.parent),
    generation: Number(organism.generation),
    offspring: Number(organism.offspring),
    bornAt: Number(organism.bornAt),
    genomeRoot: organism.genomeRoot,
    mutationSeed: organism.mutationSeed,
    steward: organism.steward,
    agenticId: Number(organism.agenticId),
    score: Number(fitness.score),
    attested: Number(fitness.attestedAt) > 0,
    trialId: fitness.trialId,
    evidenceRoot: fitness.evidenceRoot,
    attestor: fitness.attestor,
    allowance: Number(allowance),
    remaining: Number(remaining),
    phenotype: name,
    cachedLocally: cached,
  };
}

/// Every organism, in birth order.
async function readPopulation(germline) {
  const count = Number(await germline.population());
  const rows = [];
  for (let id = 1; id <= count; id++) {
    rows.push(await readOrganism(germline, id));
  }
  return rows;
}

/// The organism a breeder should use next: the fittest one it stewards that
/// still has offspring left. Fittest first because a scarce budget of
/// attempts is better spent where the ground is already high.
function fittestBreeder(rows, steward) {
  const wanted = steward ? steward.toLowerCase() : null;
  const eligible = rows.filter(
    (row) =>
      row.remaining > 0 &&
      (!wanted || row.steward.toLowerCase() === wanted)
  );
  if (eligible.length === 0) return null;
  eligible.sort((a, b) => b.score - a.score || a.id - b.id);
  return eligible[0];
}

function findByGenomeRoot(rows, root) {
  const wanted = root.toLowerCase();
  return rows.find((row) => row.genomeRoot.toLowerCase() === wanted) || null;
}

module.exports = { readOrganism, readPopulation, fittestBreeder, findByGenomeRoot };
