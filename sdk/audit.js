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

const FORMAT = "germline.audit/1";
const GENESIS = "0x" + "0".repeat(64);

// Four bytes in front of the head hash in the anchor transaction's data, so
// an anchor is recognisable on an explorer and cannot be confused with an
// arbitrary 32-byte payload someone else sent. ASCII "grml".
const ANCHOR_TAG = "0x67726d6c";

// Clocks on different CI runners disagree a little. Beyond this, an entry
// whose timestamp runs backwards, or claims to postdate the block that
// anchored it, is reported.
const CLOCK_SKEW_MS = 5 * 60 * 1000;

const REGISTRY_ABI = [
  "function anchor(bytes32 logId, uint64 entries, bytes32 head, bytes32 storageRoot) returns (uint256)",
  "function anchorCount(bytes32 logId, address anchorer) view returns (uint256)",
  "function anchorsOf(bytes32 logId, address anchorer, uint256 from, uint256 count) view returns (tuple(uint64 covered, uint64 timestamp, uint64 blockNumber, bytes32 head, bytes32 storageRoot)[])",
  "event Anchored(bytes32 indexed logId, address indexed anchorer, uint256 indexed index, uint64 entries, bytes32 head, bytes32 storageRoot)",
];
const PAGE = 100;

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

const ISO_TS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;

function readEntries(file) {
  if (!fs.existsSync(file)) return [];
  const text = fs.readFileSync(file, "utf8");
  const entries = [];
  text.split("\n").forEach((line, index) => {
    if (!line.trim()) return;
    try {
      const entry = JSON.parse(line);
      // Every entry is an object. Anything else (null, a number, an array)
      // is corruption, and must not crash the verifier.
      if (entry === null || typeof entry !== "object" || Array.isArray(entry)) throw new Error("not an object");
      // The hash covers the parsed value, so the bytes must be the one
      // serialisation of it: no duplicate keys, no padded numbers, no escapes
      // that other parsers read differently. Our writer always emits this.
      if (JSON.stringify(entry) !== line.replace(/\r$/, "")) {
        Object.defineProperty(entry, "__noncanonical", { value: true, enumerable: false });
      }
      entries.push(entry);
    } catch (error) {
      // An unparseable line is itself evidence of tampering or corruption,
      // so keep a placeholder that verify() will reject rather than skip it.
      entries.push({ __unparseable: true, line: index + 1 });
    }
  });
  return entries;
}

function withoutHash(entry) {
  const { hash, ...rest } = entry;
  return rest;
}

/// Check every link in the chain. Never throws on a bad log: a verifier that
/// crashes on the thing it is meant to detect is not a verifier.
function verifyEntries(entries) {
  const problems = [];
  const warnings = [];
  let prev = GENESIS;
  let lastTs = null;
  entries.forEach((entry, index) => {
    if (!entry.__unparseable) {
      // ISO 8601 with an explicit zone, so every verifier reads the same instant.
      const ts = typeof entry.ts === "string" && ISO_TS.test(entry.ts) ? Date.parse(entry.ts) : NaN;
      if (!Number.isFinite(ts)) {
        problems.push({ seq: index, reason: "timestamp " + JSON.stringify(entry.ts) + " is not a date" });
      } else {
        if (lastTs !== null && ts < lastTs - CLOCK_SKEW_MS) {
          warnings.push({ seq: index, reason: "timestamp is earlier than the entry before it (backdated, or a badly wrong clock)" });
        }
        lastTs = ts;
      }
    }
    if (entry.__unparseable) {
      problems.push({ seq: index, reason: "line " + entry.line + " is not valid JSON" });
      prev = null;
      return;
    }
    if (entry.__noncanonical) {
      problems.push({ seq: index, reason: "line is not in canonical form (duplicate keys, reformatted numbers or escapes)" });
    }
    if (entry.format !== FORMAT) {
      problems.push({ seq: index, reason: "unknown format " + JSON.stringify(entry.format) });
    }
    if (entry.seq !== index) {
      problems.push({ seq: index, reason: "sequence number " + entry.seq + ", expected " + index });
    }
    if (prev !== null && entry.prev !== prev) {
      problems.push({ seq: index, reason: "does not link to the entry before it" });
    }
    let expected = null;
    try {
      expected = hashOf(withoutHash(entry));
    } catch (error) {
      problems.push({ seq: index, reason: "cannot be hashed: " + error.message });
    }
    if (expected !== null && entry.hash !== expected) {
      problems.push({ seq: index, reason: "contents do not match its hash (edited after writing)" });
    }
    if (entry.kind === "review") {
      const target = entries[entry.reviews];
      if (!Number.isInteger(entry.reviews) || entry.reviews >= index || !target || target.hash !== entry.reviewsHash) {
        problems.push({ seq: index, reason: "review does not point at an earlier entry with the hash it names" });
      }
    }
    if (entry.kind === "change" && entry.after !== undefined && entry.configRoot !== configRootOf(entry.after)) {
      problems.push({ seq: index, reason: "stored config does not match its recorded root" });
    }
    prev = entry.hash;
  });
  const head = entries.length ? entries[entries.length - 1].hash || null : GENESIS;
  const logId = entries.length && !entries[0].__unparseable ? entries[0].hash || null : null;
  return { ok: problems.length === 0, entries: entries.length, head, logId, problems, warnings };
}

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

async function readRegistryHistory(registry, logId, anchorer) {
  const count = Number(await registry.anchorCount(logId, anchorer));
  const all = [];
  for (let from = 0; from < count; from += PAGE) {
    const page = await registry.anchorsOf(logId, anchorer, from, PAGE);
    for (const a of page) {
      all.push({
        index: all.length,
        entries: Number(a.covered),
        timestamp: Number(a.timestamp),
        blockNumber: Number(a.blockNumber),
        head: a.head,
        storageRoot: a.storageRoot,
      });
    }
  }
  return all;
}

// Every entry an anchor covers must have been written before the block that
// anchored it. A covered entry that claims a later time was backdated into
// the past, or the log was rebuilt after the fact.
function timestampProblem(all, coveredEntries, blockTimeSec) {
  const limit = blockTimeSec * 1000 + CLOCK_SKEW_MS;
  for (let i = 0; i < coveredEntries && i < all.length; i++) {
    const ts = Date.parse(all[i].ts);
    if (Number.isFinite(ts) && ts > limit) {
      return "entry " + i + " claims " + all[i].ts + ", after the block that anchored it";
    }
  }
  return null;
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
    const all = entries();
    const local = verifyEntries(all);
    const results = [];
    const warnings = [];
    const logId = options.logId || local.logId;
    const anchorEntries = all.filter((e) => e && e.kind === "anchor");

    if (!options.logId) warnings.push("log id not pinned: pass the id you were given, or a rewrite under a new id will not be caught");
    if (options.logId && local.logId && options.logId.toLowerCase() !== local.logId.toLowerCase()) {
      results.push({ seq: 0, source: "pin", ok: false, reason: "this log's id is " + local.logId + ", not the pinned " + options.logId });
    }

    const pinnedAnchorers = options.anchorer ? [].concat(options.anchorer).map((a) => a.toLowerCase()) : null;
    if (!pinnedAnchorers) warnings.push("anchorer not pinned: pass the address you expect, or anchors from any key are accepted");
    const anchorers = pinnedAnchorers || Array.from(new Set(anchorEntries.map((e) => String(e.anchorer).toLowerCase())));

    for (const e of anchorEntries) {
      if (pinnedAnchorers && !pinnedAnchorers.includes(String(e.anchorer).toLowerCase())) {
        results.push({ seq: e.seq, source: "pin", ok: false, reason: "anchored by " + e.anchorer + ", which is not a pinned anchorer" });
      }
    }

    // Registry anchors: the chain, not the log, is the list of what to check.
    // The registry address, like the id and the anchorer, should come from
    // the verifier: a forger who deletes every anchor record also deletes the
    // only mention of the registry. The CLI supplies the known deployment for
    // the chain it is pointed at.
    const registry = options.registry || (anchorEntries.find((e) => e.mode === "registry") || {}).registry;
    if (!options.registry) {
      warnings.push(
        registry
          ? "registry taken from the log itself: pass the registry address so deleted anchor records are caught"
          : "no registry given: anchors whose records were deleted from the log cannot be found"
      );
    }
    if (registry) {
      const { Contract } = require("ethers");
      const contract = new Contract(registry, REGISTRY_ABI, provider);
      for (const who of anchorers) {
        let history;
        try {
          history = await readRegistryHistory(contract, logId, who);
        } catch (error) {
          results.push({ seq: null, source: "registry", ok: false, reason: "could not read registry: " + (error.shortMessage || error.message) });
          continue;
        }
        for (const a of history) {
          const listed = anchorEntries.find(
            (e) => e.mode === "registry" && e.index === a.index && String(e.anchorer).toLowerCase() === who
          );
          const row = { seq: listed ? listed.seq : null, source: "registry", index: a.index, anchorer: who, entries: a.entries, ok: false, reason: null };
          const at = all[a.entries - 1];
          if (!at) row.reason = "registry says the log had " + a.entries + " entries; it now has " + all.length + " (truncated)";
          else if (at.hash !== a.head) row.reason = "the log no longer has the anchored head at entry " + (a.entries - 1) + " (rewritten)";
          else row.reason = timestampProblem(all, a.entries, a.timestamp);
          if (!row.reason && !listed) {
            warnings.push("registry anchor #" + a.index + " by " + who + " is not recorded in the log (the anchor record was removed or never written)");
          }
          row.ok = row.reason === null;
          results.push(row);
        }
        // An anchor record in the log that the registry has never heard of.
        for (const e of anchorEntries) {
          if (e.mode !== "registry" || String(e.anchorer).toLowerCase() !== who) continue;
          if (!history.some((a) => a.index === e.index && a.head === e.anchoredHead)) {
            results.push({ seq: e.seq, source: "registry", ok: false, reason: "the log lists anchor #" + e.index + " but the registry does not hold it" });
          }
        }
        // A verifier who pins an anchorer expects that key to have anchored
        // this log. Finding nothing is a failure, not a footnote.
        if (history.length === 0 && pinnedAnchorers) {
          results.push({ seq: null, source: "pin", ok: false, reason: "the registry holds no anchors for this log from " + who });
        }
      }
    }

    // Plain-transaction anchors: only the ones the log still lists.
    for (const e of anchorEntries) {
      if (e.mode === "registry") continue;
      const row = { seq: e.seq, source: "tx", txHash: e.txHash, ok: false, reason: null };
      try {
        const tx = await provider.getTransaction(e.txHash);
        const expected = (ANCHOR_TAG + e.anchoredHead.slice(2)).toLowerCase();
        const at = all[e.anchoredEntries - 1];
        if (!tx) row.reason = "transaction not found on this chain";
        else if (String(tx.data).toLowerCase() !== expected) row.reason = "transaction data does not carry this head";
        else if (!at || at.hash !== e.anchoredHead) row.reason = "the log no longer has this head at the anchored position (rewritten)";
        else if (tx.from.toLowerCase() !== String(e.anchorer).toLowerCase()) row.reason = "sent by a different address than recorded";
        else {
          const block = tx.blockNumber != null && provider.getBlock ? await provider.getBlock(tx.blockNumber) : null;
          row.reason = block ? timestampProblem(all, e.anchoredEntries, Number(block.timestamp)) : null;
        }
      } catch (error) {
        row.reason = "could not check: " + (error.shortMessage || error.message);
      }
      row.ok = row.reason === null;
      results.push(row);
    }
    if (anchorEntries.some((e) => e.mode !== "registry")) {
      warnings.push("some anchors are plain transactions: removing their records from the log would not be detected; use a registry");
    }
    if (results.length === 0) warnings.push("nothing was anchored: until it is, the whole log can be rewritten undetectably");
    // A pinned anchorer that no checked anchor came from is a failure, with
    // or without a registry: the verifier expected that key to vouch for it.
    for (const who of pinnedAnchorers || []) {
      const vouched = results.some((r) => r.ok && r.source !== "pin" && (r.anchorer ? String(r.anchorer).toLowerCase() === who : true));
      const reported = results.some((r) => r.source === "pin" && String(r.reason || "").toLowerCase().includes(who));
      if (!vouched && !reported) results.push({ seq: null, source: "pin", ok: false, reason: "no valid anchor from the pinned anchorer " + who });
    }

    return { ok: local.ok && results.every((r) => r.ok), results, warnings, logId, anchorers };
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
