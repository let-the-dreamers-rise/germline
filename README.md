# Germline

### Tune your AI's settings automatically. Prove how you got there.

Your agent has twenty knobs and you tuned three of them. Germline turns the
rest, using the eval you already have, and hands back a configuration that
scores higher -- with a receipt anyone can check without taking your word
for it.

```js
const { defineTrial, search } = require("germline");

const trial = defineTrial({
  name: "support-agent",
  genes: {
    retrievalDepth: { type: "int", min: 1, max: 20 },
    rerank: { type: "bool" },
    temperature: { type: "choice", options: [0, 0.2, 0.7] },
  },
  evaluate: async (config) => ({ score: await runEvalSet(config) }),
});

const run = await search(trial, { budget: 40 });
run.best.config;      // ship this
run.verdict.winner;   // and here is whether it actually beat random
```

That is the whole integration. No wallet, no account, no data leaving your
machine, nothing in your request path. Sixty seconds from `npm install` to a
better configuration.

On a real system -- the world model of an agent that plays ARC-AGI-3 -- it
took a configuration scoring 3148 to one scoring 4765, and the answer it found
is one a competent engineer would not have guessed. Details below.

Turn on provenance when you need to show someone. That part uses 0G Chain, and
it is the reason a chain is involved at all: a customer verifies the record
themselves rather than trusting the vendor who produced it.

```js
const { defineTrial, optimise } = require("germline");

const trial = defineTrial({
  name: "support-agent-v3",
  genes: {
    retrievalDepth: { type: "int", min: 1, max: 12 },
    rerank: { type: "bool" },
    temperature: { type: "choice", options: [0, 0.3, 0.7] },
    toolPolicy: { type: "choice", options: ["eager", "lazy", "never"] },
  },
  evaluate: async (config) => ({ score: await runEvalSet(config) }),
});

const run = await optimise(trial, { generations: 8 });
```

That is the whole integration. `evaluate` is yours -- an offline eval set,
a shadow-traffic replay, a live metric window. Germline never needs to know
what your system does, only how to score it.

## The problem

Two things are true of nearly every team shipping an AI feature.

**A/B testing collapses past about three knobs.** A real agent has twenty:
retrieval depth, reranking, temperature, chunk size, tool policy, retry
behaviour, model choice. The combinations run to the thousands and nobody has
time, so the configuration that ships is whichever one someone tried on a
Thursday. The example in `examples/prompt-config.js` is deliberately mild --
four knobs, 216 combinations -- and the starting configuration still scores
4576 against 8333 for the one Germline finds after evaluating 45 of them.

**Nobody can prove which version produced a given output.** Model and prompt
versioning is mostly a spreadsheet and a good memory. That is becoming a
compliance question rather than a hygiene one, and a vendor's own dashboard is
not evidence: it is the vendor asserting something about itself.

## What Germline does not claim

An earlier version of this README said the search captured 80% of the
available headroom for 21% of the evaluation budget. Both numbers were true.
The claim was still wrong, because nobody had asked what random sampling does
with the same budget. It wins, almost always:

```
landscape                  space budget  sampled  evolution  random   winner
synthetic, smooth            216     45   20.83%       7821    9159   random
synthetic, rugged            216     45   20.83%       5225    9500   random
ARC corpus, real data       6144     38    0.62%       4865    4765   evolution
```

Run it yourself: `node scripts/benchmark.js`.

The deciding variable is the **sampled** column, not the size of the space.
When you can afford to try a fifth of every possible configuration, drawing at
random is close to optimal and no selection machinery earns its keep. At well
under one percent -- which is what a real configuration space looks like, and
the only row above built on real recorded data -- selection is ahead.

So Germline does not sell a better optimiser. **It sells a verifiable record
of whatever search you ran.** The provenance layer is identical either way,
and `search()` ships with the random control built in:

```js
const run = await search(trial, { budget: 40 });
run.verdict.winner   // 'search' | 'random' | 'tied'
run.baseline.median  // what random achieved on the same budget
```

If random wins on your space, use `strategy: 'random'` and keep the lineage.
A tool that tells you not to use its own headline feature is more useful than
one that does not, and the control runs by default so this claim cannot
quietly rot again.

## What it is worth

The integration surface is a function teams already own. Anyone far enough
along to care about tuning has already built an eval -- a scored test set, a
shadow replay, an offline judge. Germline needs exactly that and nothing else.
No data leaves, no model is replaced, nothing sits in the request path.

What it adds is a record: which configuration, derived from which parent,
under a seed nobody could choose, scoring what, against evidence anyone can
recompute. That is the part no eval platform gives you and no dashboard can
substitute for, because the whole point is that the vendor is not the one
asserting it.

See `docs/BUSINESS.md` for the model, including which parts are measured and
which are still assumptions.

## What Germline does about it

Two mechanisms. The first makes the record checkable, the second stops the
search wasting itself on configurations that do not work.

### Heredity is verifiable

A child configuration is derived, not asserted. Its mutation seed is fixed by
the chain rather than by whoever is breeding:

```
seed = keccak256(parentGenomeRoot, blockhash(requestBlock), parentId, ordinal)
```

Reproduction is therefore two steps. `requestSpawn` commits to breeding at a
block whose hash does not exist yet; `spawn` reveals the child afterwards.
Because the seed is unknowable at the moment of commitment, a breeder cannot
grind through seeds looking for a flattering mutation -- the only choices are
to accept the child or abandon the attempt, and abandoning it is recorded.

Anyone holding the parent configuration can re-run the mutation offline and
compare against the child root stored on chain:

```
CHILD_ID=7 npx hardhat run scripts/verify.js --network zerog
```

A forged lineage fails arithmetic rather than failing to be believed. There is
a test for exactly this: `test/lifecycle.test.js` breeds an honest child, has
`verify` accept it, then presents a forged child whose genome root does not
match its recorded seed and confirms it is rejected.

### Selection is enforced

Reproduction is not a right. An organism earns offspring by measured fitness,
and the contract will not mint a child the parent has not earned. Below the
survival threshold a configuration leaves no descendants and its line ends.

```
allowance = baseFecundity + (score - survivalThreshold) / fecundityStep
```

The survival threshold is not a matter of taste. It is set to the score of a
predictor that uses nothing at all, so a configuration must be at least as
useful as having no model.

Base fecundity is measured too. At one offspring per viable organism the
simulated lineage dies at generation one on its first unlucky mutation, which
is what mutations usually are. Four attempts is the minimum that lets
selection actually choose.

## The reference trial is a real system

The examples in `examples/` are illustrations and say so. The reference trial
is not. Its genes are the actual configuration of the world model in an agent
that plays ARC-AGI-3 and is scored on a public leaderboard -- from
`arc_agent/lawbook.py`, gene for gene:

```
RING = ((-1,0),(1,0),(0,-1),(0,1))          ->  useRing, ringSides
ident = (obj["colour"], obj["size"])        ->  useColour, useSize
momentum = prior_momentum.get(ident, "0")   ->  useMomentum
if len(seen) != 1: return None              ->  unanimousOnly
```

That agent's world model was tuned by hand, and its author concluded momentum
mattered more than the neighbourhood ring -- which is the counterintuitive
answer. Starting from a configuration that reads nothing, the search reaches
the same conclusion unaided.

It is dogfooding rather than independent validation: the same person built
both. See `docs/DOGFOOD.md`, which says exactly what it does and does not
show.

## How fitness is measured

The reference trial is real rather than synthetic. It uses 9,955 object
transitions recorded from live ARC-AGI-3 agent runs, shipped in
`engine/trial/`. A configuration selects which context a predictor may use.
It is built from the first half of the corpus in recorded order and scored on
the second, which it has never seen.

A predictor may abstain, and abstention needs to be worth something or a
cautious configuration is punished for its caution. But silence cannot be free
either, or the fittest organism is the one that never speaks. So the whole
agent is scored rather than the model alone: where the model abstains, the
agent falls back to the baseline guess it would have made anyway.

The fallback is credited **per row**, not on average. That distinction
matters. Crediting the average pays a configuration for ducking exactly the
rows the baseline also fails, and a predictor that abstained everywhere would
then outscore the baseline it was falling back on.

### The measured landscape

| configuration | fitness | coverage | accuracy |
|---|---|---|---|
| momentum alone | **4765** | 0.74 | 0.617 |
| colour+size+ring+momentum | 4663 | 0.41 | 0.801 |
| all + unanimous + backoff | 4602 | 0.32 | 0.808 |
| all + unanimous | 4325 | 0.22 | 0.904 |
| colour+size+ring | 4148 | 0.51 | 0.592 |
| ring only | 3935 | 0.58 | 0.486 |
| colour+size | 3821 | 0.61 | 0.514 |
| action only (founder) | 3148 | 0.94 | 0.333 |

The fittest configuration is not the most complex one. Reading every feature
buys accuracy at the cost of ever seeing the same context twice: the
everything-on configuration answers 41% of the time at 0.801, while momentum
alone answers 74% of the time at 0.617 and beats it.

Nobody would guess that by inspection, and that is the entire argument for
automated search. Selection finds it unaided, climbing 3148 to 4765 in three
generations.

## Which parts of 0G are used

**0G Chain** carries the registry. `contracts/Germline.sol` is an ERC-721
where each token is a configuration with its parent, generation, mutation
seed, genome root and attested fitness. Mainnet, chain 16661. The contract
compiles to 11,381 bytes and deploys for about 0.0095 0G.

**0G Storage** holds the configurations themselves and the fitness
transcripts, with the chain carrying their roots. The read path runs against
the live mainnet gateway and is verified -- `node scripts/storage-check.js`
probes it, round-trips a payload, and confirms an unknown root comes back as a
miss. Writing goes through the official `0g-storage-client`, because uploading
is an on-chain submission to the Flow contract rather than an HTTP POST; the
endpoint a web search reports for that purpose returns 404, which is why it
was probed rather than trusted.

An object's identity is the keccak256 of its canonical JSON, computed locally,
so verification never depends on any network being reachable. `docs/STORAGE.md`
records every probe and its response.

**0G Compute** scores the trials that arithmetic cannot. Whether a summary
kept the facts or a support answer was correct is a judgement, and judgement
is what an eval harness actually spends its money on. `lib/compute.js` talks
to the Compute Router at `https://router-api.0g.ai/v1`, which is
OpenAI-compatible and serves 32 models including 0G Foundation's own
`0gm-1.0-35b-a3b`. `makeJudge()` turns that into a drop-in `evaluate()`; see
`examples/llm-judge.js` and prove the router is live with
`node scripts/compute-check.js`.

Compute deliberately sits inside `evaluate()` and not inside `mutate()`. The
obvious idea is to have a model propose the next mutation, and it is the wrong
one: a child must be re-derivable from its parent and the on-chain seed, and a
model's output is not reproducible. Fitness may be measured by a model.
Heredity may not be invented by one.

**Agentic ID (ERC-7857)** is what made this possible to think about: it gives
an agent an identity and a `clone()` primitive, which is reproduction in all
but name. Germline supplies the two things that turn copying into evolution.
An organism links to an Agentic ID via `linkAgenticId`.

To be explicit, because it would be easy to overstate: Germline does **not**
reimplement ERC-7857's oracle re-encryption on transfer. Organisms link to an
Agentic ID rather than replacing the standard.

## Quickstart

Use it in your own project:

```bash
npm install github:<your-org>/germline
```

```js
const { defineTrial, search } = require("germline");

const trial = defineTrial({
  name: "my-agent",
  genes: { depth: { type: "int", min: 1, max: 20 }, rerank: { type: "bool" } },
  evaluate: async (config) => ({ score: await runEvalSet(config) }),
});

const run = await search(trial, { budget: 40 });
run.best.config       // the configuration to ship
run.verdict.winner    // 'search' | 'random' | 'tied'  -- run it before you trust it
```

Or work on it directly:

```bash
npm install
npm test                  # 45 tests
npm run bench             # the search against its random control
npm run example:rag       # tune a RAG agent, no chain needed
npm run example:pricing   # tune pricing rules, no model needed
npm run check:storage     # prove the 0G Storage gateway is live
npm run check:compute     # prove the 0G Compute router is live
```

To put a lineage on 0G mainnet:

```bash
cp .env.example .env                  # add DEPLOYER_KEY
npx hardhat run scripts/preflight.js --network zerog    # costs nothing
npx hardhat run scripts/deploy.js    --network zerog
npx hardhat run scripts/found.js     --network zerog
npx hardhat run scripts/breed.js     --network zerog
CHILD_ID=2 npx hardhat run scripts/verify.js --network zerog
npx hardhat run scripts/status.js    --network zerog
```

Then open `web/index.html` to see the lineage and the fitness climb. It is a
single static file with no build step; pass `?address=0x...` or edit the
config block at the top.

`preflight` is worth running first. It confirms the RPC is the chain it claims
to be, prices the deployment from the real compiled bytecode, and tells you
whether the account can afford the run -- all read-only.

## The chain is optional

`optimise()` runs entirely locally unless you give it a contract and a signer.
A team can try Germline in a minute with no wallet, and turn on provenance
later when they need to show someone. That is a deliberate product decision:
requiring a wallet before the first useful result would put the interesting
part behind the boring part.

## Limitations

Stated plainly, because the edges matter more than the pitch.

- **The curator role is centralised.** Founding organisms and appointing
  attestors currently sit with one address. Decentralising attestation is the
  obvious next step and is not done.
- **Fitness comes from one trial.** The ARC corpus is real, but a single trial
  is a single opinion. Multiple independent trials per organism would make an
  attested score much harder to game.
- **An attestor is trusted to report honestly.** The evidence root makes a
  score reproducible by anyone who fetches the transcript, so dishonesty is
  detectable after the fact -- but it is not prevented at the point of writing.
- **0G Storage upload is opt-in and untested end to end.** Reading is verified
  against the live mainnet gateway. Writing routes through the official client
  and needs a funded key, so it is behind `ZEROG_STORAGE_UPLOAD=1` rather than
  spending gas on every spawn. Without it, payloads are stored locally and say
  so. Roots stay valid either way.
- **No ERC-7857 oracle transfer.** As above: linkage, not reimplementation.
- **Search is not guaranteed to find the global optimum.** It is an
  evolutionary search over a combinatorial space, and eight generations on the
  RAG example covers 45 of 216 configurations. It finds a good one, reliably,
  far faster than a person would.

## Repository

```
contracts/Germline.sol     the registry: lineage, seeds, fitness, selection
sdk/                       defineTrial and optimise -- the public API
engine/                    the reference trial and its measured fitness
examples/                  a RAG agent and a pricing ladder
scripts/                   preflight, deploy, found, breed, verify, status
lib/                       chain access, genome cache, storage publication
web/index.html             lineage viewer, single file, no build step
test/                      45 tests
```
