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

/// Which top-level keys changed, with their old and new values. Nested
/// objects compare by canonical form, so key order never shows up as a
/// change.
function diff(before, after) {
  const a = before || {};
  const b = after || {};
  const keys = Array.from(new Set([...Object.keys(a), ...Object.keys(b)])).sort();
  const changes = [];
  for (const key of keys) {
    const was = a[key];
    const now = b[key];
    const same =
      was !== undefined && now !== undefined
        ? stableStringify(was) === stableStringify(now)
        : was === now;
    if (!same) {
      changes.push({
        key,
        from: was === undefined ? null : was,
        to: now === undefined ? null : now,
      });
    }
  }
  return changes;
}

function readEntries(file) {
  if (!fs.existsSync(file)) return [];
  const text = fs.readFileSync(file, "utf8");
  const entries = [];
  text.split("\n").forEach((line, index) => {
    if (!line.trim()) return;
    try {
      entries.push(JSON.parse(line));
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
  let prev = GENESIS;
  entries.forEach((entry, index) => {
    if (entry.__unparseable) {
      problems.push({ seq: index, reason: "line " + entry.line + " is not valid JSON" });
      prev = null;
      return;
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
    if (entry.kind === "change" && entry.after !== undefined && entry.configRoot !== configRootOf(entry.after)) {
      problems.push({ seq: index, reason: "stored config does not match its recorded root" });
    }
    prev = entry.hash;
  });
  const head = entries.length ? entries[entries.length - 1].hash || null : GENESIS;
  return { ok: problems.length === 0, entries: entries.length, head, problems };
}

function openAuditLog(file = path.join(".germline", "audit.jsonl"), options = {}) {
  const clock = options.clock || (() => new Date().toISOString());

  function entries() {
    return readEntries(file);
  }

  function append(body) {
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
    const entry = {
      format: FORMAT,
      seq: existing.length,
      prev: existing.length ? existing[existing.length - 1].hash : GENESIS,
      ts: clock(),
      ...body,
    };
    entry.hash = hashOf(entry);
    fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
    fs.appendFileSync(file, JSON.stringify(entry) + "\n", "utf8");
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
    const { system, actor, before, after, reason, eval: evaluation, ticket, redact } = input;
    if (!system || typeof system !== "string") throw new TypeError("record() needs a system name");
    if (!actor || typeof actor !== "string") throw new TypeError("record() needs an actor: who made the change");
    if (after === undefined) throw new TypeError("record() needs the config after the change");

    const changes = diff(before, after);
    const body = {
      kind: "change",
      system,
      actor,
      reason: reason || null,
      ticket: ticket || null,
      beforeRoot: configRootOf(before),
      configRoot: configRootOf(after),
      changes: redact ? changes.map((c) => ({ key: c.key })) : changes,
      eval: evaluation === undefined ? null : evaluation,
    };
    if (!redact) {
      body.before = before === undefined ? null : before;
      body.after = after;
    }
    return append(body);
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
  /// The transaction is a zero-value send to the signer's own address with
  /// the tagged head hash as data. No contract is needed, so there is nothing
  /// to deploy and nothing that can be upgraded out from under a customer.
  async function anchor({ signer, upload = false, storage } = {}) {
    if (!signer) throw new TypeError("anchor() needs an ethers signer connected to 0G Chain");
    const check = verify();
    if (!check.ok) throw new Error("refusing to anchor an audit log that does not verify");
    if (check.entries === 0) throw new Error("nothing to anchor: the audit log is empty");

    let published = null;
    if (upload) {
      const store = storage || require("../lib/storage");
      published = await store.publish(fs.readFileSync(file, "utf8"), { kind: "audit-log" });
    }

    const head = check.head;
    const to = await signer.getAddress();
    const tx = await signer.sendTransaction({ to, value: 0, data: ANCHOR_TAG + head.slice(2) });
    const receipt = await tx.wait();
    const network = await signer.provider.getNetwork();

    return append({
      kind: "anchor",
      anchoredHead: head,
      anchoredEntries: check.entries,
      chainId: Number(network.chainId),
      txHash: receipt.hash || tx.hash,
      block: receipt.blockNumber,
      anchorer: to,
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

  /// Check every anchor in the log against the chain it claims to be on.
  /// Returns one result per anchor; a log with no anchors returns [].
  async function verifyAnchors(provider) {
    const all = entries();
    const results = [];
    for (const entry of all) {
      if (entry.kind !== "anchor") continue;
      const result = { seq: entry.seq, txHash: entry.txHash, ok: false, reason: null };
      try {
        const tx = await provider.getTransaction(entry.txHash);
        const expected = (ANCHOR_TAG + entry.anchoredHead.slice(2)).toLowerCase();
        const atSeq = all[entry.anchoredEntries - 1];
        if (!tx) result.reason = "transaction not found on this chain";
        else if (String(tx.data).toLowerCase() !== expected) result.reason = "transaction data does not carry this head";
        else if (!atSeq || atSeq.hash !== entry.anchoredHead) result.reason = "the log no longer has this head at the anchored position (rewritten)";
        else if (tx.from.toLowerCase() !== String(entry.anchorer).toLowerCase()) result.reason = "sent by a different address than recorded";
        else result.ok = true;
      } catch (error) {
        result.reason = "could not check: " + (error.shortMessage || error.message);
      }
      results.push(result);
    }
    return results;
  }

  return { file, entries, record, recordSearch, verify, anchor, verifyAnchors };
}

module.exports = { openAuditLog, verifyEntries, diff, configRootOf, ANCHOR_TAG, FORMAT, GENESIS };
