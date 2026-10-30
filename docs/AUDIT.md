# Audit trail

What it records, how to run it in CI, and what it does and does not protect
against.

## An entry

One JSON object per line in `.germline/audit.jsonl`:

```json
{
  "format": "germline.audit/1",
  "seq": 4,
  "prev": "0x…hash of entry 3…",
  "ts": "2026-10-30T12:00:00.000Z",
  "kind": "change",
  "system": "support-agent",
  "actor": "ash@acme.com",
  "reason": "fewer wrong refund answers",
  "ticket": "GOV-112",
  "beforeRoot": "0x…",
  "configRoot": "0x…",
  "changes": [{ "key": "temperature", "from": 0.7, "to": 0.2 }],
  "eval": { "score": 0.91, "baseline": 0.84, "suite": "refunds-v4" },
  "before": { "…": "…" },
  "after": { "…": "…" },
  "hash": "0x…keccak256 of everything above, keys sorted…"
}
```

`--redact` drops `before`, `after` and the values in `changes`, keeping the
roots. Anyone who later holds a config can show it was the one live at entry
4 by hashing it.

An anchor is also an entry (`kind: "anchor"`), so the log records its own
anchoring and that record is itself covered by the next anchor.

## In CI

Record on every merge that touches a config, verify on every build, anchor
on a schedule. A GitHub Actions example:

```yaml
name: ai-config-audit
on:
  push:
    branches: [main]
    paths: ["config/agent.json"]
  schedule:
    - cron: "0 3 * * *"

jobs:
  audit:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with: { fetch-depth: 2 }
      - uses: actions/setup-node@v4
        with: { node-version: 20 }
      - run: npm install -g germline
      - run: germline verify
      - if: github.event_name == 'push'
        run: |
          git show HEAD~1:config/agent.json > /tmp/before.json
          germline record --system support-agent \
            --actor "${{ github.actor }}" --ticket "${{ github.sha }}" \
            --before /tmp/before.json --after config/agent.json \
            --reason "$(git log -1 --pretty=%s)"
      - if: github.event_name == 'schedule'
        run: germline anchor --upload
        env:
          DEPLOYER_KEY: ${{ secrets.ZEROG_KEY }}
      - run: |
          git config user.name germline-bot
          git config user.email germline-bot@users.noreply.github.com
          git add .germline/audit.jsonl
          git commit -m "audit: record config change" || true
          git push
```

Commit the log to the repository it describes. Git history then becomes a
second, independent copy, and the anchor makes both checkable.

## Threat model

| attack | caught by |
|---|---|
| edit an entry's fields | hash mismatch, `verify` |
| delete or reorder entries | broken `prev` link or sequence, `verify` |
| swap a stored config for another | `configRoot` mismatch, `verify` |
| rewrite the whole log consistently, after an anchor | anchored head no longer at that position, `verify --chain` |
| rewrite the whole log before the first anchor | **not caught.** Anchor early and often |
| record a false reason or a made-up eval score | **not caught.** Germline fixes what was claimed in place; it does not check it is true. Attach evidence an auditor can re-run |
| lose the only copy | 0G Storage copy from `anchor --upload`, plus git |

The anchoring key is an ordinary 0G account. Anyone can see which address
anchored, and `verify --chain` checks the transaction came from the address
the log says it did.
