"use strict";

// The ARC world-model trial, expressed as an ordinary instance of the public
// API rather than a special case.
//
// Before this SDK existed, this configuration space was hardcoded straight
// into engine/genome.js and engine/mutate.js: Germline's only product was
// Germline's own experiment. Now it is one call to defineTrial(), like any
// other product's would be, and the only ARC-specific code left anywhere is
// the gene declarations below and the evaluate() that delegates to
// engine/fitness.js. That is deliberate: it is the proof that generalising
// the SDK did not quietly keep a special case for its own reference example.
//
// The gene set matches engine/genome.js's GENES exactly, in the same order,
// so a configuration built here and a genome built there hash to the same
// root -- test/sdk.test.js checks this directly. The corpus, the scoring
// rule and the measured numbers documented in engine/fitness.js are
// unchanged; this file only re-describes the same space through the general
// schema instead of a bespoke one.

const { defineTrial } = require("../trial");
const { FOUNDER } = require("../../engine/genome");
const { evaluate } = require("../../engine/fitness");

const arcTrial = defineTrial({
  name: "arc-world-model",
  description:
    "Which context an ARC-AGI-3 world-model predictor may read before " +
    "answering, and how cautious it is about answering at all.",
  version: 1,
  // engine/fitness.js already returns basis points; scoreScale pins that
  // down explicitly rather than relying on evaluate()'s auto-detection.
  scoreScale: "bps",
  genes: {
    useColour: { type: "bool" },
    useSize: { type: "bool" },
    useRing: { type: "bool" },
    useMomentum: { type: "bool" },
    // Which sides of an object it may feel: up, down, left, right.
    ringSides: { type: "mask", bits: 4 },
    // How many observations a context needs before it is trusted at all.
    minSupport: { type: "int", min: 1, max: 6 },
    // Answer only from contexts that have never contradicted themselves.
    unanimousOnly: { type: "bool" },
    // On an unknown context, fall back to a less specific one.
    backoff: { type: "bool" },
  },
  seed: {
    useColour: FOUNDER.useColour,
    useSize: FOUNDER.useSize,
    useRing: FOUNDER.useRing,
    useMomentum: FOUNDER.useMomentum,
    ringSides: FOUNDER.ringSides,
    minSupport: FOUNDER.minSupport,
    unanimousOnly: FOUNDER.unanimousOnly,
    backoff: FOUNDER.backoff,
  },
  // A ring with no sides is not a ring, and sides with no ring are never
  // felt. engine/mutate.js enforces the same coherence rule inline after
  // every mutation; here it is the trial's repair(), which is exactly where
  // a rule that spans more than one gene belongs.
  repair(config) {
    const next = { ...config };
    if (next.useRing && next.ringSides === 0) next.ringSides = 15;
    if (!next.useRing) next.ringSides = 0;
    return next;
  },
  label(config) {
    const parts = [];
    if (config.useColour) parts.push("colour");
    if (config.useSize) parts.push("size");
    if (config.useRing && config.ringSides > 0) {
      const sides = ["U", "D", "L", "R"].filter((_, i) => (config.ringSides >> i) & 1);
      parts.push("ring:" + sides.join(""));
    }
    if (config.useMomentum) parts.push("momentum");
    if (parts.length === 0) parts.push("action-only");
    const caution = [];
    if (config.unanimousOnly) caution.push("unanimous");
    if (config.backoff) caution.push("backoff");
    if (config.minSupport > 1) caution.push("n>=" + config.minSupport);
    return parts.join("+") + (caution.length ? " [" + caution.join(",") + "]" : "");
  },
  // Delegates the actual measurement to engine/fitness.js, which trains on
  // half of the recorded ARC-AGI-3 corpus and scores against the other half.
  // Nothing about that corpus, split or scoring rule moved; only the
  // envelope around it changed.
  evaluate(config) {
    const result = evaluate({ version: 1, ...config });
    return {
      scoreBps: result.fitnessBps,
      evidence: result.transcript,
      evidenceRoot: result.evidenceRoot,
      trialId: result.trialId,
    };
  },
});

module.exports = arcTrial;
