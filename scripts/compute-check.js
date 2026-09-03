// Demonstrate the 0G Compute integration rather than claiming it.
//
//   node scripts/compute-check.js
//
// The model list needs no key, so reachability is always provable. Inference
// needs a key from pc.0g.ai with 0G deposited, and the script says plainly
// which of the two it managed.

const { models, complete, ROUTER, DEFAULT_MODEL } = require("../lib/compute");

async function main() {
  console.log("router: " + ROUTER);

  const listing = await models();
  console.log(
    "  live:   " +
      (listing.ok ? "yes" : "no") +
      "  (HTTP " + listing.status + ")  " +
      listing.models.length + " models served"
  );
  if (listing.ok) {
    console.log("  default: " + DEFAULT_MODEL +
      (listing.models.includes(DEFAULT_MODEL) ? " (available)" : " (NOT in the list)"));
    console.log("  sample:  " + listing.models.slice(0, 6).join(", "));
  }

  console.log("");
  if (!process.env.ZEROG_COMPUTE_KEY) {
    console.log("inference: skipped, no ZEROG_COMPUTE_KEY set");
    console.log("           get a key at pc.0g.ai and deposit 0G, then re-run");
    return;
  }

  const result = await complete([
    { role: "system", content: "Reply with a single integer and nothing else." },
    { role: "user", content: "What is 6 multiplied by 7?" },
  ]);

  if (!result.ok) {
    console.log("inference: failed -- " + result.note);
    process.exitCode = 1;
    return;
  }

  console.log("inference: ok");
  console.log("  model:   " + result.model);
  console.log("  reply:   " + String(result.text).trim().slice(0, 80));
  if (result.usage) {
    console.log("  tokens:  " + JSON.stringify(result.usage));
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
