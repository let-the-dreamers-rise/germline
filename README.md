# Germline

Germline is an optimisation layer you drop into an existing product. You
declare what can vary and how you measure better; it evolves the configuration
and hands back an improvement together with a record of how it got there that
anyone can check.

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

## What it is worth

The RAG example has 216 possible configurations. Brute-forcing all of them to
check the search honestly:

| | score | evaluations |
|---|---|---|
| starting configuration | 4576 | -- |
| Germline, 8 generations | 8333 | 45 |
| global optimum, exhaustive | 9269 | 216 |

Germline captures **80% of the available headroom for 21% of the evaluation
budget**. It does not find the global optimum -- its answer ranks 28th of 216
-- and that trade is the point rather than a shortfall. Evaluations are not
free: each one is a batch of model calls against a test set. Recovering most
of the gain for a fifth of the spend is the offer, and it improves as the
configuration space grows, because grid search grows exponentially and this
does not.

The integration surface is a function teams already own. Anyone far enough
along to care about tuning has already built an eval -- a scored test set, a
shadow replay, an offline judge. Germline needs exactly that and nothing else.
No data leaves, no model is replaced, nothing sits in the request path.

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

**Agentic ID (ERC-7857)** is what made this possible to think about: it gives
an agent an identity and a `clone()` primitive, which is reproduction in all
but name. Germline supplies the two things that turn copying into evolution.
An organism links to an Agentic ID via `linkAgenticId`.

To be explicit, because it would be easy to overstate: Germline does **not**
reimplement ERC-7857's oracle re-encryption on transfer. Organisms link to an
Agentic ID rather than replacing the standard.

## Quickstart

```bash
npm install
npx hardhat test                      # 45 tests
node examples/prompt-config.js        # tune a RAG agent, no chain needed
node examples/pricing-rules.js        # tune pricing rules, no model needed
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
