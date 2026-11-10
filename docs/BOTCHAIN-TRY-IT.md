# Try Germline on BOT Chain (5 minutes)

Germline keeps a tamper-evident record of every change to an AI agent's
settings (model, prompt, parameters) and anchors it on BOT Chain. Each anchor
is one BOT Chain transaction from your own wallet. Anyone can check it later,
with no account and no key.

## You need

- Node.js 18 or newer.
- A wallet with a little BOT on BOT Chain mainnet (chain 677). One anchor uses
  about 95,000 gas, so 0.005 BOT covers a few anchors.
- That wallet's private key in an environment variable. Use a fresh wallet that
  holds only this small amount, not your main wallet.

## Steps

macOS or Linux:

```sh
mkdir germline-try && cd germline-try
export GERMLINE_NETWORK=botchain
export GERMLINE_ANCHOR_KEY=0x...        # the fresh wallet's key; never share it

echo '{"model":"gpt-4o-mini","temperature":0.2}' > v1.json
npx germline@latest record --system my-agent --actor yourname --after v1.json --reason "first config"
npx germline@latest anchor               # transaction 1

echo '{"model":"gpt-4o-mini","temperature":0.7}' > v2.json
npx germline@latest record --system my-agent --actor yourname --after v2.json --reason "raise temperature"
npx germline@latest anchor               # transaction 2

npx germline@latest verify --chain       # checks the log against BOT Chain
```

Windows PowerShell: replace each `export NAME=value` with `$env:NAME = "value"`,
and write the JSON files with `'{"model":"gpt-4o-mini","temperature":0.2}' | Set-Content v1.json`.

Each `anchor` prints a `view:` line with the transaction on
https://scan.botchain.ai. Use your own agent's real config file in place of
`v1.json` if you have one: the record is what Germline is for.

## What you just did

`record` appended a hash-chained entry to `.germline/audit.jsonl`. `anchor`
wrote the log's head into the GermlineAnchor registry on BOT Chain, a contract
with no owner, admin or upgrade path. `verify --chain` recomputed the log and
checked it against the registry; edit any line of the log and it fails.

The browser verifier does the same check with no install:
https://germline.vercel.app/verify.html?network=botchain
