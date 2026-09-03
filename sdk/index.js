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
//     const result = await optimise(trial, { generations: 10 });
//
// defineTrial() describes what may vary and what better means. optimise()
// runs selection over it and returns the fittest configuration it found. A
// team can use exactly those two calls and never learn that a chain, a
// mutation operator or a bit mask are involved.
//
// Everything else exported here is a building block those two are made of,
// kept public because a product that outgrows the two-call surface --
// listing a trial's configuration space in a UI, hashing a configuration by
// hand, deriving its own seeds for a custom loop -- should not have to reach
// into the library's internals to do it.

const { defineTrial } = require("./trial");
const { optimise } = require("./optimise");
const { compileSchema, cardinality, TYPES: GENE_TYPES } = require("./genes");
const { canonical, rootOf, evidenceRootOf, stableStringify } = require("./canonical");
const { localSeed } = require("./seed");

module.exports = {
  // The two calls almost every integration needs.
  defineTrial,
  optimise,

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
