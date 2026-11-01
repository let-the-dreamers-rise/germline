# AI configuration change record

Generated 2026-11-01T13:27:10.429Z by Germline from .germline/audit.jsonl.

## Integrity

**Hash chain verifies.** 4 entries, none edited, removed or reordered since they were written.

Head: `0xe810a21da74db4b02a90b097ea6ee7f5b23cb697ef82ff75a517b47b7f4e34cf`

This file reports log ID `0x6c968bafaffe4ad49d730e56626ee47c951c96d0254f4ecb76137ed0bdce6891`, anchored by `0xA1918A4E578babad074ACf7DCefB152f8FDC8D2E`.

**Pinned values were supplied by the verifier**, not taken from this file: log ID matches.

Anchored 1 time(s) on 0G Chain in the GermlineAnchor registry. The latest anchor covers the first 3 of 4 entries.

## Summary

| | |
|---|---|
| Systems | germline-examples |
| Changes recorded | 3 |
| Distinct authors | 2 |
| With a reason or ticket | 2 |
| Distinct reasons given | 2 |
| With a recorded approval | 0 |
| With test evidence | 0 |
| First change | 2026-09-03T14:36:58+05:30 |
| Latest change | 2026-11-01T13:26:55.387Z |

## Changes

| # | When (commit date, else recorded) | System | Author | What changed | Why, approval | Commit | Evidence | Config root |
|---|---|---|---|---|---|---|---|---|
| 0 | 2026-09-03T14:36:58+05:30 | germline-examples | ashwinthebest8@gmail.com (recorded by ashwingoyal2006@gmail.com) | examples/llm-judge.js: null → null; examples/pricing-rules.js: null → "// Tuning… (9905 chars) | feat: SDK, on-chain lifecycle, viewer, and two worked examples | `8baacb3bfb` | - | `0xcee03e09…` |
| 1 | 2026-09-03T15:08:33+05:30 | germline-examples | ashwinthebest8@gmail.com (recorded by ashwingoyal2006@gmail.com) | examples/llm-judge.js: null → "// Tuning a summariser whose quality is judged by… (4652 chars) | feat: 0G Compute as the judge, deliberately not as the mutator | `03022891e1` | - | `0xa90f440c…` |
| 2 | 2026-11-01T13:26:55.387Z | germline-examples | ashwingoyal2006@gmail.com | examples/llm-judge.js: 200 line(s) changed, see below; examples/pricing-rules.js… (171 chars) | uncommitted working-tree change | - | - | `0xe3d0e0d5…` |

## Text changes

Entry 2, examples/llm-judge.js:

    - // Tuning a summariser whose quality is judged by a model on 0G Compute.
    - //
    - // This is the case arithmetic cannot score. Whether a summary kept the facts
    - // is a judgement, and judgement is what an eval harness actually spends its
    - // money on -- so it is where a decentralised inference network earns its keep.
    - //
    - // Run it:  node examples/llm-judge.js
    - //
    - // Without ZEROG_COMPUTE_KEY it explains what it would have done and exits
    - // cleanly, rather than pretending to have measured something.
    - 
    - const { defineTrial, optimise } = require("../sdk");
    - const { makeJudge, models, DEFAULT_MODEL } = require("../lib/compute");
    - 
    - // Stand-in for the system being tuned. In a real integration this calls your
    - // summariser with the configuration applied.
    - function summarise(config, testCase) {
    -   const sentences = testCase.text.split(/(?<=\.)\s+/);
    -   const kept = sentences.slice(0, config.sentences);
    -   const body = kept.join(" ");
    -   const prefix = config.leadWithTopic ? testCase.topic + ": " : "";
    -   return config.style === "terse"
    -     ? prefix + body.replace(/\s+/g, " ").trim()
    -     : prefix + body + (config.addCaveat ? " Details may vary." : "");
    - }
    - 
    - const CASES = [
    -   {
    -     topic: "Refund policy",
    -     text: "Refunds are issued within 14 days of purchase. The item must be unused and in its original packaging. Shipping costs are not refunded. Faulty items are exempt from these conditions.",
    -   },
    -   {
    -     topic: "Account recovery",
    -     text: "Password resets are sent to the registered email address. The link expires after one hour. If the address is no longer accessible, contact support with proof of identity. Recovery can take up to three working days.",
    -   },
    - ];
    - 
    - async function main() {
    -   const listing = await models();
    -   console.log("0G Compute router: " + (listing.ok ? "live, " + listing.models.length + " models" : "unreachable"));
    -   console.log("judge model:       " + DEFAULT_MODEL);
    -   console.log("");
    - 
    -   if (!process.env.ZEROG_COMPUTE_KEY) {
    -     console.log("No ZEROG_COMPUTE_KEY set, so nothing was measured.");
    -     console.log("");
    -     console.log("With a key from pc.0g.ai this would evolve the four knobs below,");
    -     console.log("scoring every candidate summary with a model on 0G Compute:");
    -     console.log("");
    -     console.log("  sentences      int 1..4      how much to keep");
    -     console.log("  style          terse | full  how to phrase it");
    -     console.log("  leadWithTopic  bool          name the topic first");
    -     console.log("  addCaveat      bool          hedge the answer");
    -     console.log("");
    -     console.log("Each generation costs one judged pass over " + CASES.length + " cases.");
    -     console.log("At roughly $0.003 per 1K tokens, a full run is cents.");
    -     return;
    -   }
    - 
    -   const trial = defineTrial({
    -     name: "summariser-judged-on-0g",
    -     genes: {
    -       sentences: { type: "int", min: 1, max: 4 },
    -       style: { type: "choice", options: ["terse", "full"] },
    -       leadWithTopic: { type: "bool" },
    -       addCaveat: { type: "bool" },
    -     },
    -     seed: { sentences: 1, style: "terse", leadWithTopic: false, addCaveat: false },
    -     evaluate: makeJudge({
    -       cases: CASES,
    -       run: (config, testCase) => summarise(config, testCase),
    -       rubric:
    -         "Score how completely and accurately the summary captures the source, " +
    -         "penalising omitted conditions and invented detail, from 0 to 10.",
    -       // A judge is not perfectly deterministic even at temperature zero, and
    -       // selection would happily promote a configuration that got lucky once.
    -       samples: 2,
    -     }),
    -   });
    - 
    -   const run = await optimise(trial, { generations: 4 });
    - 
    -   console.log("gen  parent -> child   fitness   configuration");
    -   const byId = new Map(run.population.map((o) => [o.id, o]));
    -   for (const step of run.history) {
    -     if (step.outcome === "stillborn") continue;
    -     const config = (byId.get(step.child) || {}).config || {};
    -     console.log(
    -       String(step.generation).padStart(3) +
    -         String(step.parent + " -> " + step.child).padStart(15) +
    -         String(step.fitnessBps).padStart(10) +
    -         "   " + JSON.stringify(config)
    -     );
    -   }
    - 
    -   console.log("");
    -   console.log("starting: " + JSON.stringify(run.founder.config) + "  " + run.founder.fitnessBps + " bps");
    -   console.log("best:     " + JSON.stringify(run.best.config) + "  " + run.best.fitnessBps + " bps");
    - }
    - 
    - main().catch((error) => {
    -   console.error(error.message);
    -   process.exitCode = 1;
    - });
    + // Tuning a summariser whose quality is judged by a model on 0G Compute. 
    + // 
    + // This is the case arithmetic cannot score. Whether a summary kept the facts 
    + // is a judgement, and judgement is what an eval harness actually spends its 
    + // money on -- so it is where a decentralised inference network earns its keep. 
    + // 
    + // Run it:  node examples/llm-judge.js 
    + // 
    + // Without ZEROG_COMPUTE_KEY it explains what it would have done and exits 
    + // cleanly, rather than pretending to have measured something. 
    +  
    + const { defineTrial, optimise } = require("../sdk"); 
    + const { makeJudge, models, DEFAULT_MODEL } = require("../lib/compute"); 
    +  
    + // Stand-in for the system being tuned. In a real integration this calls your 
    + // summariser with the configuration applied. 
    + function summarise(config, testCase) { 
    +   const sentences = testCase.text.split(/(?<=\.)\s+/); 
    +   const kept = sentences.slice(0, config.sentences); 
    +   const body = kept.join(" "); 
    +   const prefix = config.leadWithTopic ? testCase.topic + ": " : ""; 
    +   return config.style === "terse" 
    +     ? prefix + body.replace(/\s+/g, " ").trim() 
    +     : prefix + body + (config.addCaveat ? " Details may vary." : ""); 
    + } 
    +  
    + const CASES = [ 
    +   { 
    +     topic: "Refund policy", 
    +     text: "Refunds are issued within 14 days of purchase. The item must be unused and in its original packaging. Shipping costs are not refunded. Faulty items are exempt from these conditions.", 
    +   }, 
    +   { 
    +     topic: "Account recovery", 
    +     text: "Password resets are sent to the registered email address. The link expires after one hour. If the address is no longer accessible, contact support with proof of identity. Recovery can take up to three working days.", 
    +   }, 
    + ]; 
    +  
    + async function main() { 
    +   const listing = await models(); 
    +   console.log("0G Compute router: " + (listing.ok ? "live, " + listing.models.length + " models" : "unreachable")); 
    +   console.log("judge model:       " + DEFAULT_MODEL); 
    +   console.log(""); 
    +  
    +   if (!process.env.ZEROG_COMPUTE_KEY) { 
    +     console.log("No ZEROG_COMPUTE_KEY set, so nothing was measured."); 
    +     console.log(""); 
    +     console.log("With a key from pc.0g.ai this would evolve the four knobs below,"); 
    +     console.log("scoring every candidate summary with a model on 0G Compute:"); 
    +     console.log(""); 
    +     console.log("  sentences      int 1..4      how much to keep"); 
    +     console.log("  style          terse | full  how to phrase it"); 
    +     console.log("  leadWithTopic  bool          name the topic first"); 
    +     console.log("  addCaveat      bool          hedge the answer"); 
    +     console.log(""); 
    +     console.log("Each generation costs one judged pass over " + CASES.length + " cases."); 
    +     console.log("At roughly $0.003 per 1K tokens, a full run is cents."); 
    +     return; 
    +   } 
    +  
    +   const trial = defineTrial({ 
    +     name: "summariser-judged-on-0g", 
    +     genes: { 
    +       sentences: { type: "int", min: 1, max: 4 }, 
    +       style: { type: "choice", options: ["terse", "full"] }, 
    +       leadWithTopic: { type: "bool" }, 
    +       addCaveat: { type: "bool" }, 
    +     }, 
    +     seed: { sentences: 1, style: "terse", leadWithTopic: false, addCaveat: false }, 
    +     evaluate: makeJudge({ 
    +       cases: CASES, 
    +       run: (config, testCase) => summarise(config, testCase), 
    +       rubric: 
    +         "Score how completely and accurately the summary captures the source, " + 
    +         "penalising omitted conditions and invented detail, from 0 to 10.", 
    +       // A judge is not perfectly deterministic even at temperature zero, and 
    +       // selection would happily promote a configuration that got lucky once. 
    +       samples: 2, 
    +     }), 
    +   }); 
    +  
    +   const run = await optimise(trial, { generations: 4 }); 
    +  
    +   console.log("gen  parent -> child   fitness   configuration"); 
    +   const byId = new Map(run.population.map((o) => [o.id, o])); 
    +   for (const step of run.history) { 
    +     if (step.outcome === "stillborn") continue; 
    +     const config = (byId.get(step.child) || {}).config || {}; 
    +     console.log( 
    +       String(step.generation).padStart(3) + 
    +         String(step.parent + " -> " + step.child).padStart(15) + 
    +         String(step.fitnessBps).padStart(10) + 
    +         "   " + JSON.stringify(config) 
    +     ); 
    +   } 
    +  
    +   console.log(""); 

Entry 2, examples/pricing-rules.js:

    - // Tuning a discount ladder. There is no model here at all.
    - //
    - // This example exists to make one thing unambiguous: Germline optimises
    - // configuration, not prompts. If your product has knobs and you can measure
    - // an outcome, it applies -- pricing rules, retry policy, cache TTLs, matching
    - // thresholds, feature gates. The AI framing is a common use, not the limit.
    - //
    - // Run it:  node examples/pricing-rules.js
    - 
    - const { defineTrial, optimise } = require("../sdk");
    - 
    - // A stand-in for what you would compute from real order history. The tension
    - // is the ordinary one in pricing: a deeper discount converts more customers
    - // and earns less on each, and moving the threshold trades volume against the
    - // people who would have paid full price anyway.
    - function monthlyMargin(config) {
    -   const { tier1Discount, tier2Discount, tier2Threshold, freeShipping } = config;
    - 
    -   // How many of a notional 1000 baskets clear the second tier.
    -   const largeBaskets = Math.max(0, 420 - (tier2Threshold - 40) * 6);
    -   const smallBaskets = 1000 - largeBaskets;
    - 
    -   // Discount lifts conversion with diminishing returns.
    -   const smallConversion = 0.28 + Math.sqrt(tier1Discount) * 0.028;
    -   const largeConversion = 0.34 + Math.sqrt(tier2Discount) * 0.026;
    - 
    -   const smallValue = 32;
    -   const largeValue = tier2Threshold * 1.35;
    - 
    -   // Free shipping converts well and is a flat cost per order, so it pays on
    -   // large baskets and quietly bleeds margin on small ones.
    -   const shippingLift = freeShipping ? 0.05 : 0;
    -   const shippingCost = freeShipping ? 4.2 : 0;
    - 
    -   const smallMargin =
    -     smallBaskets *
    -     (smallConversion + shippingLift) *
    -     (smallValue * (1 - tier1Discount / 100) * 0.42 - shippingCost);
    - 
    -   const largeMargin =
    -     largeBaskets *
    -     (largeConversion + shippingLift) *
    -     (largeValue * (1 - tier2Discount / 100) * 0.38 - shippingCost);
    - 
    -   return smallMargin + largeMargin;
    - }
    - 
    - // Normalise to 0..1 against a margin nobody realistically beats, because the
    - // SDK wants a score rather than a currency amount.
    - const CEILING = 9000;
    - 
    - const trial = defineTrial({
    -   name: "checkout-discount-ladder",
    -   genes: {
    -     tier1Discount: { type: "int", min: 0, max: 25 },
    -     tier2Discount: { type: "int", min: 0, max: 40 },
    -     tier2Threshold: { type: "int", min: 40, max: 100 },
    -     freeShipping: { type: "bool" },
    -   },
    -   // What the shop runs today, chosen by somebody in a meeting.
    -   seed: {
    -     tier1Discount: 5,
    -     tier2Discount: 10,
    -     tier2Threshold: 75,
    -     freeShipping: false,
    -   },
    -   evaluate: async (config) => ({
    -     score: Math.max(0, Math.min(1, monthlyMargin(config) / CEILING)),
    -     evidence: { margin: Math.round(monthlyMargin(config)) },
    -   }),
    - });
    - 
    - async function main() {
    -   console.log("Trial: " + trial.name + "  (no model involved)");
    -   console.log("Configuration space: 26 x 41 x 61 x 2 = " + 26 * 41 * 61 * 2);
    -   console.log("");
    - 
    -   const run = await optimise(trial, { generations: 8 });
    - 
    -   // History records the child by id; the configuration itself lives on the
    -   // organism, so index the population to show what actually changed.
    -   const byId = new Map(run.population.map((o) => [o.id, o]));
    - 
    -   console.log("gen  parent -> child   fitness    margin   configuration");
    -   let best = run.founder.fitnessBps;
    -   for (const step of run.history) {
    -     if (step.outcome === "stillborn") continue;
    -     const improved = step.fitnessBps > best;
    -     if (improved) best = step.fitnessBps;
    -     const config = (byId.get(step.child) || {}).config || {};
    -     console.log(
    -       String(step.generation).padStart(3) +
    -         String(step.parent + " -> " + step.child).padStart(15) +
    -         String(step.fitnessBps).padStart(10) +
    -         String(Math.round(monthlyMargin(config))).padStart(10) +
    -         "   t1=" + config.tier1Discount + "%" +
    -         " t2=" + config.tier2Discount + "%" +
    -         " over " + config.tier2Threshold +
    -         " ship=" + config.freeShipping +
    -         (improved ? "   <- best so far" : "")
    -     );
    -   }
    - 
    -   const before = Math.round(monthlyMargin(run.founder.config));
    -   const after = Math.round(monthlyMargin(run.best.config));
    -   console.log("");
    -   console.log("current rules:  " + JSON.stringify(run.founder.config));
    -   console.log("  margin:       " + before);
    -   console.log("best found:     " + JSON.stringify(run.best.config));
    -   console.log("  margin:       " + after);
    -   console.log(
    -     "improvement:    " +
    -       (after - before) +
    -       " per thousand baskets, from " +
    -       run.population.length +
    -       " configurations evaluated"
    -   );
    - }
    - 
    - main().catch((error) => {
    -   console.error(error);
    -   process.exitCode = 1;
    - });
    + // Tuning a discount ladder. There is no model here at all. 
    + // 
    + // This example exists to make one thing unambiguous: Germline optimises 
    + // configuration, not prompts. If your product has knobs and you can measure 
    + // an outcome, it applies -- pricing rules, retry policy, cache TTLs, matching 
    + // thresholds, feature gates. The AI framing is a common use, not the limit. 
    + // 
    + // Run it:  node examples/pricing-rules.js 
    +  
    + const { defineTrial, optimise } = require("../sdk"); 
    +  
    + // A stand-in for what you would compute from real order history. The tension 
    + // is the ordinary one in pricing: a deeper discount converts more customers 
    + // and earns less on each, and moving the threshold trades volume against the 
    + // people who would have paid full price anyway. 
    + function monthlyMargin(config) { 
    +   const { tier1Discount, tier2Discount, tier2Threshold, freeShipping } = config; 
    +  
    +   // How many of a notional 1000 baskets clear the second tier. 
    +   const largeBaskets = Math.max(0, 420 - (tier2Threshold - 40) * 6); 
    +   const smallBaskets = 1000 - largeBaskets; 
    +  
    +   // Discount lifts conversion with diminishing returns. 
    +   const smallConversion = 0.28 + Math.sqrt(tier1Discount) * 0.028; 
    +   const largeConversion = 0.34 + Math.sqrt(tier2Discount) * 0.026; 
    +  
    +   const smallValue = 32; 
    +   const largeValue = tier2Threshold * 1.35; 
    +  
    +   // Free shipping converts well and is a flat cost per order, so it pays on 
    +   // large baskets and quietly bleeds margin on small ones. 
    +   const shippingLift = freeShipping ? 0.05 : 0; 
    +   const shippingCost = freeShipping ? 4.2 : 0; 
    +  
    +   const smallMargin = 
    +     smallBaskets * 
    +     (smallConversion + shippingLift) * 
    +     (smallValue * (1 - tier1Discount / 100) * 0.42 - shippingCost); 
    +  
    +   const largeMargin = 
    +     largeBaskets * 
    +     (largeConversion + shippingLift) * 
    +     (largeValue * (1 - tier2Discount / 100) * 0.38 - shippingCost); 
    +  
    +   return smallMargin + largeMargin; 
    + } 
    +  
    + // Normalise to 0..1 against a margin nobody realistically beats, because the 
    + // SDK wants a score rather than a currency amount. 
    + const CEILING = 9000; 
    +  
    + const trial = defineTrial({ 
    +   name: "checkout-discount-ladder", 
    +   genes: { 
    +     tier1Discount: { type: "int", min: 0, max: 25 }, 
    +     tier2Discount: { type: "int", min: 0, max: 40 }, 
    +     tier2Threshold: { type: "int", min: 40, max: 100 }, 
    +     freeShipping: { type: "bool" }, 
    +   }, 
    +   // What the shop runs today, chosen by somebody in a meeting. 
    +   seed: { 
    +     tier1Discount: 5, 
    +     tier2Discount: 10, 
    +     tier2Threshold: 75, 
    +     freeShipping: false, 
    +   }, 
    +   evaluate: async (config) => ({ 
    +     score: Math.max(0, Math.min(1, monthlyMargin(config) / CEILING)), 
    +     evidence: { margin: Math.round(monthlyMargin(config)) }, 
    +   }), 
    + }); 
    +  
    + async function main() { 
    +   console.log("Trial: " + trial.name + "  (no model involved)"); 
    +   console.log("Configuration space: 26 x 41 x 61 x 2 = " + 26 * 41 * 61 * 2); 
    +   console.log(""); 
    +  

Entry 2, examples/prompt-config.js:

    - // Tuning a retrieval-augmented support agent.
    - //
    - // This is the shape most teams are actually in. There are four knobs, they
    - // interact, and nobody has time to try 216 combinations by hand -- so the
    - // config that ships is whichever one someone tried on a Thursday.
    - //
    - // Run it:  node examples/prompt-config.js
    - //
    - // The evaluate() below stands in for what you would really do: replay a
    - // scored eval set, or shadow live traffic, and return how well the agent did.
    - // It is deterministic so the run reproduces exactly, which matters -- a
    - // lineage is only checkable if the measurement is repeatable.
    - 
    - const { defineTrial, optimise } = require("../sdk");
    - 
    - // A stand-in for a real eval harness. The interactions here are the point:
    - // deeper retrieval helps until it starts burying the answer in noise,
    - // reranking rescues deep retrieval but costs latency that shallow retrieval
    - // does not need, and an eager tool policy only pays off when the model is
    - // cool enough to follow instructions. No single knob has a best value on its
    - // own, which is exactly why one-at-a-time tuning finds the wrong config.
    - function scoreAgent(config) {
    -   const { retrievalDepth, rerank, temperature, toolPolicy } = config;
    - 
    -   // Recall rises with depth and then plateaus.
    -   let quality = 1 - Math.exp(-retrievalDepth / 4);
    - 
    -   // Past about six documents the answer starts drowning, unless a reranker
    -   // puts the right one back on top.
    -   if (retrievalDepth > 6) {
    -     quality -= rerank ? 0.02 * (retrievalDepth - 6) : 0.06 * (retrievalDepth - 6);
    -   }
    - 
    -   // Reranking a shallow set mostly reorders things that were already fine.
    -   if (rerank && retrievalDepth <= 3) quality -= 0.05;
    - 
    -   // Warmth helps phrasing and hurts faithfulness.
    -   quality += temperature === 0.3 ? 0.06 : temperature === 0.7 ? -0.08 : 0;
    - 
    -   // Eager tool use wins when the model follows the schema, which it stops
    -   // doing as temperature climbs.
    -   if (toolPolicy === "eager") quality += temperature <= 0.3 ? 0.09 : -0.12;
    -   if (toolPolicy === "never") quality -= 0.07;
    - 
    -   // Latency is part of quality for a support agent: a correct answer after
    -   // nine seconds is a worse product than a good one after two.
    -   const latency = retrievalDepth * 0.12 + (rerank ? 0.5 : 0) +
    -     (toolPolicy === "eager" ? 0.4 : 0);
    -   const penalty = Math.max(0, latency - 1.2) * 0.08;
    - 
    -   return Math.max(0, Math.min(1, quality - penalty));
    - }
    - 
    - const trial = defineTrial({
    -   name: "support-agent-rag",
    -   genes: {
    -     retrievalDepth: { type: "int", min: 1, max: 12 },
    -     rerank: { type: "bool" },
    -     temperature: { type: "choice", options: [0, 0.3, 0.7] },
    -     toolPolicy: { type: "choice", options: ["eager", "lazy", "never"] },
    -   },
    -   // Where most teams start: shallow retrieval, no reranker, no tools.
    -   seed: {
    -     retrievalDepth: 3,
    -     rerank: false,
    -     temperature: 0,
    -     toolPolicy: "never",
    -   },
    -   evaluate: async (config) => ({
    -     score: scoreAgent(config),
    -     evidence: { note: "synthetic eval set stand-in" },
    -   }),
    - });
    - 
    - async function main() {
    -   const combinations = 12 * 2 * 3 * 3;
    -   console.log("Trial: " + trial.name);
    -   console.log("Configuration space: " + combinations + " combinations");
    -   console.log("");
    - 
    -   const run = await optimise(trial, { generations: 8 });
    - 
    -   // History records the child by id; the configuration itself lives on the
    -   // organism, so index the population to show what actually changed.
    -   const byId = new Map(run.population.map((o) => [o.id, o]));
    - 
    -   console.log("gen  parent -> child   fitness   delta   configuration");
    -   let best = run.founder.fitnessBps;
    -   for (const step of run.history) {
    -     if (step.outcome === "stillborn") continue;
    -     const improved = step.fitnessBps > best;
    -     if (improved) best = step.fitnessBps;
    -     const config = (byId.get(step.child) || {}).config || {};
    -     console.log(
    -       String(step.generation).padStart(3) +
    -         String(step.parent + " -> " + step.child).padStart(15) +
    -         String(step.fitnessBps).padStart(10) +
    -         String(step.delta >= 0 ? "+" + step.delta : step.delta).padStart(8) +
    -         "   d=" + config.retrievalDepth +
    -         " rerank=" + config.rerank +
    -         " t=" + config.temperature +
    -         " tools=" + config.toolPolicy +
    -         (improved ? "   <- best so far" : "")
    -     );
    -   }
    - 
    -   console.log("");
    -   console.log("starting config: " + JSON.stringify(run.founder.config));
    -   console.log("  scored:        " + run.founder.fitnessBps + " bps");
    -   console.log("best found:      " + JSON.stringify(run.best.config));
    -   console.log("  scored:        " + run.best.fitnessBps + " bps");
    -   console.log(
    -     "improvement:     +" +
    -       (run.best.fitnessBps - run.founder.fitnessBps) +
    -       " bps, after evaluating " +
    -       run.population.length +
    -       " of " +
    -       combinations +
    -       " configurations"
    -   );
    - }
    - 
    - main().catch((error) => {
    -   console.error(error);
    -   process.exitCode = 1;
    - });
    + // Tuning a retrieval-augmented support agent. 
    + // 
    + // This is the shape most teams are actually in. There are four knobs, they 
    + // interact, and nobody has time to try 216 combinations by hand -- so the 
    + // config that ships is whichever one someone tried on a Thursday. 
    + // 
    + // Run it:  node examples/prompt-config.js 
    + // 
    + // The evaluate() below stands in for what you would really do: replay a 
    + // scored eval set, or shadow live traffic, and return how well the agent did. 
    + // It is deterministic so the run reproduces exactly, which matters -- a 
    + // lineage is only checkable if the measurement is repeatable. 
    +  
    + const { defineTrial, optimise } = require("../sdk"); 
    +  
    + // A stand-in for a real eval harness. The interactions here are the point: 
    + // deeper retrieval helps until it starts burying the answer in noise, 
    + // reranking rescues deep retrieval but costs latency that shallow retrieval 
    + // does not need, and an eager tool policy only pays off when the model is 
    + // cool enough to follow instructions. No single knob has a best value on its 
    + // own, which is exactly why one-at-a-time tuning finds the wrong config. 
    + function scoreAgent(config) { 
    +   const { retrievalDepth, rerank, temperature, toolPolicy } = config; 
    +  
    +   // Recall rises with depth and then plateaus. 
    +   let quality = 1 - Math.exp(-retrievalDepth / 4); 
    +  
    +   // Past about six documents the answer starts drowning, unless a reranker 
    +   // puts the right one back on top. 
    +   if (retrievalDepth > 6) { 
    +     quality -= rerank ? 0.02 * (retrievalDepth - 6) : 0.06 * (retrievalDepth - 6); 
    +   } 
    +  
    +   // Reranking a shallow set mostly reorders things that were already fine. 
    +   if (rerank && retrievalDepth <= 3) quality -= 0.05; 
    +  
    +   // Warmth helps phrasing and hurts faithfulness. 
    +   quality += temperature === 0.3 ? 0.06 : temperature === 0.7 ? -0.08 : 0; 
    +  
    +   // Eager tool use wins when the model follows the schema, which it stops 
    +   // doing as temperature climbs. 
    +   if (toolPolicy === "eager") quality += temperature <= 0.3 ? 0.09 : -0.12; 
    +   if (toolPolicy === "never") quality -= 0.07; 
    +  
    +   // Latency is part of quality for a support agent: a correct answer after 
    +   // nine seconds is a worse product than a good one after two. 
    +   const latency = retrievalDepth * 0.12 + (rerank ? 0.5 : 0) + 
    +     (toolPolicy === "eager" ? 0.4 : 0); 
    +   const penalty = Math.max(0, latency - 1.2) * 0.08; 
    +  
    +   return Math.max(0, Math.min(1, quality - penalty)); 
    + } 
    +  
    + const trial = defineTrial({ 
    +   name: "support-agent-rag", 
    +   genes: { 
    +     retrievalDepth: { type: "int", min: 1, max: 12 }, 
    +     rerank: { type: "bool" }, 
    +     temperature: { type: "choice", options: [0, 0.3, 0.7] }, 
    +     toolPolicy: { type: "choice", options: ["eager", "lazy", "never"] }, 
    +   }, 
    +   // Where most teams start: shallow retrieval, no reranker, no tools. 
    +   seed: { 
    +     retrievalDepth: 3, 
    +     rerank: false, 
    +     temperature: 0, 
    +     toolPolicy: "never", 
    +   }, 
    +   evaluate: async (config) => ({ 
    +     score: scoreAgent(config), 
    +     evidence: { note: "synthetic eval set stand-in" }, 
    +   }), 
    + }); 
    +  

## Anchors

| # | When | Covers | Chain | Transaction | Checked against chain | Log in 0G Storage |
|---|---|---|---|---|---|---|
| 3 | 2026-11-01T13:27:07.619Z | entries 0–2 | 16661 | [0x149f24bb…](https://chainscan.0g.ai/tx/0x149f24bbe5c5492e1977c937341450152c1c6f4f289f831355b3db1d044413f4) (registry #0) | yes | - |

## What this record supports

| Framework | Status | Based on this log |
|---|---|---|
| SOC 2 CC8.1 (change management) | Partial | Of 3 change(s): 2 give a reason or ticket, 0 record an approval, 0 carry test evidence, 2 link to a commit. Anchored in an append-only registry. |
| ISO/IEC 42001 (AI management system) | Missing | 0 of 3 change(s) record the evaluation behind them. Pass --score/--baseline/--suite or --eval-file to track to attach test evidence. |
| EU AI Act, Art. 12 and 19 (record-keeping, retention) | Partial | Relevant only to high-risk systems, and these articles cover operational logging, not only configuration. This log covers configuration changes: anchored on 0G Chain; the log itself is held only where it is kept. |

This is supporting evidence, not a compliance determination. Whether an organisation meets any of these is for its assessor to decide.

## How to verify this yourself

Use the log ID and anchorer address from your own records, not from this document. Pinning them is what makes a forged copy fail.

```bash
npx germline verify --log .germline/audit.jsonl --log-id <log ID from your records> --chain --anchorer <address from your records> --strict
```

Verification recomputes every hash locally and reads each anchor from 0G Chain. It needs no account and no trust in whoever produced this file. The browser verifier (web/verify.html) runs the same checks.
