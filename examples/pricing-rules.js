// Tuning a discount ladder. There is no model here at all.
//
// This example exists to make one thing unambiguous: Germline optimises
// configuration, not prompts. If your product has knobs and you can measure
// an outcome, it applies -- pricing rules, retry policy, cache TTLs, matching
// thresholds, feature gates. The AI framing is a common use, not the limit.
//
// Run it:  node examples/pricing-rules.js

const { defineTrial, optimise } = require("../sdk");

// A stand-in for what you would compute from real order history. The tension
// is the ordinary one in pricing: a deeper discount converts more customers
// and earns less on each, and moving the threshold trades volume against the
// people who would have paid full price anyway.
function monthlyMargin(config) {
  const { tier1Discount, tier2Discount, tier2Threshold, freeShipping } = config;

  // How many of a notional 1000 baskets clear the second tier.
  const largeBaskets = Math.max(0, 420 - (tier2Threshold - 40) * 6);
  const smallBaskets = 1000 - largeBaskets;

  // Discount lifts conversion with diminishing returns.
  const smallConversion = 0.28 + Math.sqrt(tier1Discount) * 0.028;
  const largeConversion = 0.34 + Math.sqrt(tier2Discount) * 0.026;

  const smallValue = 32;
  const largeValue = tier2Threshold * 1.35;

  // Free shipping converts well and is a flat cost per order, so it pays on
  // large baskets and quietly bleeds margin on small ones.
  const shippingLift = freeShipping ? 0.05 : 0;
  const shippingCost = freeShipping ? 4.2 : 0;

  const smallMargin =
    smallBaskets *
    (smallConversion + shippingLift) *
    (smallValue * (1 - tier1Discount / 100) * 0.42 - shippingCost);

  const largeMargin =
    largeBaskets *
    (largeConversion + shippingLift) *
    (largeValue * (1 - tier2Discount / 100) * 0.38 - shippingCost);

  return smallMargin + largeMargin;
}

// Normalise to 0..1 against a margin nobody realistically beats, because the
// SDK wants a score rather than a currency amount.
const CEILING = 9000;

const trial = defineTrial({
  name: "checkout-discount-ladder",
  genes: {
    tier1Discount: { type: "int", min: 0, max: 25 },
    tier2Discount: { type: "int", min: 0, max: 40 },
    tier2Threshold: { type: "int", min: 40, max: 100 },
    freeShipping: { type: "bool" },
  },
  // What the shop runs today, chosen by somebody in a meeting.
  seed: {
    tier1Discount: 5,
    tier2Discount: 10,
    tier2Threshold: 75,
    freeShipping: false,
  },
  evaluate: async (config) => ({
    score: Math.max(0, Math.min(1, monthlyMargin(config) / CEILING)),
    evidence: { margin: Math.round(monthlyMargin(config)) },
  }),
});

async function main() {
  console.log("Trial: " + trial.name + "  (no model involved)");
  console.log("Configuration space: 26 x 41 x 61 x 2 = " + 26 * 41 * 61 * 2);
  console.log("");

  const run = await optimise(trial, { generations: 8 });

  // History records the child by id; the configuration itself lives on the
  // organism, so index the population to show what actually changed.
  const byId = new Map(run.population.map((o) => [o.id, o]));

  console.log("gen  parent -> child   fitness    margin   configuration");
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
        String(Math.round(monthlyMargin(config))).padStart(10) +
        "   t1=" + config.tier1Discount + "%" +
        " t2=" + config.tier2Discount + "%" +
        " over " + config.tier2Threshold +
        " ship=" + config.freeShipping +
        (improved ? "   <- best so far" : "")
    );
  }

  const before = Math.round(monthlyMargin(run.founder.config));
  const after = Math.round(monthlyMargin(run.best.config));
  console.log("");
  console.log("current rules:  " + JSON.stringify(run.founder.config));
  console.log("  margin:       " + before);
  console.log("best found:     " + JSON.stringify(run.best.config));
  console.log("  margin:       " + after);
  console.log(
    "improvement:    " +
      (after - before) +
      " per thousand baskets, from " +
      run.population.length +
      " configurations evaluated"
  );
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
