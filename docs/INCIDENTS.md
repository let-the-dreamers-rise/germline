# Public incidents, and what Germline would and wouldn't have done

Germline is for one class of failure: **someone changes what an AI system is
told to do (its prompt, model, tools or limits) and nobody can see who, when,
or whether it was reviewed.** This page goes through public incidents and
says, for each, whether Germline addresses it. Several of them are outside what
Germline does, and this page says so.

Facts are as reported in the linked sources. Where a source doesn't say how
something happened, we don't guess.

## Incidents that are config changes

### Grok, February 2025: an employee's system-prompt edit

Grok was briefly instructed to ignore sources that said Elon Musk or Donald
Trump spread misinformation. xAI's engineering lead said an employee had
changed the system prompt without approval. It was reverted after users
noticed. ([TechCrunch](https://techcrunch.com/2025/05/15/xai-blames-groks-obsession-with-white-genocide-on-an-unauthorized-modification))

### Grok, 14 May 2025: an "unauthorized modification"

At about 3:15 AM PST, someone changed the system prompt of Grok's reply bot on
X to give a specific answer on a political topic, and Grok inserted it into
replies on unrelated posts. xAI's announced fixes were to publish Grok's
system prompts on GitHub with a changelog, to add checks so employees can't
change the prompt without review, and to set up a 24/7 monitoring team.
([TechCrunch](https://techcrunch.com/2025/05/15/xai-blames-groks-obsession-with-white-genocide-on-an-unauthorized-modification))

**What Germline would have done, in both cases.** The first two fixes xAI
announced are what Germline does by default:

- Each change to a tracked prompt becomes one entry with its author, its
  commit, the pull request approval GitHub reports (or the absence of one),
  and the exact setting that moved.
- `germline report` shows, for each change, who approved it, and counts the
  changes with no recorded approval, so an unreviewed edit is visible in the
  evidence pack rather than buried in a Slack search.
- The log is hash-chained and anchored on chain, so a published changelog
  can't be quietly edited afterwards, by anyone including the company.

**What it wouldn't have done.** If the change was made directly on a
production server and never went through the tracked repository, Germline
wouldn't record it. The record shows only what went through the tracked
path. Binding the published config to what actually ran needs attested
inference (see "the honest gap" below).

**See it on the real record.** [CASE-STUDY-GROK.md](CASE-STUDY-GROK.md) runs
Germline over xAI's public prompt repository: 14 changes, one CI author, 13
identical commit messages, and no recorded approvals. It includes the line
added on 6 July 2025 and removed on 8 July, the evening of the antisemitic
posts.

## Incidents that are not config changes

### AIXBT, 18 March 2025: dashboard access, 55.5 ETH

An attacker got into AIXBT's "secure dashboard" and queued two replies that
triggered a 55.5 ETH tip from the agent's wallet to an attacker's address on
Base. The developer said it wasn't agent manipulation. The source doesn't say
how the attacker got in.
([Decrypt](https://decrypt.co/310510/aixbt-ai-influencer-hacked-100k-ethereum))

**Germline would not have stopped this.** The attacker queued actions; the
agent's instructions didn't change. A runtime action check, or a wallet
spending limit, is the control for this. If the agent's spending limit itself
lived in a tracked config and the wallet sat behind a `GermlineGuard`, raising
that limit would have paused the agent for the guard's delay, but nothing in
the report says the limit was changed.

### Grok and Bankrbot, May 2026: prompt injection, about $150K–$200K

An attacker sent an encoded instruction on X that led Grok and Bankrbot to
move 3 billion DRB tokens out of a wallet on Base.
([OECD AI incident monitor](https://oecd.ai/en/incidents/2026-05-04-4a73))

**Germline would not have stopped this.** It was malicious input, not a
changed config. Input filtering, action checks and spending limits are the
controls here.

## Where Germline fits next to other controls

| Control | Catches | Examples |
|---|---|---|
| Input filtering | Malicious prompts from users | Prompt-injection firewalls |
| Runtime action checks | A bad action before it runs | Action validators, wallet policies |
| **Config change control (Germline)** | **A change to the agent's own instructions, limits or model: who made it, whether it was reviewed, and, with the guard, a delay before it takes effect** | |
| Attested execution | A server that runs something other than what it published | TEE inference (roadmap) |

These layer: a runtime check is only as good as the policy it enforces, and
that policy is itself config that someone can change.

## The honest gap

The guard binds what the operator **publishes**. An operator, or an attacker
with server access, can still run an unpublished config. Today that becomes a
public, permanent, attributable false claim rather than an invisible edit,
which changes incentives but isn't proof. Closing the gap needs the inference
provider to attest which prompt and model ran, so the guard can accept only
attestations that match the settled head. That's on the roadmap through 0G
Compute's TEE-verified inference. See [AGENTS.md](AGENTS.md).

## What it costs

From `npm run bench:guard` (local Hardhat chain; gas is deterministic):

| | Gas |
|---|---|
| Anchor a new log head | about 80,000 (95,000 for a log's first anchor) |
| Guard check added to each agent payment | about 16,800 |
| Deploy a guard | about 347,000 |

Verifying a 1,000-entry log offline takes about 0.19 seconds (Node 22, one
2.8 GHz Xeon core).
