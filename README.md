# Germline

### A tamper-evident change log for your prompts and AI config. Anchored on 0G, checkable by anyone.

Your AI feature changes every week: a new system prompt, a different model, a
lower temperature. Your SOC 2 auditor, an enterprise customer's security
review, or the EU AI Act will ask: *what was live on 14 March, who changed it,
why, and what testing justified it?* Most teams answer with a Slack search.

Germline records each change, one entry per commit, with the author, who
approved the pull request (from GitHub's API), the commit message and ticket,
the exact setting that moved, and any eval score.
The log is hash-chained, so an edited, deleted or reordered entry fails
verification, and its head is anchored on 0G Chain, so even whoever holds the
file cannot rewrite it later. Your auditor checks it themselves, without
trusting you or us.

```bash
npx github:let-the-dreamers-rise/germline demo     # one minute: record, verify, tamper, get caught
```

## Five-minute setup

In the repository that holds your prompts and AI config:

```bash
npx github:let-the-dreamers-rise/germline init   # finds prompt/config files, writes the workflow
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

## For on-chain AI agents

An agent that moves money is only as safe as its prompt, model and limits,
and a quiet change to them leaves no trace. `init` also picks up ElizaOS
characters, `SOUL.md` and `mcp.json` tool lists, so the agent's config
history becomes public and impossible to rewrite. `contracts/GermlineGuard.sol`
then puts a timelock on it: a vault that holds the agent's funds calls
`guard.check(head)`, so every config change pauses the agent for a set delay
while depositors read the change and decide whether to stay.
[docs/AGENTS.md](docs/AGENTS.md) has the setup and is precise about what the
guard can and can't prove.

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

- **0G Chain** holds the anchors. Contract: `contracts/GermlineAnchor.sol`.
  It uses about 85k gas per anchor and is not yet deployed to mainnet.
  `npm run deploy:anchor` deploys it.
- **0G Storage** keeps an independent copy of each anchored log
  (`lib/storage.js`, via `@0gfoundation/0g-storage-ts-sdk`).
- **0G Compute** reviews each change for the approver (`germline review`, or
  `review: true` in the action). A model on 0G Compute writes a two-sentence
  summary and a risk level, which go into the log as a review entry bound to
  the change by hash, with the model and request and response hashes. It
  is advice, never an approval, and redacted values are never sent.

## Status

| | |
|---|---|
| Hash chain, per-commit tracking, CLI, GitHub Action, evidence pack, browser verifier | done, tested |
| Anchor registry contract | done, tested on a local chain; mainnet deployment needs a funded key |
| Agent config timelock (`GermlineGuard`) | done, tested on a local chain against real logs; deploy per agent |
| 0G Storage upload | code path done; first mainnet upload needs a funded key |
| npm package, release tag | pending: `npx github:…` and the `@v0.4.0` action ref work once this branch is merged and tagged |

## Repository

```
bin/germline.js              CLI: init, track, verify, anchor, report, id, demo
action.yml                   the GitHub Action
sdk/audit.js                 hash chain, diff, anchoring, chain verification
sdk/track.js                 per-commit tracking from git
sdk/report.js                evidence pack (Markdown, JSON, CSV)
sdk/github.js                pull-request approvals from the GitHub API
contracts/GermlineAnchor.sol append-only anchor registry
contracts/GermlineGuard.sol  timelock on an agent's anchored config
web/verify.html              browser verifier, no upload, no third-party code
docs/                        AUDIT (format, CI), AGENTS, BUSINESS, SEARCH (older lineage work)
test/                        mocha (SDK, CLI) and hardhat (contracts) tests
```

MIT licensed.
