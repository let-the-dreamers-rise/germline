# Submission

Ready to paste, for the audit-trail product. Values that need a mainnet
deployment are marked `<<AFTER DEPLOY>>`. The earlier Wave 3 submission (the
search and lineage product) is kept in `docs/SUBMISSION-wave3.md`.

## Project name

**Germline**

## One-line description

> A tamper-evident change log for your prompts and AI config: every change
> with its author, approver and eval, anchored on 0G so an auditor can check
> it without trusting you.

## Short summary

AI features change every week: a new system prompt, a different model, a
lower temperature. SOC 2 auditors and enterprise security reviews now ask
"who changed the model's behaviour, who approved it, and how was it tested?"
For prompts, most teams have no answer beyond a git log and a Slack thread.

Germline is a GitHub Action and CLI. `npx germline init` writes one workflow.
From then on, each commit that touches a tracked prompt or config file
becomes one entry in a hash-chained log. Each entry holds the author, the PR
approvers (from the GitHub API), the reason and ticket, the exact setting
that moved, and any eval score. The log lives on its own branch, so a
protected main needs no bypass.

Each run anchors the head of the log in `GermlineAnchor` on 0G Chain. That is
an append-only registry with no owner, where every anchor stays readable, so
truncating or rewriting the log later is caught. The log itself can be copied
to 0G Storage (unredacted prompts are refused unless explicitly allowed,
because Storage is public). An auditor verifies with one command or in a
browser page that uploads nothing. They pin the log ID and anchorer address
from their own records, so a forged copy fails.

The evidence pack (Markdown, JSON or CSV for Vanta and Drata) states what
the log shows and what it doesn't. A change with no approval or no eval is
marked "Partial", never "compliant".

**0G components:**
- **0G Chain** holds the anchors (`contracts/GermlineAnchor.sol`, about 85k
  gas each).
- **0G Storage** holds the published copy of the log
  (`@0gfoundation/0g-storage-ts-sdk`).
- **0G Compute** reviews each change for the approver: a model summary and
  risk level, recorded as a review entry bound to the change by hash
  (`germline review`).

## Fields

| Field | Value |
|---|---|
| GitHub | https://github.com/let-the-dreamers-rise/germline |
| GermlineAnchor on 0G mainnet | `<<AFTER DEPLOY>>` (`npm run deploy:anchor`, then `deployments/zerog-anchor.json`) |
| Example anchor tx | `<<AFTER DEPLOY>>` https://chainscan.0g.ai/tx/… |
| Demo | `npx github:let-the-dreamers-rise/germline demo` (one minute, no wallet) |
| Verifier | `web/verify.html` |

## Proof, in the order a judge should check it

1. `npx github:let-the-dreamers-rise/germline demo` records three changes,
   verifies, edits one line of the log the way an insider would, and shows
   verify catching it.
2. `npm run test:sdk` runs the SDK and CLI tests. They include the attacks in
   SECURITY.md: edited, deleted and reordered entries; non-canonical bytes; a
   symlink to `.git`; a commit message that tries to invent commits; markdown
   injection into the evidence pack.
3. `npx hardhat test test/anchor.test.js` runs the registry tests:
   truncation, rewrite and re-anchor, hidden anchors, and backdating against
   the block time.
4. SECURITY.md lists every attack the format catches, and the ones it doesn't.

## Demo video, 2 minutes

- **0:00 to 0:20, the question.** "Your auditor asks: what was your support
  bot's prompt on 14 March, who changed it, who approved it, and how was it
  tested?" Show a git log of a prompts folder: commits, but no approver, no
  eval, and history that can be force-pushed.
- **0:20 to 0:50, setup.** In a real repository, run `npx germline init` and
  show the one workflow file it generates. Push. In the Actions run, show
  "recorded #1 … approved by priya". Open the `germline-audit` branch.
- **0:50 to 1:20, the auditor.** Run `germline report --format csv` and
  open it in a spreadsheet. Then open the Markdown pack, scroll to "What this
  record supports", and point at "Partial: 0 carry test evidence". The tool
  doesn't overclaim.
- **1:20 to 1:50, the attack.** Run `germline demo`: an insider edits who
  made the refund-policy change, and verify fails. Then the stronger attack:
  rewrite the whole file consistently. In the browser verifier, with the
  pinned log ID and anchorer, the result is "Does NOT match 0G Chain".
- **1:50 to 2:00, close.** "Germline: the change log your auditor can check
  without trusting you. On 0G."

## X post

```
Your SOC 2 auditor will ask who changed your AI's prompt, who approved it,
and how it was tested.

Germline: one GitHub Action, every prompt change recorded with approver and
eval, anchored on 0G so nobody can rewrite it.

#BuildOn0G @0G_labs
```
