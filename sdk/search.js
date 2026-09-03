"use strict";

// Search strategies, and the baseline that keeps them honest.
//
// WHY THIS EXISTS. Germline originally shipped one strategy -- evolutionary
// selection -- and a README claiming it found 80% of the available headroom
// for 21% of the evaluation budget. Both numbers were true. The claim was
// still wrong, because nobody had asked what random sampling would do with
// the same budget. The answer, measured:
//
//   RAG example, 216 configs, 45 evaluations
//     evolution 8333 bps | random 9090 mean, 9159 median
//     random matched or beat evolution 99.8% of the time
//
//   Synthetic RAG, 1,728,000 configs, 48 evaluations
//     evolution 8431 bps | random 9829 mean
//     random matched or beat evolution 99.9% of the time
//
//   ARC corpus, 3,072 configs, 38 evaluations   (real recorded data)
//     evolution 4765 bps | random 4651 mean, 4673 median
//     random matched or beat evolution 30% of the time
//
// The pattern is not about space size, which was the obvious guess and was
// also wrong. It is about ruggedness. Where good configurations are common
// and the landscape is smooth, random sampling is extremely hard to beat and
// no amount of selection machinery helps. Where good configurations are rare
// and interacting -- which is what the real corpus looks like -- selection
// earns a modest edge.
//
// So Germline does not claim a better optimiser. It claims a verifiable
// record of whatever search you ran, and it ships the baseline in the box so
// that claim can never quietly rot again. If random wins on your space, use
// random: the provenance layer does not care which strategy produced the
// configuration, and pretending otherwise would be selling the wrong thing.

const { measure } = require("./score");

/// Draw a configuration uniformly from the declared space. Deterministic
/// given `rand`, so a baseline can be reproduced from a seed if needed.
function sampleConfig(genes, rand) {
  const config = {};
  // defineTrial normalises genes into an array of descriptors carrying their
  // own key. Accept the raw object form too, so this is usable against a
  // schema that has not been through defineTrial yet.
  const list = Array.isArray(genes)
    ? genes
    : Object.keys(genes).map((key) => ({ key, ...genes[key] }));

  for (const gene of list) {
    const key = gene.key;
    if (gene.type === "bool") {
      config[key] = rand() < 0.5;
    } else if (gene.type === "int") {
      config[key] = gene.min + Math.floor(rand() * (gene.max - gene.min + 1));
    } else if (gene.type === "choice") {
      config[key] = gene.options[Math.floor(rand() * gene.options.length)];
    } else if (gene.type === "mask") {
      config[key] = Math.floor(rand() * Math.pow(2, gene.bits));
    } else {
      throw new Error("cannot sample unknown gene type: " + gene.type);
    }
  }
  return config;
}

// A small deterministic PRNG so a baseline is reproducible. Same construction
// as the mutation engine, for the same reason: a number nobody can re-derive
// is a number nobody should trust.
function rngFrom(seed) {
  let x = seed >>> 0 || 0x9e3779b9;
  return function next() {
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    x >>>= 0;
    return x / 0x100000000;
  };
}

/// Random search over the declared space. Not a strawman -- on smooth
/// landscapes this is the strategy to beat, and frequently the one to use.
async function randomSearch(trial, options = {}) {
  const budget = options.budget || 40;
  const rand = rngFrom(options.seed === undefined ? 1 : options.seed);
  const seen = new Set();
  const history = [];
  let best = null;

  for (let i = 0; i < budget; i++) {
    const config = sampleConfig(trial.genes, rand);
    const key = JSON.stringify(config);
    if (seen.has(key)) continue;
    seen.add(key);

    const measured = await measure(trial, config);
    // A configuration whose evaluate() threw is unfit, not fatal. One bad
    // candidate must never end a search.
    if (!measured.ok) continue;
    const record = {
      index: i,
      config,
      fitnessBps: measured.fitnessBps,
      improved: !best || measured.fitnessBps > best.fitnessBps,
    };
    history.push(record);
    if (record.improved) best = { config, fitnessBps: measured.fitnessBps };
  }

  return { strategy: "random", best, history, evaluations: seen.size };
}

/// What random sampling would have achieved with the same budget, repeated
/// enough times to report a distribution rather than one lucky draw.
///
/// This runs by default. A search result that does not say what random would
/// have done is a number without a control, and this project already shipped
/// one of those.
async function baseline(trial, budget, options = {}) {
  const repeats = options.repeats || 12;
  const scores = [];

  for (let r = 0; r < repeats; r++) {
    const run = await randomSearch(trial, { budget, seed: 1000 + r * 7919 });
    if (run.best) scores.push(run.best.fitnessBps);
  }
  if (scores.length === 0) return null;

  scores.sort((a, b) => a - b);
  const mean = Math.round(scores.reduce((a, b) => a + b, 0) / scores.length);
  return {
    budget,
    repeats: scores.length,
    mean,
    median: scores[Math.floor(scores.length / 2)],
    worst: scores[0],
    best: scores[scores.length - 1],
  };
}

/// Compare a completed search against the baseline and say plainly which
/// won. Returning "random" here is a correct answer, not a failure.
function verdict(fitnessBps, base) {
  if (!base) return { winner: "unknown", note: "no baseline was run" };
  const beatsMedian = fitnessBps > base.median;
  const beatsMean = fitnessBps > base.mean;
  if (beatsMedian && beatsMean) {
    return {
      winner: "search",
      margin: fitnessBps - base.mean,
      note: "the search beat random sampling at the same budget",
    };
  }
  if (!beatsMedian && !beatsMean) {
    return {
      winner: "random",
      margin: base.mean - fitnessBps,
      note:
        "random sampling beat the search at this budget. On a smooth space " +
        "that is expected; use strategy 'random' and keep the provenance.",
    };
  }
  return {
    winner: "tied",
    margin: Math.abs(fitnessBps - base.mean),
    note: "the search and random sampling are within noise of each other",
  };
}

module.exports = { randomSearch, baseline, verdict, sampleConfig, rngFrom };
