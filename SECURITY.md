# Security

What Germline protects, what it does not, and the known issues in what is
deployed. Written for an auditor or a customer's security team, not as a
pitch. Report vulnerabilities by opening a private security advisory on the
GitHub repository.

## What the audit trail guarantees

Given the log file, the log id (hash of entry 0), the anchorer address and
the registry address, `germline verify --chain --log-id … --anchorer …
--registry …` detects every one of these, with no trust in whoever holds the
file:

| attack on the log | caught by | test |
|---|---|---|
| edit any field of an entry | entry hash | `test/audit.test.js` |
| delete, insert or reorder entries | `prev` link and sequence | `test/audit.test.js` |
| swap a stored config for a different one | `configRoot` | `test/audit.test.js` |
| rewrite the log consistently and drop the anchor records | registry history | `test/anchor.test.js` |
| rewrite and re-anchor under the same key | every earlier registry anchor must still match | `test/anchor.test.js` |
| truncate below an anchored length | registry history | `test/anchor.test.js` |
| start a fresh log under a new id or key | pinned log id and anchorer | `test/anchor.test.js` |
| list an anchor that never happened | registry lookup | `test/anchor.test.js` |
| date entries after the block that anchored them | block timestamp | `test/anchor.test.js` |
| two writers forking the chain by appending at once | lock file | `test/anchor.test.js` |

## What it does not guarantee

Nothing here is unbreakable, and a security reviewer should hear that from us
first.

- **Entries after the latest anchor are unprotected.** Until an anchor covers
  them, whoever holds the file can change them freely. Anchor on every merge
  or at least daily; the cost is one 0G transaction.
- **Truth is not checked, only permanence.** A false reason or an invented
  eval score is recorded faithfully. Germline proves what was claimed and
  when, not that it was correct. Attach evidence an auditor can re-run.
- **The author is git's claim; the approval is GitHub's.** Each entry's
  `actor` is the commit author, which anyone can set with `git commit
  --author`. `recordedBy` is the CI identity that ran the recording. When the
  action runs with `pull-requests: read`, `approval` holds the pull request,
  its approvers and the merger as GitHub's API reports them, and those are
  authenticated accounts. `committedAt` is the committer date, which is also
  settable. Signed entries (OIDC, Sigstore) are on the roadmap.
- **Pins must come from outside the file, and early.** Without the log id,
  anchorer and registry address from an independent source, a forger who
  controls everything can start over. In practice the auditee hands these to
  the auditor, so hand them over at the *start* of the audit period, not the
  end: a log built the week before the audit under a new key is caught only
  if the pins predate it. `verify` warns whenever a pin is missing, and
  `--strict` turns warnings into failure.
- **Backdating before the first anchor is undetectable.** Timestamps are the
  writer's clock until a block fixes an upper bound on them.
- **Redacted configs with little entropy can be guessed.** A redacted entry
  keeps `keccak256` of the config. If the config is `{ "temperature": 0.2 }`,
  anyone can try candidates. Redaction hides long prompts, not small values.
- **The anchoring key is a hot key, and a leak is a denial of service.** A
  leaked key cannot remove or alter existing anchors (the registry is
  append-only per key). It *can* anchor a junk head with a huge entry count
  under your log id. After that, verification pinned to that key fails, and
  your own anchors with that key revert, because `covered` must increase.
  Earlier anchors stay valid and visible. Recovery: rotate to a new key,
  anchor under it, and tell verifiers to pin the new address. Keep the key
  in a CI secret scoped to the one workflow, fund it with a few cents of 0G,
  and never reuse it for anything else.
- **The CI push races are handled; a protected branch needs a decision.** The
  action pushes the log before anchoring it, so an anchor only ever covers
  entries already on the branch, and it rebuilds and retries when someone
  pushes in between. If the branch is protected against bot pushes, either
  allow the workflow's token to bypass, or point `config.log` at a file on a
  separate branch. See docs/AUDIT.md.
- **Raw bytes are pinned.** Each line must be the canonical serialisation of
  its value (`JSON.stringify` of the parsed line), so duplicate keys, padded
  numbers and alternative escapes are rejected rather than parsed two ways.
- **Tracked paths stay inside the repository.** Absolute paths, `..`, any
  path that goes through a symbolic link, and anything under `.git` (in any
  letter case) are refused, so a merged config change cannot copy the CI
  token or runner secrets into the log.
- **Commit messages are data.** Commit hashes and details are read with
  separate git calls split on NUL, so a crafted message cannot invent
  commits, authors or dates.
- **0G Storage is public.** `anchor --upload` refuses a log that holds
  unredacted config unless `--allow-public` is passed.
- **The evidence pack is hostile input.** Every value from the log is escaped,
  hashes and addresses are shape-checked, and the pack's verification command
  never fills in pins from the file it describes.
- **Chain and storage availability.** Verification of anchors needs a working
  0G RPC. The hash chain itself verifies offline.

## GermlineAnchor (contracts/GermlineAnchor.sol)

No owner, no upgrade path, no admin functions, no external calls, no ether
handling. Anchors are keyed by `(logId, msg.sender)`, so one sender cannot
write into another's history, and each key is append-only (`covered` must
strictly increase). Storage grows by one struct per anchor, paid by the
anchorer. Reads are paged (`anchorsOf`). Not yet deployed to 0G mainnet;
`npx hardhat run scripts/deploy-anchor.js --network zerog` deploys it and the
CLI then finds it from `deployments/zerog-anchor.json`. Not externally audited.

## Known issues in Germline.sol (deployed at 0xA0448Cd6…7b25)

The lineage registry predates the audit trail and is not what customers buy,
but it is live, so its issues are listed here. Fixing them needs a new
deployment, because changing the source would make the deployed bytecode
disagree with the repository.

1. **Mutation seeds can be re-rolled.** `requestSpawn` overwrites any pending
   request at no cost, and `mutationSeedFor` reveals the seed once the block
   is mined. A breeder can request, read the seed, and request again until
   the mutation suits them. Every attempt emits `SpawnRequested`, so it is
   visible, but nothing enforces it. Fix: consume an offspring slot on
   `requestSpawn`, or forbid a new request while one is open and unexpired.
2. **`blockhash` is producer-influenced.** A block producer can withhold a
   block to change the seed. Low risk at this value; a VRF or a later-block
   commit would remove it.
3. **Fitness can be overwritten.** Any attestor can re-attest an organism at
   any time, changing how many children it may have. The single curator
   appoints attestors. Centralised by design for now, and stated in the README.
4. **`Organism.steward` goes stale on transfer.** Ownership moves with the
   ERC-721, but the stored steward field does not. Authorisation uses
   `ownerOf`, so this is cosmetic.
5. **Curator transfer is one step.** A typo in `transferCuration` loses the
   role forever. Use a two-step transfer in the next version.
