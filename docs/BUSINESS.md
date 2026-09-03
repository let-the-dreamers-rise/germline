# Business

Short, and honest about which parts are measured and which are assumptions.

## The wedge

Germline does not ask a team to adopt a platform. It asks for a function they
already have.

Any team far enough along to care about tuning has already built an eval: a
scored test set, a shadow-traffic replay, an offline judge. That function is
the expensive part and they own it. Germline is a thin layer on top of it:

```js
evaluate: async (config) => ({ score: await runEvalSet(config) })
```

That is the entire integration surface. No data leaves, no model is replaced,
no vendor sits in the request path. The teams who feel the tuning pain most
sharply are exactly the teams who already have the one thing Germline needs,
which is a rare alignment for a developer tool.

## What it is worth, measured

From `examples/prompt-config.js`, a four-knob RAG agent with 216
configurations. Brute-forcing the whole space to check the search honestly:

| | score | evaluations |
|---|---|---|
| starting configuration | 4576 | -- |
| Germline, 8 generations | 8333 | 45 |
| global optimum, exhaustive | 9269 | 216 |

Germline captures **80% of the available headroom for 21% of the evaluation
budget**. It does not find the global optimum -- its result ranks 28th of 216
-- and pretending otherwise would be the kind of claim that falls apart in
front of a customer.

That trade is the product. Evaluations are not free: each one is a batch of
model calls against a test set, and a serious eval suite costs real money per
run. A method that recovers most of the gain for a fifth of the spend is worth
paying for, and it gets more worth paying for as the configuration space grows,
because grid search grows exponentially and evolutionary search does not.

## How it makes money

The split is already built into the code, which is why it is credible rather
than aspirational: `optimise()` runs entirely locally unless you hand it a
contract and a signer.

**Free, local.** Define a trial, run the search, get a better configuration.
No wallet, no account. This is the whole product for a solo developer, and it
is what earns the right to charge for anything.

**Paid, usage-based.** Charge per evaluation orchestrated, in the way CI is
billed per minute. It scales with the value delivered, it is legible on an
invoice, and a customer who runs more searches is a customer getting more out
of it.

**Paid, provenance.** The verifiable lineage is the tier that needs the chain:
an auditable record that a customer's own customer can check without trusting
either of them. This is where regulated deployments live, and it is the part
no single-tenant tool can offer, because the whole point is that the vendor is
not the one attesting.

*Speculative:* the specific price points. I have measured the value ratio, not
what anyone will pay for it.

## Why it compounds

Two effects, one near and one further out.

**A corpus of what actually works.** Every trial produces (configuration,
measured outcome) pairs. Across many customers that becomes a prior worth
having -- which knobs matter, where the interactions are, what a sensible
starting point looks like for a RAG agent versus a retrieval pipeline. A
single-tenant tool cannot build this. Germline's own reference trial already
demonstrates the kind of finding it produces: the fittest configuration is not
the most complex one, which nobody would guess by inspection.

**Configurations become assets.** A configuration with a verified track record
is worth something, and via Agentic ID it can be owned and transferred. That
turns an optimisation tool into a market: a proven config has a price and a
lineage a buyer can check. This is the reason to be on a chain at all rather
than in a database.

*Speculative:* the marketplace. The primitives are built and the registry
works, but no one has bought or sold a configuration, and a market needs both
sides.

## Who buys first

1. **Teams shipping LLM agents who already run evals.** They have the eval
   function, they have more knobs than they can test, and they know it. This
   is the beachhead and the only one that matters at first.
2. **Regulated or high-stakes deployments.** Finance, health, anything where
   "which version produced this output" is a question someone external asks.
   They buy the provenance tier, and they are the ones for whom a vendor
   dashboard is not evidence.
3. **Platforms with tunable customer-facing config.** The pricing example is
   deliberately not an AI system: recommendation weights, matching thresholds,
   discount ladders, retry policies. Same shape, no model required.

## Honest competitive picture

Programmatic prompt optimisation exists. Eval platforms exist. Hyperparameter
search is decades old and evolutionary search over configurations is not a new
idea. If the pitch were "we optimise your config", the correct response would
be that several people already do.

What is different here is not the search. It is that the result carries a
record anyone can verify without trusting the party that produced it, and that
the result is an ownable asset rather than a row in someone's database. The
search is table stakes; the provenance is the product.

The honest risk is that provenance turns out to be a nice-to-have rather than
a requirement, in which case Germline is competing on search quality alone
against incumbents with more data. The bet is that "prove which version did
this" becomes mandatory rather than optional, and that bet is not yet won.

## What would prove this out

In rough order, and none of it is done:

- One real team running one real eval through the SDK, and a number for how
  much their configuration improved.
- A second independent trial on the same organism, so an attested score stops
  being a single opinion.
- Decentralised attestation, so the curator role stops being one address.
- One configuration changing hands with its lineage intact.
