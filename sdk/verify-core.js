// Germline verification core: the one implementation of "does this log hold
// up", shared by the CLI (sdk/audit.js) and the browser verifier
// (web/verify.html loads a byte-identical copy at web/verify-core.js; a test
// fails if the two drift). Before this file existed the page was a hand port
// of the CLI, and the port silently skipped three chain checks.
//
// No Node APIs: it runs in a browser as-is. The only dependency is ethers,
// passed in by whichever environment loads it.
//
// MIT licensed. https://github.com/let-the-dreamers-rise/germline

(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory(require("ethers"));
  else root.GermlineVerify = factory(root.ethers);
})(typeof self !== "undefined" ? self : this, function (ethers) {
  "use strict";

  const FORMAT = "germline.audit/1";
  const GENESIS = "0x" + "0".repeat(64);
  // ASCII "grml": marks a plain-transaction anchor's data.
  const ANCHOR_TAG = "0x67726d6c";
  // Clocks on different CI runners disagree a little; beyond this, a
  // backwards or post-anchor timestamp is reported.
  const CLOCK_SKEW_MS = 5 * 60 * 1000;
  // Deep enough for any real config, shallow enough that a hostile file
  // can't overflow the stack of whatever is verifying it.
  const MAX_DEPTH = 256;
  const PAGE = 100;
  const REGISTRY_ABI = [
    "function anchor(bytes32 logId, uint64 entries, bytes32 head, bytes32 storageRoot) returns (uint256)",
    "function anchorCount(bytes32 logId, address anchorer) view returns (uint256)",
    "function anchorsOf(bytes32 logId, address anchorer, uint256 from, uint256 count) view returns (tuple(uint64 covered, uint64 timestamp, uint64 blockNumber, bytes32 head, bytes32 storageRoot)[])",
    "event Anchored(bytes32 indexed logId, address indexed anchorer, uint256 indexed index, uint64 entries, bytes32 head, bytes32 storageRoot)",
  ];

  // Keys sorted at every level, no whitespace. Only JSON values reach this
  // (entries are parsed from text), so it needs no Date or bigint cases.
  function stableStringify(value) {
    const seen = new Set();
    return (function write(v, depth) {
      if (depth > MAX_DEPTH) throw new TypeError("value is nested deeper than " + MAX_DEPTH + " levels");
      if (v === null) return "null";
      const t = typeof v;
      if (t === "number") {
        if (!Number.isFinite(v)) throw new TypeError("non-finite number, which has no canonical form");
        return JSON.stringify(v);
      }
      if (t === "string" || t === "boolean") return JSON.stringify(v);
      if (t !== "object") throw new TypeError("cannot hash a " + t);
      if (seen.has(v)) throw new TypeError("cycle");
      seen.add(v);
      const out = Array.isArray(v)
        ? "[" + v.map((x) => write(x, depth + 1)).join(",") + "]"
        : "{" + Object.keys(v).sort().map((k) => JSON.stringify(k) + ":" + write(v[k], depth + 1)).join(",") + "}";
      seen.delete(v);
      return out;
    })(value, 0);
  }

  function hashOf(value) {
    return ethers.keccak256(ethers.toUtf8Bytes(stableStringify(value)));
  }

  function configRootOf(config) {
    return config === undefined || config === null ? null : hashOf(config);
  }

  // ISO 8601 with an explicit zone, parsed by hand. Date.parse differs across
  // engines (V8 accepts 2024-02-30 and 24:00), and the CLI and a reviewer's
  // Safari must read the same instant or reject the same string.
  const ISO_TS = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(\.\d+)?(Z|([+-])(\d{2}):(\d{2}))$/;
  function parseTimestamp(ts) {
    const m = typeof ts === "string" ? ISO_TS.exec(ts) : null;
    if (!m) return NaN;
    const [y, mo, d, h, mi, s] = m.slice(1, 7).map(Number);
    const days = [31, y % 4 === 0 && (y % 100 !== 0 || y % 400 === 0) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
    if (mo < 1 || mo > 12 || d < 1 || d > days[mo - 1] || h > 23 || mi > 59 || s > 59) return NaN;
    let offset = 0;
    if (m[8] !== "Z") {
      const oh = Number(m[10]);
      const om = Number(m[11]);
      if (oh > 23 || om > 59) return NaN;
      offset = (m[9] === "+" ? 1 : -1) * (oh * 60 + om) * 60000;
    }
    const ms = m[7] ? Math.floor(Number("0" + m[7]) * 1000) : 0;
    return Date.UTC(y, mo - 1, d, h, mi, s, ms) - offset;
  }

  /// Bytes (Uint8Array or Buffer) or a string, to entries. Bytes must be
  /// strict UTF-8 with no byte-order mark: the hash covers parsed values, so
  /// two different files must never decode to the same text.
  function readEntries(input) {
    const entries = [];
    let text;
    let encoding = null;
    if (typeof input === "string") text = input;
    else {
      try {
        text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(input);
      } catch (error) {
        text = new TextDecoder("utf-8", { ignoreBOM: true }).decode(input);
        encoding = "the file is not valid UTF-8";
      }
    }
    if (text.charCodeAt(0) === 0xfeff) {
      text = text.slice(1);
      encoding = encoding || "the file starts with a byte-order mark";
    }
    if (encoding) Object.defineProperty(entries, "__encoding", { value: encoding });
    text.split("\n").forEach((line, index) => {
      if (!line.trim()) return;
      try {
        const entry = JSON.parse(line);
        if (entry === null || typeof entry !== "object" || Array.isArray(entry)) throw new Error("not an object");
        // The bytes must be the one serialisation of the value: no duplicate
        // keys, padded numbers or alternative escapes.
        if (JSON.stringify(entry) !== line.replace(/\r$/, "")) {
          Object.defineProperty(entry, "__noncanonical", { value: true, enumerable: false });
        }
        entries.push(entry);
      } catch (error) {
        // Unparseable is evidence too: keep a placeholder that fails verify.
        entries.push({ __unparseable: true, line: index + 1 });
      }
    });
    return entries;
  }

  /// Check every link in the chain. Never throws on a bad log.
  function verifyEntries(entries) {
    const problems = [];
    const warnings = [];
    let prev = GENESIS;
    let lastTs = null;
    if (entries.__encoding) problems.push({ seq: 0, reason: entries.__encoding + "; a log must be plain UTF-8 bytes" });
    entries.forEach((entry, index) => {
      if (entry.__unparseable) {
        problems.push({ seq: index, reason: "line " + entry.line + " is not valid JSON" });
        prev = null;
        return;
      }
      const ts = parseTimestamp(entry.ts);
      if (!Number.isFinite(ts)) {
        problems.push({ seq: index, reason: "timestamp " + JSON.stringify(entry.ts) + " is not a date" });
      } else {
        if (lastTs !== null && ts < lastTs - CLOCK_SKEW_MS) {
          warnings.push({ seq: index, reason: "timestamp is earlier than the entry before it (backdated, or a badly wrong clock)" });
        }
        lastTs = ts;
      }
      if (entry.__noncanonical) {
        problems.push({ seq: index, reason: "line is not in canonical form (duplicate keys, reformatted numbers or escapes)" });
      }
      if (entry.format !== FORMAT) problems.push({ seq: index, reason: "unknown format " + JSON.stringify(entry.format) });
      if (entry.seq !== index) problems.push({ seq: index, reason: "sequence number " + entry.seq + ", expected " + index });
      if (prev !== null && entry.prev !== prev) problems.push({ seq: index, reason: "does not link to the entry before it" });
      let expected = null;
      try {
        const { hash, ...rest } = entry;
        expected = hashOf(rest);
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
      if (entry.kind === "change" && entry.after !== undefined) {
        let root = null;
        try {
          root = configRootOf(entry.after);
        } catch (error) {
          problems.push({ seq: index, reason: "stored config cannot be hashed: " + error.message });
        }
        if (root !== null && entry.configRoot !== root) {
          problems.push({ seq: index, reason: "stored config does not match its recorded root" });
        }
      }
      prev = entry.hash;
    });
    const head = entries.length ? entries[entries.length - 1].hash || null : GENESIS;
    const logId = entries.length && !entries[0].__unparseable ? entries[0].hash || null : null;
    return { ok: problems.length === 0, entries: entries.length, head, logId, problems, warnings };
  }

  // Every entry an anchor covers must predate the block that anchored it.
  function timestampProblem(all, coveredEntries, blockTimeSec) {
    const limit = blockTimeSec * 1000 + CLOCK_SKEW_MS;
    for (let i = 0; i < coveredEntries && i < all.length; i++) {
      const ts = parseTimestamp(all[i].ts);
      if (Number.isFinite(ts) && ts > limit) {
        return "entry " + i + " claims " + all[i].ts + ", after the block that anchored it";
      }
    }
    return null;
  }

  async function readRegistryHistory(registry, logId, anchorer) {
    const count = Number(await registry.anchorCount(logId, anchorer));
    const out = [];
    for (let from = 0; from < count; from += PAGE) {
      const page = await registry.anchorsOf(logId, anchorer, from, PAGE);
      for (const a of page) {
        out.push({
          index: out.length,
          entries: Number(a.covered),
          timestamp: Number(a.timestamp),
          blockNumber: Number(a.blockNumber),
          head: a.head,
          storageRoot: a.storageRoot,
        });
      }
    }
    return out;
  }

  /// Check entries against the chain. Returns { ok, results, warnings,
  /// logId, anchorers }, with one row in `results` per anchor checked: every
  /// anchor the registry holds for this log, plus every plain-transaction
  /// anchor the log lists. `logId`, `anchorer` and `registry` are the
  /// verifier's pins; each missing pin is a warning, never a silent pass.
  async function verifyChain(all, provider, options = {}) {
    const local = verifyEntries(all);
    const results = [];
    const warnings = [];
    const logId = options.logId || local.logId;
    const anchorEntries = all.filter((e) => e && e.kind === "anchor");
    // Lower-case addresses: a mis-checksummed pin is still the same address,
    // and ethers would otherwise throw on it in one verifier and not another.
    const lower = (a) => String(a).toLowerCase();

    if (!options.logId) warnings.push("log id not pinned: pass the id you were given, or a rewrite under a new id will not be caught");
    if (options.logId && local.logId && lower(options.logId) !== lower(local.logId)) {
      results.push({ seq: 0, source: "pin", ok: false, reason: "this log's id is " + local.logId + ", not the pinned " + options.logId });
    }

    const pinnedAnchorers = options.anchorer ? [].concat(options.anchorer).map(lower) : null;
    if (!pinnedAnchorers) warnings.push("anchorer not pinned: pass the address you expect, or anchors from any key are accepted");
    const anchorers = pinnedAnchorers || Array.from(new Set(anchorEntries.map((e) => lower(e.anchorer))));

    for (const e of anchorEntries) {
      if (pinnedAnchorers && !pinnedAnchorers.includes(lower(e.anchorer))) {
        results.push({ seq: e.seq, source: "pin", ok: false, reason: "anchored by " + e.anchorer + ", which is not a pinned anchorer" });
      }
    }

    // The chain, not the log, is the list of registry anchors to check.
    const registry = options.registry || (anchorEntries.find((e) => e.mode === "registry") || {}).registry;
    if (!options.registry) {
      warnings.push(
        registry
          ? "registry taken from the log itself: pass the registry address so deleted anchor records are caught"
          : "no registry given: anchors whose records were deleted from the log cannot be found"
      );
    }
    if (registry) {
      const contract = new ethers.Contract(lower(registry), REGISTRY_ABI, provider);
      for (const who of anchorers) {
        let history;
        try {
          history = await readRegistryHistory(contract, logId, who);
        } catch (error) {
          results.push({ seq: null, source: "registry", ok: false, reason: "could not read registry: " + (error.shortMessage || error.message) });
          continue;
        }
        for (const a of history) {
          const listed = anchorEntries.find((e) => e.mode === "registry" && e.index === a.index && lower(e.anchorer) === who);
          const row = {
            seq: listed ? listed.seq : null,
            source: "registry",
            index: a.index,
            anchorer: who,
            entries: a.entries,
            blockNumber: a.blockNumber,
            storageRoot: a.storageRoot,
            ok: false,
            reason: null,
          };
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
        for (const e of anchorEntries) {
          if (e.mode !== "registry" || lower(e.anchorer) !== who) continue;
          if (!history.some((a) => a.index === e.index && a.head === e.anchoredHead)) {
            results.push({ seq: e.seq, source: "registry", ok: false, reason: "the log lists anchor #" + e.index + " but the registry does not hold it" });
          }
        }
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
        const expected = (ANCHOR_TAG + String(e.anchoredHead).slice(2)).toLowerCase();
        const at = all[e.anchoredEntries - 1];
        if (!tx) row.reason = "transaction not found on this chain";
        else if (String(tx.data).toLowerCase() !== expected) row.reason = "transaction data does not carry this head";
        else if (!at || at.hash !== e.anchoredHead) row.reason = "the log no longer has this head at the anchored position (rewritten)";
        else if (lower(tx.from) !== lower(e.anchorer)) row.reason = "sent by a different address than recorded";
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
    for (const who of pinnedAnchorers || []) {
      const vouched = results.some((r) => r.ok && r.source !== "pin" && (r.anchorer ? lower(r.anchorer) === who : true));
      const reported = results.some((r) => r.source === "pin" && lower(r.reason || "").includes(who));
      if (!vouched && !reported) results.push({ seq: null, source: "pin", ok: false, reason: "no valid anchor from the pinned anchorer " + who });
    }

    return { ok: local.ok && results.every((r) => r.ok), results, warnings, logId, anchorers };
  }

  return {
    FORMAT,
    GENESIS,
    ANCHOR_TAG,
    CLOCK_SKEW_MS,
    MAX_DEPTH,
    REGISTRY_ABI,
    stableStringify,
    hashOf,
    configRootOf,
    parseTimestamp,
    readEntries,
    verifyEntries,
    timestampProblem,
    readRegistryHistory,
    verifyChain,
  };
});
