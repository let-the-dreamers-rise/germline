"use strict";

// Reading a score out of somebody else's evaluation.
//
// Two things happen in this file, and both exist because evaluate() is the
// one part of a trial we did not write.
//
// UNITS. Products already measure themselves, and they measure in whatever
// unit their dashboard uses: a 0..1 accuracy, a percentage, a conversion
// rate, basis points. The contract takes basis points, so something has to
// convert, and asking every integrator to remember which end of the range we
// wanted is how you get a run that quietly scores everything at zero.
//
// FAILURE. A product's evaluate() runs the product's own stack: an eval set
// can be missing, a model endpoint can time out, a mutated configuration can
// be one the product cannot even construct. That is normal, and it is a fact
// about the configuration rather than an accident -- a configuration that
// crashes the system is a bad configuration. So a throw is recorded as an
// unmeasured organism scoring zero, which under any sane threshold leaves no
// descendants, and the run continues.

const { evidenceRootOf } = require("./canonical");

const SCALES = ["auto", "fraction", "bps"];

function describeValue(value) {
  if (value === null) return "null";
  if (typeof value === "object") return "an object with no score";
  return typeof value + " " + JSON.stringify(value);
}

/// Convert a score to basis points and clamp it into the range the contract
/// accepts. Under "auto", a value of 1 or less is read as a fraction and
/// anything above 1 as basis points already -- so 0.42 and 4200 both mean the
/// same thing, and a perfect score may be written as either 1 or 10000. A
/// trial that measures in a unit where 1 is a real, non-perfect score should
/// say so with scoreScale: "bps".
function toBps(value, scale) {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error("evaluate() must return a finite score, got " + describeValue(value));
  }
  let bps;
  if (scale === "bps") bps = value;
  else if (scale === "fraction") bps = value * 10000;
  else bps = value > 1 ? value : value * 10000;
  // A negative score is not a punishment the contract can express; it simply
  // means the configuration earns nothing.
  return Math.max(0, Math.min(10000, Math.round(bps)));
}

/// Pull the score and any supporting material out of whatever evaluate()
/// returned. A bare number is accepted because the shortest useful evaluate
/// is one line, and making people wrap it in an object earns nothing.
function readResult(result, scale) {
  if (typeof result === "number") {
    return { fitnessBps: toBps(result, scale), evidence: null };
  }
  if (!result || typeof result !== "object") {
    throw new Error(
      "evaluate() must return a score or an object with a score, got " + describeValue(result)
    );
  }
  const read = {
    evidence: result.evidence === undefined ? null : result.evidence,
    trialId: result.trialId,
    evidenceRoot: result.evidenceRoot,
  };
  if (result.scoreBps !== undefined) {
    read.fitnessBps = toBps(result.scoreBps, "bps");
    return read;
  }
  if (result.score === undefined) {
    throw new Error("evaluate() returned an object with neither score nor scoreBps");
  }
  read.fitnessBps = toBps(result.score, scale);
  return read;
}

/// Run a product's evaluate() and turn whatever comes back into a
/// measurement the selection loop and the contract can both use.
async function measure(trial, config, context) {
  let raw;
  try {
    // The configuration is copied on the way out so that a product which
    // mutates its argument cannot corrupt the lineage we are recording.
    raw = await trial.spec.evaluate({ ...config }, context);
  } catch (error) {
    return failed(trial, error);
  }

  try {
    const read = readResult(raw, trial.scoreScale);
    const transcript = {
      trial: trial.name,
      version: trial.version,
      trialId: read.trialId || trial.trialId,
      config: JSON.parse(trial.canonical(config)),
      configRoot: trial.root(config),
      fitnessBps: read.fitnessBps,
      evidence: read.evidence,
    };
    return {
      ok: true,
      fitnessBps: read.fitnessBps,
      evidence: read.evidence,
      // A trial that already hashes its own transcript keeps its own root, so
      // an attestation made through the SDK names the same bytes an
      // attestation made without it would have named.
      evidenceRoot: read.evidenceRoot || evidenceRootOf(transcript),
      trialId: read.trialId || trial.trialId,
      transcript,
      error: null,
    };
  } catch (error) {
    return failed(trial, error);
  }
}

function failed(trial, error) {
  return {
    ok: false,
    fitnessBps: 0,
    evidence: null,
    // No evidence root, and therefore nothing to attest. An organism whose
    // evaluation failed is not an organism that scored zero: it is one
    // nobody measured, and the contract refuses to record a score without
    // evidence for exactly that reason.
    evidenceRoot: null,
    trialId: trial.trialId,
    transcript: null,
    error: error instanceof Error ? error.message : String(error),
  };
}

module.exports = { SCALES, toBps, readResult, measure };
