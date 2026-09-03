"use strict";

// Germline's public entry point.
//
//     const { defineTrial, optimise } = require("germline");
//
//     const trial = defineTrial({
//       name: "support-agent-v3",
//       genes: {
//         retrievalDepth: { type: "int",    min: 1, max: 12 },
//         rerank:         { type: "bool" },
//         temperature:    { type: "choice", options: [0, 0.3, 0.7] },
//         toolPolicy:     { type: "choice", options: ["eager", "lazy", "never"] },
//       },
//       evaluate: async (config) => ({ score: 0.0, evidence: {} }),
//     });
//
//     const result = await search(trial, { budget: 40 });
//
// defineTrial() describes what may vary and what better means. search()
// runs a strategy over it, measures what random sampling would have achieved
// on the same budget, and tells you which won. A team can use exactly those
// two calls and never learn that a chain, a mutation operator or a bit mask
// are involved.
//
// The baseline is not optional, and that is deliberate. This project once
// shipped a README claiming its search found 80% of the available headroom
// for 21% of the evaluation budget. Both numbers were true and the claim was
// still wrong, because nobody had measured what random sampling does with
// the same budget: it wins, 99.8% of the time, on that example. A search
// result without a control is not a result. See sdk/search.js.
//
// Everything else exported here is a building block those two are made of,
// kept public because a product that outgrows the two-call surface --
// listing a trial's configuration space in a UI, hashing a configuration by
// hand, deriving its own seeds for a custom loop -- should not have to reach
// into the library's internals to do it.

const { defineTrial } = require("./trial");
const { optimise } = require("./optimise");
const { randomSearch, baseline, verdict } = require("./search");

/// Run a search, always against a control.
///
/// `strategy` is 'evolution' (selection, good on rugged spaces), 'random'
/// (hard to beat on smooth ones), or 'auto', which runs the cheap control
/// first and picks whichever is winning. Whatever runs, the result carries a
/// lineage that can be verified -- which is the part Germline actually sells.
async function search(trial, options = {}) {
  const budget = options.budget || 40;
  const strategy = options.strategy || "evolution";

  const control =
    options.baseline === false
      ? null
      : await baseline(trial, budget, { repeats: options.baselineRepeats });

  let run;
  if (strategy === "random") {
    run = await randomSearch(trial, { budget, seed: options.seed });
  } else {
    // optimise() breeds rather than counting evaluations, so translate a
    // budget into generations at roughly the population growth it produces.
    const generations = options.generations || Math.max(2, Math.round(budget / 6));
    const bred = await optimise(trial, { ...options, generations });
    run = {
      strategy: "evolution",
      best: bred.best,
      history: bred.history,
      evaluations: bred.population.length,
      population: bred.population,
      founder: bred.founder,
      chain: bred.chain,
    };
  }

  const fitnessBps = run.best ? run.best.fitnessBps : 0;
  return {
    ...run,
    baseline: control,
    verdict: verdict(fitnessBps, control),
  };
}
const { compileSchema, cardinality, TYPES: GENE_TYPES } = require("./genes");
const { canonical, rootOf, evidenceRootOf, stableStringify } = require("./canonical");
const { localSeed } = require("./seed");

module.exports = {
  // The two calls almost every integration needs.
  defineTrial,
  search,

  // The strategies, and the control that keeps a claim honest.
  optimise,
  randomSearch,
  baseline,
  verdict,

  // Building blocks, for tooling built on top of a trial or a raw schema.
  GENE_TYPES,
  compileSchema,
  cardinality,
  canonical,
  rootOf,
  evidenceRootOf,
  stableStringify,
  localSeed,
};
