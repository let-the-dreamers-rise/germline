# Germline

### Change control for AI agents and AI config. Recorded, anchored on 0G or BOT Chain, and enforceable on chain.

An AI agent is only as trustworthy as what it's told to do: its system
prompt, model, tool list and limits. Those change every week, usually with no
record anyone else can check. For an agent that moves money, a quiet change
(`maxTradeUsd 100 → 100000`) is a rug pull that leaves no trace on chain. For
a team shipping LLM features, it's the question their SOC 2 auditor, an
enterprise security review or the EU AI Act will ask: *what was live on 14
March, who changed it, why, and what testing justified it?*

Germline answers both, in three layers:

- **Record.** A GitHub Action logs one entry per commit that touches a
  prompt or agent config. Each entry holds the author, who approved the pull
  request (from GitHub's API), the commit message and ticket, the exact setting
  that moved, and any eval score.
- **Anchor.** The log is hash-chained, and its head is anchored on 0G Chain in
  an ownerless, append-only registry, so even whoever holds the file can't
  rewrite it. Anyone can check it without trusting you or us.
- **Enforce.** `GermlineGuard` is a timelock on an agent's config: a vault
  calls `guard.check(head)`, so every published change pauses the agent for a
  set delay while depositors read it and decide whether to stay.

```bash
npx germline demo     # one minute: record, verify, tamper, get caught
npm run demo:agent                                 # in a clone: the agent timelock on a local chain
```

## For on-chain AI agents

An agent's config changes while it runs: an operator raises a limit, the agent
falls back to another model, a tool call rewrites its prompt. `watchAgent`
records each change the moment it takes effect and anchors the log from the
agent's own wallet, with nobody pressing a button:

```js
const { watchAgent } = require("germline");
const audit = watchAgent({ system: "support-agent", signer: agentWallet }); // e.g. on BOT Chain
const create = audit.wrap((params) => openai.chat.completions.create(params));
await create({ model, temperature, messages, tools }); // a changed model, prompt, sampling or tool list is recorded first
```

Changes are recorded before the call they govern and anchored in batches
(within a minute, or after 10 changes). `node examples/agent-runtime.js` runs
it end to end; [docs/AGENT-RUNTIME.md](docs/AGENT-RUNTIME.md) has the options.

`init` picks up ElizaOS characters, `SOUL.md` and `mcp.json` tool lists along
with ordinary prompt and config files. `contracts/GermlineGuard.sol` and the
`onlySettledConfig(head)` modifier gate any function on a settled config, and
`germline head` gives the agent the head to claim.
[docs/AGENTS.md](docs/AGENTS.md) has the setup and is precise about what the
guard can and can't prove. `npm run demo:agent` plays the whole story on a
local chain: an agent trades, its operator raises its limit, the guard pauses
it, and the owner withdraws.

## Five-minute setup

In the repository that holds your prompts and AI config:

```bash
npx germline init   # finds prompt/config files, writes the workflow
git add .germline .github && git commit -m "Track AI config with germline" && git push
```

That is the setup. On the first push, the GitHub Action backfills one entry
per past commit that touched those files. After that, it records each new
commit as it lands. The log goes on its own `germline-audit` branch, so a
protected `main` needs no bot bypass. There's no wallet, no account, no SDK
in your request path, and no before/after files to assemble.

To anchor on 0G, add a funded 0G key as the repository secret
`GERMLINE_ANCHOR_KEY`. A few cents of 0G covers months of anchors. Until you
add it, the log is still recorded and verified on every push. It just isn't
pinned on chain yet, and the evidence pack says so.

Or skip the key entirely: with **hosted anchoring** Germline anchors from its
own key and pays the gas. On GitHub Actions you set one repository variable
and store no secret, because the run proves which repository it is with
GitHub OIDC. Your auditor pins Germline's address, which you can't sign for. Only the log
id, entry count and head hash leave your repository. See
[docs/HOSTED.md](docs/HOSTED.md).

Write down the log ID that `npx germline id` prints, and give it to your
auditor out of band. That one value is what makes a rewritten copy fail.

## What the auditor gets

```bash
npx germline report --out evidence.md          # Markdown evidence pack
npx germline report --format cc81 --out cc81.csv     # SOC 2 CC8.1 sample rows for Vanta, Drata or DSALTA
npx germline verify --log-id 0x… --chain --anchorer 0x… --strict
```

Or drop `audit.jsonl` into the [browser verifier](web/verify.html). It runs
the same checks locally, including against 0G Chain, and uploads nothing.
A link of the form `verify.html?log=<https URL of audit.jsonl>&logId=…&anchorer=…&registry=…`
verifies a published log in one click.

This repository runs Germline on itself. `.github/workflows/germline.yml`
records, reviews and anchors each change to the example prompts in
`examples/`, and the log is on the `germline-audit` branch.

It is anchored on 0G mainnet. Log ID
`0x6c968bafaffe4ad49d730e56626ee47c951c96d0254f4ecb76137ed0bdce6891`, anchorer
`0xA1918A4E578babad074ACf7DCefB152f8FDC8D2E`. A fresh install to its first
anchor took 86 seconds.

The pack opens with the integrity result, lists each change with its author,
reason, commit and test evidence, and maps the record to EU AI Act Art. 12
and 19, SOC 2 CC8.1 and ISO/IEC 42001. That mapping is built from what the
log actually contains. Where there's no anchor or no eval evidence, it says
"Not yet" rather than claiming coverage.

## Attaching test evidence

In the job that runs your evals:

```bash
npx germline track --score 0.91 --baseline 0.84 --suite refunds-v4
npx germline track --eval-file eval-results.json
```

If your config lives in code rather than in files:

```js
const { openAuditLog } = require("germline");
openAuditLog().track("support-agent", config, { reason: "deploy " + process.env.GIT_SHA });
```

`track()` records only when the config actually changed, so it is safe to call on every start-up.

## Why the record holds up

- **Hash chain.** Each entry carries the hash of the one before it, and each
  line must be the canonical bytes of its value. One edited byte fails
  `verify`, offline.
- **Anchored on 0G Chain.** The head goes into `GermlineAnchor`, an
  append-only registry with no owner, no admin and no upgrade path. Each
  anchor ever made stays readable, so truncating or rewriting the log after
  an anchor is caught, and so is hiding the anchor.
- **Pinned by the verifier, not the file.** The log ID and anchorer address
  come from the auditor's own records. A forger who controls the whole file
  still can't produce a copy that matches them.
- **Copy on 0G Storage.** `anchor --upload` publishes the log through the
  official 0G Storage SDK and records its root on chain. An auditor can then
  fetch it without asking you for it.
- **Redaction.** For each change, `--redact` (or `"redact": true` in the
  config) keeps only per-setting hashes. Reviewers see *which* setting moved,
  not its value. `anchor --upload` refuses to publish unredacted prompts to
  0G Storage, which is public, unless you pass `--allow-public`.
- **CI-safe.** The action pushes the log before it anchors. It retries when
  another push lands first, and it runs one job at a time. An anchor can
  only ever cover entries that are on the branch.

[SECURITY.md](SECURITY.md) lists every attack the format catches, with the
test that proves each one, and the ones it does not catch.
[docs/AUDIT.md](docs/AUDIT.md) covers the format, the CI setup, and branch
protection.

## What it is not

- Germline doesn't make you compliant. It produces evidence for one
  control, change management of AI behaviour. Your assessor decides the rest.
- It doesn't authenticate commit authors. Git lets anyone write any name.
  The approval comes from GitHub's API and is authenticated; the author line
  is only what git says. Signed entries are on the roadmap.
- It doesn't log inference traffic. LangSmith and Langfuse record what the
  model said. Germline records what the model was *configured* to do, and
  makes that record impossible to quietly rewrite.

## How 0G is used

- **0G Chain** holds the anchors. `GermlineAnchor` is live on 0G mainnet at
  [`0x18713A7ED60576C68B2CfE30D18839521a23cBcd`](https://chainscan.0g.ai/address/0x18713A7ED60576C68B2CfE30D18839521a23cBcd)
  (`contracts/GermlineAnchor.sol`, about 85k gas per anchor). The CLI finds
  it through `deployments/zerog-anchor.json`, so nobody needs to pass an
  address.
- **0G Storage** keeps an independent copy of each anchored log
  (`lib/storage.js`, via `@0gfoundation/0g-storage-ts-sdk`).
- **0G Compute** reviews each change for the approver (`germline review`, or
  `review: true` in the action). A model on 0G Compute writes a two-sentence
  summary and a risk level, which go into the log as a review entry bound to
  the change by hash, with the model and request and response hashes. It
  is advice, never an approval, and redacted values are never sent.

## Other chains

The contracts are plain EVM (target `paris`), so the same scripts run on BOT
Chain (botchain.ai): `--network bohr` for its Bohr testnet (chain 968, faucet
at faucet.botchain.ai) or `--network botchain` for mainnet (chain 677). The
lineage registry has run its full lifecycle on Bohr; results and every
transaction are in [docs/BOTCHAIN-TESTNET.md](docs/BOTCHAIN-TESTNET.md).

## Status

| | |
|---|---|
| Hash chain, per-commit tracking, CLI, GitHub Action, evidence pack, browser verifier | done, tested |
| Anchor registry contract | **live on 0G mainnet**, [`0x18713A7E…cBcd`](https://chainscan.0g.ai/address/0x18713A7ED60576C68B2CfE30D18839521a23cBcd) |
| This repository's own log, anchored and verified | **done**: [first anchor](https://chainscan.0g.ai/tx/0x149f24bbe5c5492e1977c937341450152c1c6f4f289f831355b3db1d044413f4), `verify --strict` passes; [evidence pack](docs/germline-evidence.md) |
| Agent config timelock (`GermlineGuard`) | **live on 0G mainnet** for this repo's log, [`0x7eAAA03c…fA92`](https://chainscan.0g.ai/address/0x7eAAA03cdb80E638E59c5Cd0Cb92566aC7F9fA92); deploy one per agent |
| 0G Storage upload | code path done; first mainnet upload needs a funded key |
| Hosted anchoring (paid tier): GitHub OIDC or token per log, rate limit, receipt checked against the registry, public pins page | done, tested on a local chain; goes live once the service key is set in Vercel |
| Release tag | **done**: [v0.4.0](https://github.com/let-the-dreamers-rise/germline/releases/tag/v0.4.0), so `uses: let-the-dreamers-rise/germline@v0.4.0` works |
| npm package | **done**: [`germline@0.4.0`](https://www.npmjs.com/package/germline) |

## Repository

```
bin/germline.js              CLI: init, track, verify, anchor, report, id, demo
action.yml                   the GitHub Action
sdk/audit.js                 hash chain, diff, anchoring, chain verification
sdk/track.js                 per-commit tracking from git
sdk/report.js                evidence pack (Markdown, JSON, CSV)
sdk/github.js                pull-request approvals from the GitHub API
web/api/                     hosted anchoring service (Vercel functions)
contracts/GermlineAnchor.sol append-only anchor registry
contracts/GermlineGuard.sol  timelock on an agent's anchored config
web/verify.html              browser verifier, no upload, no third-party code
docs/                        AUDIT (format, CI), AGENTS, BUSINESS; SEARCH and SDK cover the legacy config search
test/                        mocha (SDK, CLI) and hardhat (contracts) tests
```

MIT licensed.
