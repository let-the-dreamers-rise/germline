// Tuning a summariser whose quality is judged by a model on 0G Compute.
//
// This is the case arithmetic cannot score. Whether a summary kept the facts
// is a judgement, and judgement is what an eval harness actually spends its
// money on -- so it is where a decentralised inference network earns its keep.
//
// Run it:  node examples/llm-judge.js
//
// Without ZEROG_COMPUTE_KEY it explains what it would have done and exits
// cleanly, rather than pretending to have measured something.

const { defineTrial, optimise } = require("../sdk");
const { makeJudge, models, DEFAULT_MODEL } = require("../lib/compute");

// Stand-in for the system being tuned. In a real integration this calls your
// summariser with the configuration applied.
function summarise(config, testCase) {
  const sentences = testCase.text.split(/(?<=\.)\s+/);
  const kept = sentences.slice(0, config.sentences);
  const body = kept.join(" ");
  const prefix = config.leadWithTopic ? testCase.topic + ": " : "";
  return config.style === "terse"
    ? prefix + body.replace(/\s+/g, " ").trim()
    : prefix + body + (config.addCaveat ? " Details may vary." : "");
}

const CASES = [
  {
    topic: "Refund policy",
    text: "Refunds are issued within 14 days of purchase. The item must be unused and in its original packaging. Shipping costs are not refunded. Faulty items are exempt from these conditions.",
  },
  {
    topic: "Account recovery",
    text: "Password resets are sent to the registered email address. The link expires after one hour. If the address is no longer accessible, contact support with proof of identity. Recovery can take up to three working days.",
  },
];

async function main() {
  const listing = await models();
  console.log("0G Compute router: " + (listing.ok ? "live, " + listing.models.length + " models" : "unreachable"));
  console.log("judge model:       " + DEFAULT_MODEL);
  console.log("");

  if (!process.env.ZEROG_COMPUTE_KEY) {
    console.log("No ZEROG_COMPUTE_KEY set, so nothing was measured.");
    console.log("");
    console.log("With a key from pc.0g.ai this would evolve the four knobs below,");
    console.log("scoring every candidate summary with a model on 0G Compute:");
    console.log("");
    console.log("  sentences      int 1..4      how much to keep");
    console.log("  style          terse | full  how to phrase it");
    console.log("  leadWithTopic  bool          name the topic first");
    console.log("  addCaveat      bool          hedge the answer");
    console.log("");
    console.log("Each generation costs one judged pass over " + CASES.length + " cases.");
    console.log("At roughly $0.003 per 1K tokens, a full run is cents.");
    return;
  }

  const trial = defineTrial({
    name: "summariser-judged-on-0g",
    genes: {
      sentences: { type: "int", min: 1, max: 4 },
      style: { type: "choice", options: ["terse", "full"] },
      leadWithTopic: { type: "bool" },
      addCaveat: { type: "bool" },
    },
    seed: { sentences: 1, style: "terse", leadWithTopic: false, addCaveat: false },
    evaluate: makeJudge({
      cases: CASES,
      run: (config, testCase) => summarise(config, testCase),
      rubric:
        "Score how completely and accurately the summary captures the source, " +
        "penalising omitted conditions and invented detail, from 0 to 10.",
      // A judge is not perfectly deterministic even at temperature zero, and
      // selection would happily promote a configuration that got lucky once.
      samples: 2,
    }),
  });

  const run = await optimise(trial, { generations: 4 });

  console.log("gen  parent -> child   fitness   configuration");
  const byId = new Map(run.population.map((o) => [o.id, o]));
  for (const step of run.history) {
    if (step.outcome === "stillborn") continue;
    const config = (byId.get(step.child) || {}).config || {};
    console.log(
      String(step.generation).padStart(3) +
        String(step.parent + " -> " + step.child).padStart(15) +
        String(step.fitnessBps).padStart(10) +
        "   " + JSON.stringify(config)
    );
  }

  console.log("");
  console.log("starting: " + JSON.stringify(run.founder.config) + "  " + run.founder.fitnessBps + " bps");
  console.log("best:     " + JSON.stringify(run.best.config) + "  " + run.best.fitnessBps + " bps");
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
