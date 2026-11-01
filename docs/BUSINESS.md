# Business

Short, and honest about which parts are measured and which are assumptions.
Nothing here has been validated with a paying customer yet.

## What is sold

A change record for AI behaviour that an auditor can check without trusting
the company being audited. Each change to a prompt, model or parameter is
recorded with its author, its approver (from the pull request), the reason
and ticket, the exact setting that moved, and the eval behind it. The record
is hash-chained and anchored on 0G. See `docs/AUDIT.md`.

## Who buys first

**B2B SaaS teams with an AI feature and a SOC 2 audit in the next 12
months**, typically 20 to 200 engineers, with prompts and model settings kept
in a git repository.

Their problem is specific. SOC 2 CC8.1 asks that changes be authorised,
tested and documented. For application code, GitHub plus Vanta or Drata
already produces that evidence. For prompts it usually doesn't: prompts change
outside the normal release process, the "test" is an eval nobody saved, and
the reviewer approved a PR whose diff was 400 lines of prose. Enterprise
security questionnaires now ask "how do you control changes to model
behaviour?" outright.

What they buy is an answer they can hand over: a CSV for the GRC tool, a
Markdown pack for the auditor, and a verification command the auditor runs
themselves.

The EU AI Act (Art. 12 and 19) is a second, later market. It applies to
high-risk systems, which most SOC 2 SaaS products are not, so it isn't the
opening pitch.

## Why this, when git exists

The honest objection is that git already records who changed a prompt file.
Here is what git and a GRC tool don't give the buyer:

1. **Setting-level diffs and eval evidence in one record.** A reviewer sees
   "temperature 0.7 → 0.2, refunds-v4 score 0.84 → 0.91, approved by priya
   in #212", not a raw diff and a separate CI log.
2. **A record the company can't quietly rewrite.** Git history is the
   company's own and can be force-pushed. An anchor on 0G is not. For an
   auditor, that's the difference between "the vendor says" and "anyone can
   check".
3. **Prompts that don't live in git.** `track()` in the SDK records configs
   loaded at runtime, from a database or a prompt-management tool.

If a buyer's auditor is satisfied with GitHub PR evidence for prompts, Germline
isn't needed. The bet is that, for AI behaviour specifically, it increasingly
won't be.

## Price

These are proposals, not measured willingness to pay.

| tier | price | what |
|---|---|---|
| Open source | free | CLI, GitHub Action, self-anchored with your own 0G key |
| Team | $199 a month per repository group | hosted anchoring (we hold the key and pay gas), log storage on 0G, a hosted verifier page with your pins published at the start of the audit period, CSV export into Vanta and Drata |
| Audit pack | $1,500 one-off | evidence pack prepared for one audit window, with an auditor walk-through |

The hosted tier sells two things a team can't easily do alone. First, a third
party holding the anchor key and publishing the pins early, which closes the
"auditee builds a fake log the week before" gap in SECURITY.md. Second, not
having to run a crypto wallet in CI.

## Competition

- **Vanta, Drata, Secureframe.** They collect change evidence from GitHub.
  Germline complements them as an evidence source (CSV today, an integration
  later) rather than competing.
- **Langfuse, LangSmith, PromptLayer.** They version prompts and log inference.
  Their audit logs are rows in the vendor's own database, not independently
  verifiable, and they don't link changes to approvals and evals as one
  record. They're also a possible source: a webhook from their prompt
  registry into `track()`.
- **Sigstore, Rekor, OpenTimestamps.** They're free transparency and
  timestamping logs, and they could anchor the same heads. The registry's job
  (append-only, per log and key, every anchor readable) could live on any
  chain. 0G is used because it's cheap enough to anchor on every merge, and
  because 0G Storage keeps the log itself beside the anchor.

The moat isn't the code, which is small and MIT-licensed. It's being the
format auditors already know how to check. That only comes from early
auditor relationships, which is why the first milestone is an auditor and not
a feature.

## What would prove this out

In order, and none of it is done:

1. Three design partners running the action on a real repository through one
   audit window.
2. One auditor's written statement that they would accept the evidence pack
   and run the verifier.
3. One paying hosted-tier customer.
4. GermlineAnchor deployed on 0G mainnet, with this repository's own log
   anchored on it and linked from the README.

## Search

The package also contains an evolutionary config search with on-chain
lineage (`docs/SEARCH.md`). Our own benchmark found random sampling beats it
on two of three landscapes, so it isn't sold. It stays in the package as a way
to produce eval evidence for a change.
