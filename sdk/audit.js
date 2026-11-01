"use strict";

// The audit trail: a tamper-evident record of every change to an AI system's
// configuration, and the evidence that justified it.
//
//     const { openAuditLog } = require("germline");
//
//     const log = openAuditLog(".germline/audit.jsonl");
//     log.record({
//       system: "support-agent",
//       actor: "ash@example.com",
//       before: { model: "gpt-x", temperature: 0.7 },
//       after:  { model: "gpt-x", temperature: 0.2 },
//       reason: "fewer hallucinated refund policies in eval set v4",
//       eval:   { score: 0.91, baseline: 0.84, suite: "refunds-v4" },
//     });
//     log.verify();          // { ok: true, ... } until someone edits the file
//     await log.anchor({ signer });   // pin the head on 0G Chain
//
// WHY A HASH CHAIN. Each entry carries the hash of the one before it, so an
// entry cannot be edited, removed or reordered without breaking every hash
// after it. That makes tampering detectable by anyone holding the file, with
// no network and no trust in whoever produced it.
//
// WHY AN ANCHOR. A hash chain alone has one hole: whoever holds the file can
// rewrite all of it, consistently, from the first entry. Anchoring closes it.
// The head hash is written to 0G Chain in a transaction whose timestamp
// nobody controls, so a rewrite after the anchor no longer matches what the
// chain says the log looked like then. The log itself goes to 0G Storage so
// an auditor can fetch it without asking the vendor for a copy.
//
// TWO ANCHOR MODES. With a GermlineAnchor registry (contracts/
// GermlineAnchor.sol), each anchor is stored on chain under (log id,
// anchorer), append-only, and every anchor ever made can be read back with
// view calls. That catches the attack a plain transaction cannot: rewriting
// the log and quietly dropping the anchor records from it. Without a
// registry, the head goes into the data of a zero-value transaction to the
// anchorer's own address. That works on any chain with nothing deployed, but
// a verifier only learns of the anchors the log itself still lists.
//
// WHAT A VERIFIER MUST PIN. The log id (the hash of entry 0) and the
// anchorer address are the two facts an auditor should get from somewhere
// other than the log: a trust page, a contract, last year's evidence pack.
// A forger who controls the file can start a fresh log under a fresh id and
// a fresh key; only a pinned id and address catch that, and verify says so
// when they are missing rather than passing silently.
//
// That pairing is the product. A vendor's own dashboard is the vendor
// asserting something about itself. This is a record the vendor cannot
// quietly change, which is the property an auditor is actually asking for.

const fs = require("fs");
const path = require("path");
const { keccak256, toUtf8Bytes } = require("ethers");
const { stableStringify } = require("./canonical");
// Reading and verifying a log live in one module the browser verifier shares.
const core = require("./verify-core");

const { FORMAT, GENESIS, REGISTRY_ABI } = core;

const { ANCHOR_TAG } = core;



function hashOf(value) {
  return keccak256(toUtf8Bytes(stableStringify(value)));
}

// The config itself may be sensitive -- a system prompt, a pricing rule -- so
// an entry always carries its root and only carries the full value when the
// caller allows it. The root alone is enough to prove later which config was
// live, given the config.
function configRootOf(config) {
  return config === undefined || config === null ? null : hashOf(config);
}

/// What changed between two configs, setting by setting.
///
/// Objects are walked to their leaves, so a file holding a JSON config shows
/// up as `config/agent.json › temperature: 0.7 → 0.2` rather than as one
/// opaque replaced blob. Arrays are compared whole: an element's position is
/// rarely a setting anyone names. Long or multi-line text -- a prompt -- also
/// carries a line diff, because "the prompt changed" is not an answer to
/// "what did you change in the prompt". Nested keys compare by canonical
/// form, so key order never shows up as a change.
const SEP = " › ";

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function flatten(value, prefix, out) {
  if (isPlainObject(value) && Object.keys(value).length > 0) {
    for (const key of Object.keys(value)) flatten(value[key], prefix === null ? key : prefix + SEP + key, out);
  } else if (prefix !== null) {
    out.set(prefix, value);
  }
  return out;
}

function leaves(config) {
  if (config === undefined || config === null) return new Map();
  if (!isPlainObject(config)) return new Map([["(value)", config]]);
  return flatten(config, null, new Map());
}

/// Hash of every leaf, which is all a redacted entry keeps: enough to say
/// which settings changed next time, without storing what they were.
function leafRootsOf(config) {
  const roots = {};
  for (const [key, value] of leaves(config)) roots[key] = hashOf(value === undefined ? null : value);
  return roots;
}

function lineDiff(from, to) {
  const a = from.split("\n");
  const b = to.split("\n");
  // Longest common subsequence over lines. Prompts are small; past this size
  // a line diff is no longer what a reader wants anyway.
  if (a.length * b.length > 250000) return null;
  const dp = Array.from({ length: a.length + 1 }, () => new Uint32Array(b.length + 1));
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const out = [];
  let i = 0;
  let j = 0;
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) {
      i++;
      j++;
    } else if (i < a.length && (j === b.length || dp[i + 1][j] >= dp[i][j + 1])) {
      // Removals before additions, the order every diff reader expects.
      out.push("- " + a[i++]);
    } else {
      out.push("+ " + b[j++]);
    }
  }
  return out.slice(0, 200);
}

function diff(before, after) {
  const a = leaves(before);
  const b = leaves(after);
  const keys = Array.from(new Set([...a.keys(), ...b.keys()])).sort();
  const changes = [];
  for (const key of keys) {
    const was = a.get(key);
    const now = b.get(key);
    const same =
      was !== undefined && now !== undefined ? stableStringify(was) === stableStringify(now) : was === now;
    if (same) continue;
    const change = { key, from: was === undefined ? null : was, to: now === undefined ? null : now };
    if (typeof change.from === "string" && typeof change.to === "string" &&
        (change.from.includes("\n") || change.to.includes("\n") || change.from.length > 80 || change.to.length > 80)) {
      const lines = lineDiff(change.from, change.to);
      if (lines) change.lines = lines;
    }
    changes.push(change);
  }
  return changes;
}

/// Which leaves differ between two leafRootsOf() maps. Used for redacted
/// entries, which have no values to diff.
function diffRoots(before, after) {
  const a = before || {};
  const b = after || {};
  return Array.from(new Set([...Object.keys(a), ...Object.keys(b)]))
    .sort()
    .filter((key) => a[key] !== b[key])
    .map((key) => ({ key }));
}

function readEntries(file) {
  if (!fs.existsSync(file)) return [];
  return core.readEntries(fs.readFileSync(file));
}

const verifyEntries = core.verifyEntries;

// One writer at a time. Two CI jobs appending at once would both link to the
// same previous entry and fork the chain, which verify() would then -- rightly
// -- report as tampering. A lock file created with O_EXCL is enough on one
// machine and on the shared filesystems CI runners use.
function withLock(file, fn) {
  const lock = file + ".lock";
  const token = process.pid + "-" + Date.now() + "-" + Math.random().toString(36).slice(2);
  const deadline = Date.now() + 20000;
  for (;;) {
    try {
      fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
      fs.writeFileSync(lock, token, { flag: "wx" });
      break;
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      // A lock older than 15 seconds belongs to a writer that died. Move it
      // aside under a unique name first, so two waiters cannot both decide it
      // is stale and then delete each other's fresh lock.
      try {
        if (Date.now() - fs.statSync(lock).mtimeMs > 15000) {
          const stale = lock + "." + token;
          fs.renameSync(lock, stale);
          fs.unlinkSync(stale);
        }
      } catch (ignored) {}
      if (Date.now() > deadline) throw new Error("audit log " + file + " is locked by another writer (" + lock + ")");
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
    }
  }
  try {
    return fn();
  } finally {
    // Only remove the lock if it is still ours.
    try {
      if (fs.readFileSync(lock, "utf8") === token) fs.unlinkSync(lock);
    } catch (ignored) {}
  }
}

// Who to credit when the caller does not say: an explicit setting first, then
// the CI system's identity, then the local git user. CI identities are the
// trustworthy ones, because branch protection stands behind them.
function defaultActor() {
  const env = process.env;
  if (env.GERMLINE_ACTOR) return env.GERMLINE_ACTOR;
  if (env.GITHUB_ACTOR) return "github:" + env.GITHUB_ACTOR;
  if (env.GITLAB_USER_LOGIN) return "gitlab:" + env.GITLAB_USER_LOGIN;
  try {
    const email = require("child_process")
      .execFileSync("git", ["config", "user.email"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] })
      .trim();
    if (email) return email;
  } catch (ignored) {}
  return env.USER || env.USERNAME || "unknown";
}

function openAuditLog(file = path.join(".germline", "audit.jsonl"), options = {}) {
  const clock = options.clock || (() => new Date().toISOString());

  function entries() {
    return readEntries(file);
  }

  function append(body) {
    return withLock(file, () => appendUnlocked(body));
  }

  function appendUnlocked(body) {
    const existing = entries();
    const check = verifyEntries(existing);
    if (!check.ok) {
      // Appending to a broken chain would launder the break: the new entry
      // would link to a hash nobody can justify. Refuse and say why.
      throw new Error(
        "refusing to append to an audit log that does not verify (" +
          check.problems[0].reason +
          " at entry " +
          check.problems[0].seq +
          "). Run `germline verify` to see every problem."
      );
    }
    // Normalise through JSON first, so what is hashed is exactly what is
    // written: a Buffer or Date (anything with toJSON) would otherwise hash
    // one way and serialise another, and poison the log.
    const entry = JSON.parse(
      JSON.stringify({
        format: FORMAT,
        seq: existing.length,
        prev: existing.length ? existing[existing.length - 1].hash : GENESIS,
        ts: clock(),
        ...body,
      })
    );
    entry.hash = hashOf(entry);
    fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
    // A file whose last line lost its newline would otherwise glue the new
    // entry onto it and corrupt both.
    let lead = "";
    if (fs.existsSync(file)) {
      const size = fs.statSync(file).size;
      if (size > 0) {
        const fd = fs.openSync(file, "r");
        const last = Buffer.alloc(1);
        fs.readSync(fd, last, 0, 1, size - 1);
        fs.closeSync(fd);
        if (last[0] !== 0x0a) lead = "\n";
      }
    }
    const fd = fs.openSync(file, "a");
    try {
      fs.writeSync(fd, lead + JSON.stringify(entry) + "\n");
    } finally {
      fs.closeSync(fd);
    }
    return entry;
  }

  /// Record one configuration change.
  ///
  /// `system` and `actor` are required, because "something changed" is not
  /// an audit record and "someone changed something" barely is. `eval` is
  /// whatever justified the change; Germline does not interpret it, only
  /// fixes it in place. Pass `redact: true` to keep only the roots of
  /// before and after, for configs that must not sit in a shared file.
  function record(input) {
    if (!input || typeof input !== "object") throw new TypeError("record() needs an object");
    const { system, actor, before, after, reason, eval: evaluation, ticket, redact, commit } = input;
    if (!system || typeof system !== "string") throw new TypeError("record() needs a system name");
    if (!actor || typeof actor !== "string") throw new TypeError("record() needs an actor: who made the change");
    if (after === undefined) throw new TypeError("record() needs the config after the change");

    // A redacted entry keeps hashes, not values, so the next redacted entry
    // can only diff against those. `beforeRoots` and `beforeRoot` carry them
    // forward when the caller (track) has no plaintext `before`.
    const afterRoots = leafRootsOf(after);
    const beforeRoots = before !== undefined ? leafRootsOf(before) : input.beforeRoots;
    const changes = redact ? diffRoots(beforeRoots, afterRoots) : diff(before, after);
    const body = {
      kind: "change",
      system,
      actor,
      reason: reason || null,
      ticket: ticket || null,
      commit: commit || null,
      committedAt: input.committedAt || null,
      recordedBy: input.recordedBy || null,
      // Who approved the change, from the code host's API (see sdk/github.js).
      approval: input.approval || undefined,
      beforeRoot: before !== undefined ? configRootOf(before) : input.beforeRoot || null,
      configRoot: configRootOf(after),
      changes,
      eval: evaluation === undefined ? null : evaluation,
    };
    if (redact) {
      body.redacted = true;
      body.leafRoots = afterRoots;
    } else {
      body.before = before === undefined ? null : before;
      body.after = after;
    }
    return append(body);
  }

  /// Record `config` for `system` only if it differs from the last config
  /// recorded for that system. The call to put wherever a config is loaded or
  /// deployed: it is a no-op on every run where nothing changed, so it can sit
  /// on a hot path without filling the log. Returns the entry, or null.
  ///
  ///     openAuditLog().track("support-agent", config, { actor: "deploy-bot" });
  function track(system, config, meta = {}) {
    const root = configRootOf(config);
    const last = lastChange(system);
    if (last && last.configRoot === root) return null;
    return record({
      ...meta,
      system,
      actor: meta.actor || defaultActor(),
      before: last && last.after !== undefined ? last.after : undefined,
      beforeRoot: last ? last.configRoot : null,
      beforeRoots: last ? last.leafRoots || (last.after !== undefined ? leafRootsOf(last.after) : undefined) : undefined,
      after: config,
    });
  }

  function lastChange(system) {
    const all = entries();
    for (let i = all.length - 1; i >= 0; i--) {
      if (all[i] && all[i].kind === "change" && all[i].system === system) return all[i];
    }
    return null;
  }

  /// Record a search run from search() or optimise() as the evidence for
  /// shipping its best configuration.
  function recordSearch(run, input) {
    if (!run || !run.best) throw new TypeError("recordSearch() needs a run with a best configuration");
    return record({
      ...input,
      after: run.best.config,
      eval: {
        source: "germline.search",
        strategy: run.strategy || "evolution",
        fitnessBps: run.best.fitnessBps,
        evaluations: run.evaluations || (run.population ? run.population.length : null),
        verdict: run.verdict || null,
        baselineMedian: run.baseline ? run.baseline.median : null,
        ...(input && input.eval),
      },
    });
  }

  function verify() {
    return verifyEntries(entries());
  }

  /// Pin the current head on 0G Chain, and optionally publish the log to 0G
  /// Storage first so the anchor can point at where to fetch it.
  ///
  /// With `registry` (a GermlineAnchor address), the head is stored in the
  /// append-only registry under this log's id. Without it, the head goes into
  /// a zero-value transaction to the signer's own address: no contract
  /// needed, but weaker, as the header of this file explains.
  async function anchor({ signer, upload = false, storage, registry } = {}) {
    if (!signer) throw new TypeError("anchor() needs an ethers signer connected to 0G Chain");
    const check = verify();
    if (!check.ok) throw new Error("refusing to anchor an audit log that does not verify");
    if (check.entries === 0) throw new Error("nothing to anchor: the audit log is empty");
    // Nothing recorded since the last anchor: another transaction would pay
    // gas to say the same thing again.
    const all = entries();
    if (all[all.length - 1].kind === "anchor") return null;

    let published = null;
    if (upload) {
      const store = storage || require("../lib/storage");
      published = await store.publish(fs.readFileSync(file, "utf8"), { kind: "audit-log", upload: true });
      // Asked to publish and could not: say so before spending gas, rather
      // than anchor with no storage root and let the caller think it worked.
      if (published.stored !== "0g") {
        throw new Error("upload to 0G Storage failed, nothing was anchored: " + (published.note || "no uploader available"));
      }
    }

    const head = check.head;
    const anchorer = await signer.getAddress();
    const network = await signer.provider.getNetwork();
    const storageRoot =
      published && published.stored === "0g" && published.storageRoot ? published.storageRoot : null;

    let tx;
    let mode;
    let contract = null;
    if (registry) {
      const { Contract, ZeroHash } = require("ethers");
      contract = new Contract(registry, REGISTRY_ABI, signer);
      tx = await contract.anchor(check.logId, check.entries, head, storageRoot || ZeroHash);
      mode = "registry";
    } else {
      tx = await signer.sendTransaction({ to: anchorer, value: 0, data: ANCHOR_TAG + head.slice(2) });
      mode = "tx";
    }
    const receipt = await tx.wait();

    // Read the index the registry assigned from its own event, rather than
    // predicting it beforehand and racing another anchor from the same key.
    let index = null;
    if (contract) {
      for (const log of receipt.logs || []) {
        let parsed = null;
        try {
          parsed = contract.interface.parseLog(log);
        } catch (ignored) {}
        if (parsed && parsed.name === "Anchored") index = Number(parsed.args.index);
      }
      if (index === null) throw new Error("anchor transaction " + receipt.hash + " emitted no Anchored event");
    }

    return append({
      kind: "anchor",
      mode,
      logId: check.logId,
      anchoredHead: head,
      anchoredEntries: check.entries,
      chainId: Number(network.chainId),
      registry: registry || null,
      index,
      txHash: receipt.hash || tx.hash,
      block: receipt.blockNumber,
      anchorer,
      storage: published
        ? {
            stored: published.stored,
            uri: published.uri,
            storageRoot: published.storageRoot || null,
            txHash: published.txHash || null,
          }
        : null,
    });
  }

  /// Check the log against the chain. Returns
  ///
  ///   { ok, results, warnings, logId, anchorers }
  ///
  /// where `results` has one row per anchor checked: every anchor the
  /// registry holds for this log (whether or not the log still mentions it),
  /// plus every plain-transaction anchor the log lists.
  ///
  /// `logId` and `anchorer` pin what the auditor expects. Leave them out and
  /// the check still runs, using what the log claims, with a warning that a
  /// wholesale rewrite under a new id or key would not be caught.
  async function verifyChain(provider, options = {}) {
    return core.verifyChain(entries(), provider, options);
  }

  /// The per-anchor rows of verifyChain(), kept for callers of 0.3.0.
  async function verifyAnchors(provider, options) {
    return (await verifyChain(provider, options)).results;
  }

  /// Record a review of an earlier change entry: who or what reviewed it,
  /// and what they concluded. Bound to the reviewed entry by its hash, so a
  /// review cannot be moved onto a different change.
  function recordReview(input = {}) {
    const all = entries();
    const target = all[input.seq];
    if (!target || target.kind !== "change") throw new TypeError("recordReview() needs the seq of a change entry");
    if (!input.reviewer || typeof input.reviewer !== "string") throw new TypeError("recordReview() needs a reviewer");
    return append({
      kind: "review",
      reviews: input.seq,
      reviewsHash: target.hash,
      system: target.system,
      reviewer: input.reviewer,
      summary: input.summary || null,
      risk: input.risk || null,
      concerns: Array.isArray(input.concerns) ? input.concerns : [],
      evidence: input.evidence || null,
    });
  }

  /// The most recent anchor entry, or null. Its `anchoredHead` is the value
  /// a GermlineGuard expects an agent to claim (contracts/GermlineGuard.sol).
  function lastAnchor() {
    const all = entries();
    for (let i = all.length - 1; i >= 0; i--) if (all[i].kind === "anchor") return all[i];
    return null;
  }

  return { file, entries, record, track, lastChange, lastAnchor, recordSearch, recordReview, verify, anchor, verifyChain, verifyAnchors };
}

module.exports = {
  openAuditLog,
  defaultActor,
  verifyEntries,
  diff,
  leafRootsOf,
  configRootOf,
  ANCHOR_TAG,
  REGISTRY_ABI,
  FORMAT,
  GENESIS,
};
