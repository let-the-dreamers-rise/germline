// Germline log writer for the browser: builds the same change and anchor
// entries as sdk/audit.js, so a log made in web/anchor.html verifies with
// `npx germline verify` and the CLI can keep appending to it (a test checks
// both). Hashing comes from verify-core.js, the one shared implementation.
//
// No Node APIs. Needs ethers and GermlineVerify (verify-core.js) loaded first.
//
// MIT licensed. https://github.com/let-the-dreamers-rise/germline

(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory(require("./verify-core.js"));
  else root.GermlineWrite = factory(root.GermlineVerify);
})(typeof self !== "undefined" ? self : this, function (core) {
  "use strict";

  const FORMAT = "germline.audit/1";
  const GENESIS = "0x" + "0".repeat(64);
  const SEP = " › ";

  const isPlainObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

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

  // Which settings moved, as sdk/audit.js diff() reports them (without its
  // optional line-by-line view of long strings, which nothing verifies).
  function diff(before, after) {
    const a = leaves(before);
    const b = leaves(after);
    const keys = Array.from(new Set([...a.keys(), ...b.keys()])).sort();
    const changes = [];
    for (const key of keys) {
      const was = a.get(key);
      const now = b.get(key);
      const same =
        was !== undefined && now !== undefined ? core.stableStringify(was) === core.stableStringify(now) : was === now;
      if (!same) changes.push({ key, from: was === undefined ? null : was, to: now === undefined ? null : now });
    }
    return changes;
  }

  function seal(existing, body, ts) {
    const check = core.verifyEntries(existing);
    if (!check.ok) throw new Error("this log does not verify (" + check.problems[0].reason + " at entry " + check.problems[0].seq + "); not appending");
    const entry = JSON.parse(
      JSON.stringify({
        format: FORMAT,
        seq: existing.length,
        prev: existing.length ? existing[existing.length - 1].hash : GENESIS,
        ts: ts || new Date().toISOString(),
        ...body,
      })
    );
    entry.hash = core.hashOf(entry);
    return entry;
  }

  /// The config this system had after its last recorded change, or undefined.
  function lastConfig(existing, system) {
    for (let i = existing.length - 1; i >= 0; i--) {
      const e = existing[i];
      if (e.kind === "change" && e.system === system && e.after !== undefined) return e.after;
    }
    return undefined;
  }

  function change(existing, { system, actor, reason, after, ts, commit, committedAt }) {
    if (!system || typeof system !== "string") throw new TypeError("a change needs a system name");
    if (!actor || typeof actor !== "string") throw new TypeError("a change needs an actor: who made it");
    if (after === undefined) throw new TypeError("a change needs the config after it");
    const before = lastConfig(existing, system);
    return seal(
      existing,
      {
        kind: "change",
        system,
        actor,
        reason: reason || null,
        ticket: null,
        commit: commit || null,
        committedAt: committedAt || null,
        recordedBy: null,
        beforeRoot: before !== undefined ? core.configRootOf(before) : null,
        configRoot: core.configRootOf(after),
        changes: diff(before, after),
        eval: null,
        before: before === undefined ? null : before,
        after,
      },
      ts
    );
  }

  function anchor(existing, a, ts) {
    return seal(
      existing,
      {
        kind: "anchor",
        mode: "registry",
        logId: a.logId,
        anchoredHead: a.head,
        anchoredEntries: a.entries,
        chainId: Number(a.chainId),
        registry: a.registry,
        index: Number(a.index),
        txHash: a.txHash,
        block: Number(a.block),
        anchorer: a.anchorer,
        storage: null,
      },
      ts
    );
  }

  function serialize(entries) {
    return entries.map((e) => JSON.stringify(e)).join("\n") + (entries.length ? "\n" : "");
  }

  /// Commits already in the log, so a sync never records one twice.
  function recordedCommits(existing) {
    return new Set(existing.filter((e) => e.kind === "change" && e.commit).map((e) => e.commit));
  }

  return { change, anchor, serialize, lastConfig, diff, recordedCommits };
});
