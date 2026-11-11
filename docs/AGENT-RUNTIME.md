# Auditing an agent while it runs

`germline track` and the GitHub Action record changes that land in a repo.
Most of an agent's real changes don't: they happen at runtime. `watchAgent`
records them where they happen, inside the agent.

```js
const { Wallet, JsonRpcProvider } = require("ethers");
const { watchAgent } = require("germline");

const wallet = new Wallet(process.env.AGENT_KEY, new JsonRpcProvider("https://rpc.botchain.ai"));
const audit = watchAgent({ system: "support-agent", signer: wallet });

// 1. Wrap the model call. Each request's model, sampling settings, system
//    prompt and tool names are compared with the last recorded config; a
//    difference is recorded before the request is sent.
const create = audit.wrap((params) => openai.chat.completions.create(params));

// 2. Or report config changes yourself, with who made them and why.
audit.observe(newConfig, { actor: "operator:dana", reason: "raise refund limit" });

// Before the process exits, anchor whatever is waiting.
await audit.flush();
```

What happens:

- **Recorded at once, locally.** The change goes into the hash-chained log
  (`.germline/audit.jsonl` by default) synchronously, before the call it
  governs. A repeat of the same config records nothing. Conversation messages
  are never recorded, only configuration.
- **Anchored automatically from the agent's wallet.** After a change, one
  anchor transaction goes out within `anchorAfterMs` (default 60 s), or at once
  when `anchorEvery` changes (default 10) are waiting. On BOT Chain one anchor
  is about 95,000 gas. The registry for the chain is found from `deployments/`.
- **Never breaks the agent.** A failed anchor (no gas, RPC down) goes to
  `onError` and is retried with the next change; the log keeps every entry.

Options: `system` (required), `signer` (an ethers signer; without one, changes
are recorded but not anchored), `file`, `registry`, `actor` (default
`agent:<system>`), `anchorAfterMs`, `anchorEvery`, `onAnchor(entry)`,
`onError(error)`. `wrap(call, pick)` takes an optional `pick(params)` for model
APIs that aren't OpenAI-shaped.

Check it like any Germline log:
`npx germline verify --log .germline/audit.jsonl --chain`, or in the browser
verifier.
