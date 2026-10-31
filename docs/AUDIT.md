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

`npx germline init` writes `.github/workflows/germline.yml`, which uses the
Germline GitHub Action (`action.yml` at the root of this repository). On
every push it:

1. verifies the existing log, and stops if it has been tampered with;
2. records one entry per commit that touched a tracked file, credited to the
   commit's author, with the commit's message as the reason and any ticket
   (`ABC-123` or `#45`) it mentions; the CI identity is kept as `recordedBy`;
3. commits the log with `[skip ci]` to the `germline-audit` branch (or the
   same branch, if `log-branch` is empty) and pushes it, rebuilding and
   retrying if someone pushed in between;
4. only then, if `GERMLINE_ANCHOR_KEY` is set, anchors the pushed head on 0G
   and pushes the anchor receipt.

Pushing before anchoring matters: an anchor of entries that never reached the
branch would make verification fail for an honest log forever. The workflow
`init` writes uses `fetch-depth: 0`, so every commit is visible, and
`concurrency: germline`, so two runs never write at once.

### Branch protection

The workflow `init` writes sets `log-branch: germline-audit`, so the log is
committed to its own branch and `main` stays protected without a bot bypass.
Protect `germline-audit` against force-pushes and deletion, but allow the
workflow to push to it. Remove `log-branch` to keep the log beside the code
instead; then the default branch must accept the workflow's pushes.

### Approvals

With `pull-requests: read` in the workflow's permissions (which `init`
writes), each entry for a commit merged through a pull request records the
PR number, who approved it (each reviewer's latest review), and who merged
it, from the GitHub API. Those are authenticated GitHub accounts, unlike a
commit's author line. A commit pushed straight to the branch has no
approval, and the evidence pack says so.

### Attaching test evidence

`germline track --score 0.91 --baseline 0.84 --suite refunds-v4` or
`germline track --eval-file eval.json` attaches the evaluation that justified
the change to every entry it writes. Run it in the job that runs your evals.

| input | default | meaning |
|---|---|---|
| `anchor-key` | empty | funded 0G key; empty means record and verify only |
| `registry` | shipped deployment | GermlineAnchor address |
| `upload` | `false` | also publish the log to 0G Storage; refuses unredacted config |
| `allow-public-upload` | `false` | allow uploading unredacted config (0G Storage is public) |
| `log-branch` | empty | branch that holds the log; `init` writes `germline-audit` |
| `commit` | `true` | commit the updated log back to the branch |
| `rpc` | `https://evmrpc.0g.ai` | 0G Chain RPC |

The files to track live in `.germline/config.json`; edit the list there.
JSON files are diffed setting by setting, anything else as text, and a
deleted file is recorded as a change to `null`.

Commit the log to the repository it describes. Git history then becomes a
second, independent copy, and the anchor makes both checkable.

## Anchoring, and what to pin

`germline anchor` writes into the GermlineAnchor registry when one is known
for the chain (`--registry`, `GERMLINE_REGISTRY`, or `deployments/*-anchor.json`),
and falls back to a plain self-transaction otherwise. Use the registry: it
keeps every anchor on chain, so deleting anchor records from the file does
not hide them.

Give your auditor three things, through a channel other than the log:

```bash
germline id          # the log id
# the anchorer address printed by `germline anchor`
# the registry address, from deployments/zerog-anchor.json
```

They verify with all three pinned:

```bash
germline verify --chain --strict --log-id 0x… --anchorer 0x… --registry 0x…
```

Missing pins are warnings; `--strict` fails on any warning.

## Threat model

See [SECURITY.md](../SECURITY.md) for the full table of attacks, which tests
cover each one, and what the audit trail does not protect against.
