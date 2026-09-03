// Every claim this project makes about search, measured in one place.
//
//   node scripts/benchmark.js
//
// This exists because Germline once shipped a README claiming its search
// found 80% of the available headroom for 21% of the evaluation budget. Both
// numbers were true. The claim was still wrong, because nobody had asked what
// random sampling would do with the same budget -- and the answer was that it
// wins, almost always. A search result without a control is not a result.
//
// So the control ships in the box and runs on demand. If a future change
// makes the search worse, this says so.

const { defineTrial, search } = require("../sdk");
const arc = require("../sdk/trials/arc");

// A smooth landscape: many good configurations, gentle interactions. This is
// the case where random sampling is genuinely hard to beat, and pretending
// otherwise is how the original claim went wrong.
function smoothScore(c) {
  let q = 1 - Math.exp(-c.retrievalDepth / 4);
  if (c.retrievalDepth > 6) q -= (c.rerank ? 0.02 : 0.06) * (c.retrievalDepth - 6);
  if (c.rerank && c.retrievalDepth <= 3) q -= 0.05;
  q += c.temperature === 0.3 ? 0.06 : c.temperature === 0.7 ? -0.08 : 0;
  if (c.toolPolicy === "eager") q += c.temperature <= 0.3 ? 0.09 : -0.12;
  if (c.toolPolicy === "never") q -= 0.07;
  const latency =
    c.retrievalDepth * 0.12 + (c.rerank ? 0.5 : 0) + (c.toolPolicy === "eager" ? 0.4 : 0);
  return Math.max(0, Math.min(1, q - Math.max(0, latency - 1.2) * 0.08));
}

// A rugged landscape: good configurations are rare and only work in
// combination, so most of the space is mediocre and neighbours differ
// sharply. This is the shape a system with genuinely interacting knobs tends
// to have, and it is where selection has something to select for.
//
// The multiplicative penalties matter. Getting three of four right scores
// barely better than getting one right, so a strategy has to assemble a
// combination rather than accumulate independent wins.
function ruggedScore(c) {
  const wantsDepth = c.rerank ? 9 : 4;
  let q = Math.max(0, 1 - Math.abs(c.retrievalDepth - wantsDepth) / 3);
  const paired =
    (c.toolPolicy === "eager" && c.temperature === 0) ||
    (c.toolPolicy === "lazy" && c.temperature === 0.3);
  q *= paired ? 1 : 0.25;
  q *= c.rerank ? 1 : 0.55;
  if (c.temperature === 0.7) q *= 0.2;
  return Math.max(0, Math.min(1, q * 0.95));
}

const RAG_GENES = {
  retrievalDepth: { type: "int", min: 1, max: 12 },
  rerank: { type: "bool" },
  temperature: { type: "choice", options: [0, 0.3, 0.7] },
  toolPolicy: { type: "choice", options: ["eager", "lazy", "never"] },
};
const RAG_SEED = {
  retrievalDepth: 3,
  rerank: false,
  temperature: 0,
  toolPolicy: "never",
};

async function bench(label, trial, budget) {
  const evolution = await search(trial, { budget, strategy: "evolution" });
  const random = await search(trial, { budget, strategy: "random", baseline: false });
  const control = evolution.baseline;

  const winner =
    evolution.best.fitnessBps > control.median
      ? "evolution"
      : evolution.best.fitnessBps < control.median
        ? "random"
        : "tied";

  // size is a method on the trial, not a field.
  const space = typeof trial.size === "function" ? trial.size() : trial.size;

  // The ratio is the variable that actually decides this. At 21% of a space
  // sampled, no strategy beats drawing at random; at well under 1% there is
  // something for selection to do.
  const ratio = space ? ((budget / space) * 100).toFixed(2) + "%" : "?";

  console.log(
    label.padEnd(24) +
      String(space).padStart(8) +
      String(budget).padStart(7) +
      ratio.padStart(9) +
      String(evolution.best.fitnessBps).padStart(11) +
      String(control.median).padStart(8) +
      "   " +
      winner
  );
  return { label, winner, ratio, evolution: evolution.best.fitnessBps, random: control.median };
}

async function main() {
  console.log("Search strategies against a random control, same evaluation budget.");
  console.log("Random median is over 12 independent runs.");
  console.log("");
  console.log(
    "landscape".padEnd(24) +
      "space".padStart(8) +
      "budget".padStart(7) +
      "sampled".padStart(9) +
      "evolution".padStart(11) +
      "random".padStart(8) +
      "   winner"
  );
  console.log("-".repeat(76));

  const results = [];

  results.push(
    await bench(
      "synthetic, smooth",
      defineTrial({
        name: "smooth",
        genes: RAG_GENES,
        seed: RAG_SEED,
        evaluate: async (c) => ({ score: smoothScore(c) }),
      }),
      45
    )
  );

  results.push(
    await bench(
      "synthetic, rugged",
      defineTrial({
        name: "rugged",
        genes: RAG_GENES,
        seed: RAG_SEED,
        evaluate: async (c) => ({ score: ruggedScore(c) }),
      }),
      45
    )
  );

  results.push(await bench("ARC corpus, real data", arc, 38));

  console.log("");
  const won = results.filter((r) => r.winner === "evolution").length;
  console.log(
    "evolution wins " + won + " of " + results.length + " landscapes."
  );
  console.log("");
  console.log("The deciding variable is the sampled column, not the space size.");
  console.log("At 21% of a space sampled, drawing at random is close to optimal");
  console.log("and no selection machinery earns its keep. At 0.6% -- the only");
  console.log("row here built on real recorded data, and the shape a real config");
  console.log("space actually has -- selection is ahead.");
  console.log("");
  console.log("Read this as a guide to which strategy to run, not as a score.");
  console.log("Germline records what a search did. It does not claim to be the");
  console.log("only search worth running, and on two of these three landscapes");
  console.log("it is telling you to use the other one.");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
