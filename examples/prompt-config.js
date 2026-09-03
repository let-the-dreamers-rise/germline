// Tuning a retrieval-augmented support agent.
//
// This is the shape most teams are actually in. There are four knobs, they
// interact, and nobody has time to try 216 combinations by hand -- so the
// config that ships is whichever one someone tried on a Thursday.
//
// Run it:  node examples/prompt-config.js
//
// The evaluate() below stands in for what you would really do: replay a
// scored eval set, or shadow live traffic, and return how well the agent did.
// It is deterministic so the run reproduces exactly, which matters -- a
// lineage is only checkable if the measurement is repeatable.

const { defineTrial, optimise } = require("../sdk");

// A stand-in for a real eval harness. The interactions here are the point:
// deeper retrieval helps until it starts burying the answer in noise,
// reranking rescues deep retrieval but costs latency that shallow retrieval
// does not need, and an eager tool policy only pays off when the model is
// cool enough to follow instructions. No single knob has a best value on its
// own, which is exactly why one-at-a-time tuning finds the wrong config.
function scoreAgent(config) {
  const { retrievalDepth, rerank, temperature, toolPolicy } = config;

  // Recall rises with depth and then plateaus.
  let quality = 1 - Math.exp(-retrievalDepth / 4);

  // Past about six documents the answer starts drowning, unless a reranker
  // puts the right one back on top.
  if (retrievalDepth > 6) {
    quality -= rerank ? 0.02 * (retrievalDepth - 6) : 0.06 * (retrievalDepth - 6);
  }

  // Reranking a shallow set mostly reorders things that were already fine.
  if (rerank && retrievalDepth <= 3) quality -= 0.05;

  // Warmth helps phrasing and hurts faithfulness.
  quality += temperature === 0.3 ? 0.06 : temperature === 0.7 ? -0.08 : 0;

  // Eager tool use wins when the model follows the schema, which it stops
  // doing as temperature climbs.
  if (toolPolicy === "eager") quality += temperature <= 0.3 ? 0.09 : -0.12;
  if (toolPolicy === "never") quality -= 0.07;

  // Latency is part of quality for a support agent: a correct answer after
  // nine seconds is a worse product than a good one after two.
  const latency = retrievalDepth * 0.12 + (rerank ? 0.5 : 0) +
    (toolPolicy === "eager" ? 0.4 : 0);
  const penalty = Math.max(0, latency - 1.2) * 0.08;

  return Math.max(0, Math.min(1, quality - penalty));
}

const trial = defineTrial({
  name: "support-agent-rag",
  genes: {
    retrievalDepth: { type: "int", min: 1, max: 12 },
    rerank: { type: "bool" },
    temperature: { type: "choice", options: [0, 0.3, 0.7] },
    toolPolicy: { type: "choice", options: ["eager", "lazy", "never"] },
  },
  // Where most teams start: shallow retrieval, no reranker, no tools.
  seed: {
    retrievalDepth: 3,
    rerank: false,
    temperature: 0,
    toolPolicy: "never",
  },
  evaluate: async (config) => ({
    score: scoreAgent(config),
    evidence: { note: "synthetic eval set stand-in" },
  }),
});

async function main() {
  const combinations = 12 * 2 * 3 * 3;
  console.log("Trial: " + trial.name);
  console.log("Configuration space: " + combinations + " combinations");
  console.log("");

  const run = await optimise(trial, { generations: 8 });

  // History records the child by id; the configuration itself lives on the
  // organism, so index the population to show what actually changed.
  const byId = new Map(run.population.map((o) => [o.id, o]));

  console.log("gen  parent -> child   fitness   delta   configuration");
  let best = run.founder.fitnessBps;
  for (const step of run.history) {
    if (step.outcome === "stillborn") continue;
    const improved = step.fitnessBps > best;
    if (improved) best = step.fitnessBps;
    const config = (byId.get(step.child) || {}).config || {};
    console.log(
      String(step.generation).padStart(3) +
        String(step.parent + " -> " + step.child).padStart(15) +
        String(step.fitnessBps).padStart(10) +
        String(step.delta >= 0 ? "+" + step.delta : step.delta).padStart(8) +
        "   d=" + config.retrievalDepth +
        " rerank=" + config.rerank +
        " t=" + config.temperature +
        " tools=" + config.toolPolicy +
        (improved ? "   <- best so far" : "")
    );
  }

  console.log("");
  console.log("starting config: " + JSON.stringify(run.founder.config));
  console.log("  scored:        " + run.founder.fitnessBps + " bps");
  console.log("best found:      " + JSON.stringify(run.best.config));
  console.log("  scored:        " + run.best.fitnessBps + " bps");
  console.log(
    "improvement:     +" +
      (run.best.fitnessBps - run.founder.fitnessBps) +
      " bps, after evaluating " +
      run.population.length +
      " of " +
      combinations +
      " configurations"
  );
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
