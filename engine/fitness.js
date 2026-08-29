"use strict";

// Fitness is measured, not asserted. A genome describes a predictor; we build
// that predictor from the first half of a recorded corpus and ask it about
// the second half, which it has never seen.
//
// SCORING. A predictor is allowed to abstain, and abstention has to be worth
// something or a cautious genome is punished for its caution. But silence
// cannot be free either, or the fittest organism is the one that never speaks.
// So we score the whole agent rather than the model alone: where the model
// abstains, the agent falls back to the baseline guess it would have made
// anyway.
//
//     fitness = (correct + rescuedByFallback) / total
//
// This has two properties worth having. A genome that always abstains scores
// exactly the baseline, so it is no better than having no model at all. And a
// genome that answers everything badly scores below the baseline, so
// confident nonsense is selected against. The baseline itself -- predicting
// from the action alone -- scores 3148 on this corpus, which is where the
// contract's survival threshold comes from: an organism must be at least as
// good as having no model whatsoever.
//
// The landscape this produces is not monotonic in complexity, which is what
// makes it worth searching. Measured on the corpus in engine/trial:
//
//     momentum only                4765   coverage 0.74  accuracy 0.617
//     colour+size+ring+momentum    4663   coverage 0.41  accuracy 0.801
//     ... + unanimous + backoff    4602   coverage 0.32  accuracy 0.808
//     ... + unanimous              4325   coverage 0.22  accuracy 0.904
//     colour+size+ring             4148   coverage 0.51  accuracy 0.592
//     ring only                    3935   coverage 0.58  accuracy 0.486
//     colour+size                  3821   coverage 0.61  accuracy 0.514
//     action only (founder)        3148   coverage 0.94  accuracy 0.333
//
// The most discriminating genome is not the fittest. Reading every feature
// buys accuracy at the cost of ever seeing a context twice: the everything-on
// genome answers 41% of the time at 0.80, while momentum alone answers 74% of
// the time at 0.62 and beats it. The peak sits where knowing something meets
// knowing it often enough to say so, and no amount of staring at the gene
// list would tell you where that is.

const fs = require("fs");
const path = require("path");
const { keccak256, toUtf8Bytes } = require("ethers");
const { canonical, genomeRoot, phenotype, validate } = require("./genome");

const TRIAL_PATH = path.join(__dirname, "trial", "arc-transitions.json");
const SIDES = ["U", "D", "L", "R"];

let cachedTrial = null;

function loadTrial(trialPath = TRIAL_PATH) {
  if (cachedTrial && cachedTrial.path === trialPath) return cachedTrial;
  const raw = JSON.parse(fs.readFileSync(trialPath, "utf8"));
  const rows = raw.rows.map((r) => ({
    game: r[0],
    action: r[1],
    colour: r[2],
    size: r[3],
    ring: r[4],
    momentum: r[5],
    delta: r[6],
  }));
  // The trial's own identity, so an attestation names the exact corpus it
  // was measured against.
  const trialId = keccak256(toUtf8Bytes(JSON.stringify(raw.rows)));
  cachedTrial = { path: trialPath, rows, trialId, description: raw.description };
  return cachedTrial;
}

// Build the context key this genome is allowed to see.
function keyFor(genome, row, level) {
  const parts = [row.action];
  if (level >= 1 && genome.useColour) parts.push("c" + row.colour);
  if (level >= 1 && genome.useSize) parts.push("s" + row.size);
  if (level >= 2 && genome.useRing && genome.ringSides > 0) {
    for (let i = 0; i < 4; i++) {
      if ((genome.ringSides >> i) & 1) parts.push(SIDES[i] + row.ring[i]);
    }
  }
  if (level >= 3 && genome.useMomentum) parts.push("m" + row.momentum);
  return parts.join("|");
}

// The ladder a backing-off genome walks down: full context first, then
// progressively less of it, then the bare action.
const LADDER = [3, 2, 1, 0];

function tally(rows, genome, levels) {
  const tables = new Map();
  for (const level of levels) tables.set(level, new Map());
  for (const row of rows) {
    for (const level of levels) {
      const key = keyFor(genome, row, level);
      const table = tables.get(level);
      let counts = table.get(key);
      if (!counts) {
        counts = new Map();
        table.set(key, counts);
      }
      counts.set(row.delta, (counts.get(row.delta) || 0) + 1);
    }
  }
  return tables;
}

function consult(counts, genome) {
  if (!counts) return null;
  let total = 0;
  let best = null;
  let bestN = 0;
  for (const [delta, n] of counts) {
    total += n;
    if (n > bestN) {
      bestN = n;
      best = delta;
    }
  }
  if (total < genome.minSupport) return null;
  if (genome.unanimousOnly && counts.size !== 1) return null;
  return best;
}

/// Score a genome. Returns the fitness in basis points plus the full
/// transcript that justifies it.
function evaluate(genome, options = {}) {
  validate(genome);
  const trial = loadTrial(options.trialPath);
  const rows = trial.rows;
  const split = Math.floor(rows.length / 2);
  const train = rows.slice(0, split);
  const test = rows.slice(split);

  const levels = genome.backoff ? LADDER : [3];
  const tables = tally(train, genome, levels);

  // The baseline every agent falls back to: predict from the action alone.
  // It is a complete policy, so it answers on every row it can and is simply
  // wrong where it cannot.
  const baselineTable = tally(train, genome, [0]).get(0);
  const bare = { minSupport: 1, unanimousOnly: false };
  const baselineSays = (row) =>
    consult(baselineTable.get(keyFor(genome, row, 0)), bare);

  let baselineCorrect = 0;
  for (const row of test) {
    if (baselineSays(row) === row.delta) baselineCorrect++;
  }
  const baselineAccuracy = baselineCorrect / test.length;

  let correct = 0;
  let wrong = 0;
  let abstained = 0;
  let rescued = 0; // abstentions the fallback happened to get right
  const perGame = new Map();

  for (const row of test) {
    let guess = null;
    for (const level of levels) {
      guess = consult(tables.get(level).get(keyFor(genome, row, level)), genome);
      if (guess !== null) break;
    }
    let outcome;
    if (guess === null) {
      abstained++;
      outcome = "abstain";
      // Credit the fallback for this row specifically, rather than for the
      // average row. Crediting the average would pay a cautious genome for
      // ducking exactly the cases the baseline also fails, and a predictor
      // that abstains everywhere would then outscore the baseline it is
      // falling back on.
      if (baselineSays(row) === row.delta) rescued++;
    } else if (guess === row.delta) {
      correct++;
      outcome = "correct";
    } else {
      wrong++;
      outcome = "wrong";
    }
    let g = perGame.get(row.game);
    if (!g) {
      g = { correct: 0, wrong: 0, abstain: 0 };
      perGame.set(row.game, g);
    }
    g[outcome === "abstain" ? "abstain" : outcome]++;
  }

  const total = test.length;
  const effective = (correct + rescued) / total;
  const fitnessBps = Math.max(0, Math.min(10000, Math.round(effective * 10000)));

  const transcript = {
    trial: {
      id: trial.trialId,
      description: trial.description,
      rows: rows.length,
      trainRows: train.length,
      testRows: test.length,
    },
    genome: JSON.parse(canonical(genome)),
    genomeRoot: genomeRoot(genome),
    phenotype: phenotype(genome),
    result: {
      correct,
      wrong,
      abstained,
      rescuedByFallback: rescued,
      coverage: round4((correct + wrong) / total),
      accuracyWhenAnswering: round4(correct / Math.max(correct + wrong, 1)),
      baselineAccuracy: round4(baselineAccuracy),
      effectiveAccuracy: round4(effective),
      fitnessBps,
    },
    perGame: Object.fromEntries(
      [...perGame.entries()].sort().map(([g, v]) => [g, v])
    ),
    method:
      "Trained on the first half of the corpus in recorded order, scored on " +
      "the second. Where the model abstains the agent falls back to the " +
      "action-only baseline, so fitness reflects the whole agent rather than " +
      "the model in isolation.",
  };

  const evidenceRoot = keccak256(toUtf8Bytes(JSON.stringify(transcript)));
  return { fitnessBps, transcript, evidenceRoot, trialId: trial.trialId };
}

function round4(x) {
  return Math.round(x * 10000) / 10000;
}

module.exports = { evaluate, loadTrial, TRIAL_PATH };
