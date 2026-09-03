# Wave 3 submission

Everything here is ready to paste. Anything needing a real address or link is
marked `<<FILL AFTER DEPLOY>>`.

## Project name

**Germline**

## One-line description

> Germline is an optimisation layer for AI configuration: declare what can
> vary and how you measure better, and it evolves the config with a lineage
> anyone can verify.

28 words.

## Short summary

Germline is an optimisation layer that drops into an existing product. You
declare what can vary in your system -- retrieval depth, reranking,
temperature, tool policy, retry behaviour, pricing thresholds, any config --
and how you measure better. Germline evolves the configuration and returns an
improvement together with a record of how it got there that anyone can check.

It addresses two problems that are true of nearly every team shipping an AI
feature. A/B testing collapses past about three knobs while a real agent has
twenty, so the configuration that ships is whichever one someone happened to
try. And nobody can prove which version of an agent produced a given output,
which is becoming a compliance question rather than a hygiene one.

The mechanism is heredity that can be checked. A child configuration is
derived, not asserted: its mutation seed is
`keccak256(parentGenomeRoot, blockhash(requestBlock), parentId, ordinal)`, and
reproduction is commit-reveal, so the seed does not exist when the breeder
commits and cannot be ground for a flattering result. Anyone holding the
parent re-runs the mutation offline and compares against the child root stored
on chain. A forged lineage fails arithmetic rather than failing to be
believed. Selection is enforced on top of that: offspring are earned by
measured fitness, and the contract refuses to mint a child the parent has not
earned.

0G components used: **0G Chain** carries the registry, an ERC-721 on mainnet
chain 16661 where each token is a configuration with its parent, generation,
mutation seed, genome root and attested fitness. **0G Storage** holds the
configurations and fitness transcripts, with the chain carrying their roots.
**Agentic ID (ERC-7857)** is what made the design possible -- its `clone()`
primitive is reproduction in all but name -- and organisms link to an Agentic
ID via `linkAgenticId`. Germline does not reimplement ERC-7857 oracle
re-encryption; it links to the standard rather than replacing it.

Fitness is measured on real data: 9,955 object transitions recorded from live
ARC-AGI-3 agent runs, trained on the first half and scored on the second.
Selection climbs from 3148 to 4765 basis points in three generations, and the
configuration it finds is not the most complex one -- which is the whole
argument for automated search.

## AKINDO fields

| Field | Value |
|---|---|
| Project name | Germline |
| One-liner | see above, 28 words |
| GitHub | `<<FILL AFTER DEPLOY>>` public repo URL |
| 0G mainnet contract | `<<FILL AFTER DEPLOY>>` from `deployments/zerog.json` |
| 0G Explorer link | `https://chainscan.0g.ai/address/<<CONTRACT>>` |
| Demo video | `<<FILL AFTER RECORDING>>` YouTube or Loom, max 3 minutes |
| Frontend demo | `web/index.html`, or a deployed link if hosted |
| X post | `<<FILL AFTER POSTING>>` |

### Proof of 0G integration

Point judges at three things, in this order:

1. The contract on the explorer, showing real transactions: deployment,
   `Founded`, `SpawnRequested`, `Spawned` and `FitnessAttested` events.
2. `CHILD_ID=n npx hardhat run scripts/verify.js --network zerog`, which reads
   the lineage from chain and re-derives it locally.
3. `docs/STORAGE.md`, which states exactly what runs against 0G Storage and
   what falls back.

## X post

Both variants counted including tags and hashtags: variant A is 270
characters, variant B is 268. The limit is 280.

**Variant A, leads with the product:**

```
Germline: drop-in optimisation for AI config. Declare what varies and how you
score it, and it evolves the config with a lineage anyone can verify on 0G
mainnet.

RAG demo: 4576 to 8333, from 45 of 216 combinations.

#0GBridge #BuildOn0G @0G_labs @0G_Builders @AKINDO_io
```

**Variant B, leads with the mechanism:**

```
ERC-7857 can clone an AI agent. A clone is only a copy.

Germline adds heredity you can check: the mutation seed comes from a future
block hash, so a forged lineage fails arithmetic, not trust. Live on 0G
mainnet.

#0GBridge #BuildOn0G @0G_labs @0G_Builders @AKINDO_io
```

Attach a screenshot of the lineage viewer showing the fitness climb, or a
ten-second clip of `verify.js` accepting a genuine child and rejecting a
forged one.

## Demo video script, 3 minutes

Open with the problem, never with a code tour. Judges watch dozens of these.

**0:00-0:25 -- the problem.**
Open on the RAG example's gene list.

> "If you ship an AI agent, you have about twenty knobs and no way to tune
> them. A/B testing gives up after three. So the config you ship is whichever
> one somebody tried on a Thursday. And if a regulator asks which version
> produced a given answer, your evidence is a spreadsheet."

**0:25-0:55 -- the integration.**
Show `examples/prompt-config.js` on screen, then run it.

> "This is the whole integration. You declare what can vary, and how you
> measure better. Your evaluate function, your metric."

Let the generation-by-generation output scroll. Land on the last three lines:
4576 to 8333, 45 of 216 combinations evaluated.

**0:55-1:40 -- reproduction on mainnet.**
Run `scripts/breed.js`. Narrate the two steps while they happen.

> "Breeding is two transactions. The first commits to reproducing at a block
> that has not been mined yet. Only afterwards does the seed exist. That means
> the config it produces was not chosen by me -- I can accept the child or
> abandon it, and abandoning it is on the record."

Show the transactions landing on chainscan.

**1:40-2:20 -- verification, and this is the moment that matters.**
Run `CHILD_ID=n npx hardhat run scripts/verify.js --network zerog`.

> "Anyone with the parent config can re-run the mutation and check it against
> what the chain recorded."

It says genuine. Then show the forged case from `test/lifecycle.test.js`.

> "And here is a forged child. Same parent, same seed, a config it could not
> have produced. It fails arithmetic, not trust."

**2:20-2:50 -- the viewer.**
Open `web/index.html`. Pan the lineage tree, then hold on the fitness chart.

> "Just under ten thousand real recorded transitions behind this. It climbs
> from 3148 to 4765 in three generations -- and the config it finds is not the
> most complex one. Reading every feature buys accuracy and costs you ever
> seeing the same situation twice. Nobody would guess that by looking."

**2:50-3:00 -- close.**

> "Every improvement becomes an asset with a lineage attached. That is what
> Agentic ID is for, and it is what turns tuning into something you can own
> and sell."

## Pre-submission checklist

In execution order.

- [ ] `npx hardhat test` -- expect 45 passing
- [ ] `node examples/prompt-config.js` -- expect 4576 to 8333
- [ ] `node examples/pricing-rules.js` -- expect a margin improvement
- [ ] `cp .env.example .env` and add `DEPLOYER_KEY`
- [ ] `npx hardhat run scripts/preflight.js --network zerog` -- confirms chain
      16661 and reports the balance. Costs nothing. Needs about 0.03 0G for
      the full demo.
- [ ] `npx hardhat run scripts/deploy.js --network zerog` -- writes
      `deployments/zerog.json`. **Copy the address.**
- [ ] `npx hardhat run scripts/found.js --network zerog`
- [ ] `npx hardhat run scripts/breed.js --network zerog`, several times
- [ ] `CHILD_ID=2 npx hardhat run scripts/verify.js --network zerog`
- [ ] `npx hardhat run scripts/status.js --network zerog`
- [ ] Paste the contract address into `web/index.html`, open it, screenshot
      the lineage and fitness chart
- [ ] Push the repo public; confirm the README renders
- [ ] Record the video, 3 minutes maximum
- [ ] Post on X with the screenshot, both hashtags and all three tags
- [ ] Fill every `<<FILL AFTER DEPLOY>>` above
- [ ] Submit on AKINDO before 20:30
