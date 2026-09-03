# SDK

Germline needs one thing from your product: a function that scores a
configuration. Everything else is optional, including the chain.

## The whole API

```js
const { defineTrial, optimise } = require("germline");

const trial = defineTrial({
  name: "support-agent-v3",
  genes: { /* what can vary */ },
  seed: { /* what you run today, optional */ },
  evaluate: async (config) => ({ score, evidence }),
});

const run = await optimise(trial, { generations: 8 });
```

`run` gives you `best`, `founder`, `population` and `history`. `best.config` is
the configuration to ship; `history` is the generation-by-generation record of
how it was found.

## Gene types

| type | declaration | mutates by |
|---|---|---|
| `bool` | `{ type: 'bool' }` | flipping |
| `int` | `{ type: 'int', min: 1, max: 12 }` | stepping one, clamped |
| `choice` | `{ type: 'choice', options: [0, 0.3, 0.7] }` | moving to another option |
| `mask` | `{ type: 'mask', bits: 4 }` | flipping one bit |

Use `mask` when a gene is a set rather than a value -- which four sides of a
neighbourhood to read, which of six tools to enable. Flipping one bit at a
time lets a set be acquired a member at a time instead of being redrawn.

A gene declaration is a contract. Adding, removing or reordering genes changes
what a configuration hash means, so an existing lineage cannot be extended
across a schema change -- start a new trial instead.

## Writing `evaluate`

This is where nearly all the value and nearly all the difficulty sits. Return
a `score`; anything in `0..1` is treated as a fraction and anything above as
basis points.

```js
evaluate: async (config) => {
  const results = await runEvalSet(config);
  return { score: results.passRate, evidence: { n: results.total } };
}
```

Three honest choices for where the score comes from.

**An offline eval set.** Cheapest and most reproducible: a fixed set of cases
with known-good answers. The failure mode is that you optimise for the eval
rather than for production, and the two drift apart quietly.

**Shadow-traffic replay.** Replay recorded real requests against the candidate
configuration and score the outputs. More faithful, more expensive, and needs
a judge -- often a model, which brings its own noise.

**A live metric window.** Ship the configuration to a slice of traffic and
read conversion or resolution rate. Most faithful and by far the slowest: each
evaluation costs days, so generations are measured in weeks.

Most teams should start offline and graduate. Germline does not care which you
pick, but it will faithfully optimise whatever you actually measure, including
the wrong thing.

## Determinism matters more than it looks

`evaluate` should be deterministic for a given configuration. If it is noisy,
selection will happily promote a configuration that got lucky once, and the
lineage will record that luck as if it were a finding.

If your measurement is inherently noisy, average over enough samples inside
`evaluate` that the noise is small relative to the differences you care about.
That cost is real and it is the honest price of a trustworthy lineage.

A throwing `evaluate` is contained: the configuration is treated as unfit
rather than killing the run, so one bad candidate cannot end a search.

## Scoring, and why abstention is handled the way it is

If your system can decline to answer, score the whole system rather than the
model alone. Credit a declined case with whatever your fallback would have
done **on that specific case**, not with the fallback's average.

The distinction is not pedantic. Crediting the average pays a configuration
for ducking exactly the cases the fallback also fails, and a system that
declined everything would then outscore the fallback it was declining to. The
reference trial in `engine/fitness.js` does it per case for this reason.

## Turning on provenance

```js
const run = await optimise(trial, {
  generations: 8,
  chain: { contract, signer },   // both required, or neither
});
```

Without `chain`, everything runs locally and nothing is recorded anywhere. With
it, each organism is minted on 0G Chain with its parent, generation, mutation
seed and attested fitness, and configurations and transcripts are published
via `lib/storage.js`.

The chain is optional on purpose. Requiring a wallet before the first useful
result would put the interesting part behind the boring part, so local search
is free and provenance is something you switch on when you need to show
someone.

On-chain reproduction is commit-reveal and therefore takes two transactions
separated by at least one block. Budget roughly 0.003 0G per organism.

## Reference trial

`sdk/trials/arc.js` is the ARC world-model trial, built with `defineTrial` like
any other. It is deliberately an instance of the public API rather than a
special case: if the reference trial needed private access, the API would not
be finished.

```js
const arc = require("germline/sdk/trials/arc");
const run = await optimise(arc, { generations: 8 });
```

It scores against 9,955 real object transitions recorded from live ARC-AGI-3
agent runs, and climbs from 3148 to 4765 basis points in three generations.

## Worked examples

```bash
node examples/prompt-config.js   # a RAG agent, four interacting knobs
node examples/pricing-rules.js   # a discount ladder, no model involved
```

The second one exists to make the scope unambiguous. Germline optimises
configuration. AI systems are the common case, not the boundary.
