# Germline for AI agents

An AI agent that trades, pays or votes is only as trustworthy as what it was
told to do: its system prompt, model, tool list and limits. Those can change
overnight, and the people whose money the agent moves usually can't see it
happen. A quiet prompt change is a rug pull that leaves no trace on chain.

Germline gives an agent a public, tamper-evident config history, and
`GermlineGuard` lets contracts act on it.

## 1. Record the agent's config

In the agent's repository:

```bash
npx github:let-the-dreamers-rise/germline init
```

`init` finds prompt and agent files, including ElizaOS characters
(`characters/*.character.json`), `SOUL.md`, `mcp.json` tool lists, and
anything named like a prompt, persona, agent or model config. It writes the
GitHub workflow. Every merged change to those files becomes one entry in a
hash-chained log, with the author, the pull request approval and the exact
setting that moved, for example `maxTradeUsd 100 → 100000`.

For configs that live outside git (a database, a dashboard), call the SDK at
start-up. It records only when something changed:

```js
const { openAuditLog } = require("germline");
openAuditLog().track("trader", character, { reason: "boot " + process.env.GIT_SHA });
```

Use `"redact": true` for prompts you don't want public. The log then keeps
per-setting hashes, so a reader sees *that* the tool list changed, not its
contents.

## 2. Anchor it on 0G

Add a funded 0G key as the repository secret `GERMLINE_ANCHOR_KEY`. Each run
anchors the log's head in `GermlineAnchor` on 0G Chain: an append-only
registry with no owner. From then on, nobody, including the operator, can
rewrite the agent's history without it showing. Anyone can check with
`germline verify --chain --log-id … --anchorer …`, or in the browser verifier.

Publish the log ID and the operator's anchoring address on the agent's page.
Those two values are what make a rewritten copy fail.

## 3. Put a timelock on config changes

`contracts/GermlineGuard.sol` watches one agent's log, as anchored by one
operator key. A contract that holds funds for the agent calls
`guard.check(head)` before letting the agent act. `check` passes only when:

- `head` is the head the operator most recently anchored, and
- that anchor is at least `delay` seconds old.

So every config change the operator publishes pauses the agent, in guarded
contracts, for `delay`. During that window anyone can read exactly what
changed, and depositors can leave. It's the governance timelock pattern,
applied to an agent's instructions instead of a protocol's code.

```solidity
import "germline/contracts/GermlineGuard.sol";

contract MyAgentVault is GermlineGuarded {
    constructor(GermlineGuard guard_) GermlineGuarded(guard_) {}

    function trade(bytes32 configHead, ...) external onlySettledConfig(configHead) {
        ...
    }
}
```

The agent gets the head to claim from `germline head` (or
`openAuditLog().lastAnchor().anchoredHead` in the SDK).
`contracts/examples/AgentVault.sol` is a complete minimal example, and
`test/guard.test.js` runs it end to end against a real Germline log.

Deploy a guard for your agent:

```bash
GUARD_LOG_ID=$(npx germline id) GUARD_ANCHORER=0x… GUARD_DELAY=86400 \
  npx hardhat run scripts/deploy-guard.js --network zerog
```

The guard has no owner and its parameters are immutable, so a depositor can
read exactly what they agreed to.

## What this does and doesn't prove

Be precise about this with your users.

- **It proves what the operator published, and when.** Every change is
  timestamped by a 0G block and can't be edited or hidden afterwards.
- **It can't see a change the operator never publishes.** An operator who
  runs a different prompt than the one in the log, without anchoring it, isn't
  caught by the guard. Anyone holding the published log can see whether the
  claimed head was ever anchored, but nobody can see what the agent's server
  actually loaded.
- **Closing that gap needs attested execution.** The next step is binding
  the anchored config to the inference itself, through 0G Compute's
  TEE-verified inference: the enclave attests which prompt and model it ran,
  and the guard accepts only attestations matching the settled head. That's
  on the roadmap, not in this release.

The guard still changes the operator's incentives today. A silent change now
means publishing a false head, which is a public, permanent, attributable lie,
rather than an invisible edit.
