"use strict";

// The evidence pack: an audit log rendered as a document an auditor will
// actually read, with the verification result at the top rather than buried.
//
// Two rules shape this file.
//
// It never claims more than the log shows. The framework table is built from
// what is actually in the log -- anchored or not, uploaded or not, with test
// evidence or without -- and says what is missing as plainly as what is there.
// Satisfying a framework is a judgement an assessor makes about a whole
// organisation; a tool that claimed otherwise would be the first thing a
// competent auditor stopped trusting.
//
// It treats the log as hostile input. Every value is escaped, every hash and
// address is checked for shape, and the verification command never takes its
// pins from the file it is verifying: a forged log would otherwise ship with
// instructions that make it pass.

const { verifyEntries } = require("./audit");

const EXPLORERS = {
  16661: "https://chainscan.0g.ai/tx/",
  16601: "https://chainscan-galileo.0g.ai/tx/",
};

const HASH = /^0x[0-9a-fA-F]{64}$/;
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;

// Escape text so it renders as itself: no links, emphasis, HTML or table
// breaks smuggled in through a commit message or a reason.
function escape(text) {
  return String(text)
    .replace(/[\r\n\t]+/g, " ")
    .replace(/[\\`*_[\]<>|#!~]/g, (c) => "\\" + c);
}

function cell(value) {
  if (value === null || value === undefined || value === "") return "-";
  let text = typeof value === "string" ? value : JSON.stringify(value);
  // A whole prompt in a table cell makes the pack unreadable. Show its start
  // and size; the full text stays in the log, under its hash.
  if (text.length > 120) text = text.slice(0, 80) + "… (" + text.length + " chars)";
  return escape(text);
}

function hex(value, shape) {
  return typeof value === "string" && shape.test(value) ? value : null;
}

function short(hash) {
  const ok = hex(hash, HASH) || hex(hash, ADDRESS);
  return ok ? ok.slice(0, 10) + "…" : "(invalid)";
}

function code(value) {
  // Only ever called with values that passed hex(): no backticks possible.
  return "`" + value + "`";
}

function evalSummary(evaluation) {
  if (!evaluation) return "-";
  const parts = [];
  if (evaluation.score !== undefined) parts.push("score " + evaluation.score);
  if (evaluation.baseline !== undefined) parts.push("baseline " + evaluation.baseline);
  if (evaluation.fitnessBps !== undefined) parts.push(evaluation.fitnessBps + " bps");
  if (evaluation.verdict && evaluation.verdict.winner) parts.push("vs random: " + evaluation.verdict.winner);
  if (evaluation.suite) parts.push(evaluation.suite);
  return parts.length ? parts.join(", ") : JSON.stringify(evaluation);
}

function describeChange(c, entry) {
  if (entry.redacted || (c.from === undefined && c.to === undefined)) return c.key + " (value redacted)";
  if (c.lines) return c.key + ": " + c.lines.length + " line(s) changed, see below";
  return c.key + ": " + (c.from === undefined ? "-" : JSON.stringify(c.from)) + " → " + (c.to === undefined ? "-" : JSON.stringify(c.to));
}

/// What the log can honestly be said to support, from its actual content.
function controls(changes, anchors) {
  const n = changes.length;
  const withWhy = changes.filter((e) => e.reason || e.ticket).length;
  const withEval = changes.filter((e) => e.eval).length;
  const withCommit = changes.filter((e) => e.commit).length;
  const registry = anchors.some((a) => a.mode === "registry");
  const uploaded = anchors.some((a) => a.storage && a.storage.stored === "0g");
  const rows = [];
  rows.push([
    "EU AI Act, Art. 12 (record-keeping)",
    n ? "Supported" : "No changes recorded",
    n + " change(s), each automatically recorded with time, author and the exact settings that moved.",
  ]);
  rows.push([
    "EU AI Act, Art. 19 (retention of logs)",
    uploaded ? "Supported" : anchors.length ? "Partly" : "Not yet",
    uploaded
      ? "The log is anchored on 0G Chain and a copy is held in 0G Storage, so retention does not depend on one copy."
      : anchors.length
        ? "Anchored on 0G Chain, so a rewrite is detectable; the log itself is held only where it is kept (e.g. git). Anchor with --upload to keep a copy in 0G Storage."
        : "The log is held only where it is kept (e.g. git). Nothing proves it has not been rewritten. Set GERMLINE_ANCHOR_KEY to anchor it.",
  ]);
  rows.push([
    "SOC 2 CC8.1 (change management)",
    n && withWhy === n ? "Supported" : n ? "Partly" : "No changes recorded",
    withWhy + " of " + n + " change(s) carry a reason or ticket; " + withCommit + " link to a commit; " + withEval + " carry test evidence." +
      (registry ? " Anchored in an append-only registry." : ""),
  ]);
  rows.push([
    "ISO/IEC 42001 (AI management system)",
    withEval ? "Partly" : "Not yet",
    withEval
      ? withEval + " of " + n + " change(s) record the evaluation behind them."
      : "No change records an evaluation. Pass --score/--baseline/--suite or --eval-file to track to attach test evidence.",
  ]);
  return rows;
}

/// Render entries as Markdown. `anchorChecks` is the optional output of
/// log.verifyChain(), so the pack can say whether each anchor was checked
/// against the live chain or only recorded. `pins` is what the caller pinned
/// on the command line, never anything read from the log.
function renderMarkdown(entries, options = {}) {
  const check = verifyEntries(entries);
  const valid = entries.filter((e) => e && typeof e === "object" && !e.__unparseable);
  const changes = valid.filter((e) => e.kind === "change");
  const anchors = valid.filter((e) => e.kind === "anchor");
  // One verdict per anchor entry; a failure from any check wins over a pass.
  const checks = new Map();
  for (const r of options.anchorChecks || []) {
    if (r.seq === null) continue;
    const seen = checks.get(r.seq);
    if (!seen || (seen.ok && !r.ok)) checks.set(r.seq, r);
  }
  const systems = Array.from(new Set(changes.map((e) => String(e.system)))).sort();
  const title = options.title || "AI configuration change record";
  const generated = options.now || new Date().toISOString();
  const logId = hex(check.logId, HASH);
  const anchorers = Array.from(new Set(anchors.map((a) => hex(a.anchorer, ADDRESS)).filter(Boolean)));

  const lines = [];
  lines.push("# " + escape(title), "");
  lines.push("Generated " + escape(generated) + " by Germline from " + escape(options.source || "audit log") + ".", "");

  lines.push("## Integrity", "");
  if (check.ok) {
    lines.push("**Hash chain verifies.** " + check.entries + " entries, none edited, removed or reordered since they were written.");
  } else {
    lines.push("**Hash chain does NOT verify.** " + check.problems.length + " problem(s):", "");
    for (const p of check.problems) lines.push("- entry " + p.seq + ": " + escape(p.reason));
  }
  for (const w of check.warnings || []) lines.push("- warning, entry " + w.seq + ": " + escape(w.reason));
  lines.push("", "Head: " + (hex(check.head, HASH) ? code(check.head) : "(none)"), "");

  if (logId) {
    lines.push("This file reports log ID " + code(logId) + (anchorers.length ? ", anchored by " + anchorers.map(code).join(", ") : "") + ".", "");
  }
  if (options.pins && (options.pins.logId || options.pins.anchorer)) {
    const idOk = !options.pins.logId || (logId && logId.toLowerCase() === options.pins.logId.toLowerCase());
    lines.push(
      idOk
        ? "**Pinned values were supplied by the verifier**, not taken from this file" +
            (options.pins.logId ? ": log ID matches." : ".")
        : "**The log ID does NOT match the pinned value.** This file is not the log you were given, or it was rewritten."
    );
    lines.push("");
  } else {
    lines.push(
      "These identifiers come from the file itself, so they prove nothing on their own. Compare them with the log ID and anchorer address you recorded when the log was set up (`germline id`), kept somewhere other than this file.",
      ""
    );
  }

  if (anchors.length === 0) {
    lines.push("**Not anchored on chain.** Until it is, whoever holds this file could rewrite all of it consistently.");
  } else {
    const last = anchors[anchors.length - 1];
    const covered = Number(last.anchoredEntries) || 0;
    const chains = Array.from(new Set(anchors.map((a) => a.chainId)));
    const where = chains.every((id) => EXPLORERS[id]) ? "0G Chain" : "chain " + chains.map(cell).join(", ");
    const registry = anchors.some((a) => a.mode === "registry");
    lines.push(
      "Anchored " + anchors.length + " time(s) on " + where + (registry ? " in the GermlineAnchor registry" : " as plain transactions") +
        ". The latest anchor covers the first " + covered + " of " + check.entries + " entries." +
        (options.anchorChecks ? "" : " **Anchors were not checked against the chain for this pack** (generate it with --chain).")
    );
  }
  lines.push("");
  if (options.chainWarnings && options.chainWarnings.length) {
    lines.push("Chain check warnings:", "");
    for (const w of options.chainWarnings) lines.push("- " + escape(w));
    lines.push("");
  }
  const unlisted = (options.anchorChecks || []).filter((r) => r.seq === null);
  if (unlisted.length) {
    lines.push("Chain checks not tied to an entry in this file:", "");
    for (const r of unlisted) {
      const what = r.index !== undefined ? "registry #" + r.index + " (" + r.entries + " entries)" : "pin";
      lines.push("- " + what + ": " + (r.ok ? "consistent with this log" : "FAILED: " + escape(r.reason)));
    }
    lines.push("");
  }

  lines.push("## Summary", "");
  lines.push("| | |", "|---|---|");
  lines.push("| Systems | " + cell(systems.join(", ")) + " |");
  lines.push("| Changes recorded | " + changes.length + " |");
  lines.push("| Distinct authors | " + new Set(changes.map((e) => e.actor)).size + " |");
  lines.push("| With a reason or ticket | " + changes.filter((e) => e.reason || e.ticket).length + " |");
  lines.push("| With test evidence | " + changes.filter((e) => e.eval).length + " |");
  lines.push("| First change | " + cell(changes[0] && changes[0].ts) + " |");
  lines.push("| Latest change | " + cell(changes.length ? changes[changes.length - 1].ts : null) + " |");
  lines.push("");

  lines.push("## Changes", "");
  lines.push("| # | When | System | Who | What changed | Why | Commit | Evidence | Config root |");
  lines.push("|---|---|---|---|---|---|---|---|---|");
  const details = [];
  for (const e of changes) {
    const list = Array.isArray(e.changes) ? e.changes : [];
    const what = list.map((c) => describeChange(c, e)).join("; ");
    const why = [e.reason, e.ticket].filter(Boolean).join(" · ");
    const commit = hex(e.commit, /^[0-9a-f]{7,64}$/) ? e.commit.slice(0, 10) : e.commit ? "(invalid)" : "-";
    lines.push(
      "| " +
        [
          cell(e.seq),
          cell(e.ts),
          cell(e.system),
          cell(e.actor) + (e.recordedBy && e.recordedBy !== e.actor ? " (recorded by " + cell(e.recordedBy) + ")" : ""),
          cell(what || "(no field changed)"),
          cell(why),
          commit === "-" ? "-" : code(commit),
          cell(evalSummary(e.eval)),
          hex(e.configRoot, HASH) ? code(short(e.configRoot)) : "(invalid)",
        ].join(" | ") +
        " |"
    );
    for (const c of list) if (Array.isArray(c.lines) && c.lines.length) details.push({ e, c });
  }
  lines.push("");

  if (details.length) {
    lines.push("## Text changes", "");
    for (const { e, c } of details) {
      lines.push("Entry " + cell(e.seq) + ", " + cell(c.key) + ":", "");
      // An indented block renders every line literally, whatever it holds.
      for (const l of c.lines.slice(0, 200)) lines.push("    " + String(l).replace(/[\r\n]+/g, " "));
      lines.push("");
    }
  }

  if (anchors.length) {
    lines.push("## Anchors", "");
    lines.push("| # | When | Covers | Chain | Transaction | Checked against chain | Log in 0G Storage |");
    lines.push("|---|---|---|---|---|---|---|");
    for (const a of anchors) {
      const txHash = hex(a.txHash, HASH);
      const base = EXPLORERS[a.chainId];
      const link = txHash ? (base ? "[" + short(txHash) + "](" + base + txHash + ")" : code(short(txHash))) : "(invalid)";
      const tx = a.mode === "registry" ? link + " (registry #" + cell(a.index) + ")" : link;
      const checked = checks.has(a.seq) ? (checks.get(a.seq).ok ? "yes" : "FAILED: " + cell(checks.get(a.seq).reason)) : "not checked";
      const stored = a.storage ? (a.storage.stored === "0g" ? cell(a.storage.storageRoot || a.storage.uri) : "local only") : "-";
      const covers = Number.isSafeInteger(a.anchoredEntries) ? "entries 0–" + (a.anchoredEntries - 1) : "(invalid)";
      lines.push("| " + [cell(a.seq), cell(a.ts), covers, cell(a.chainId), tx, checked, stored].join(" | ") + " |");
    }
    lines.push("");
  }

  lines.push("## What this record supports", "");
  lines.push("| Framework | Status | Based on this log |", "|---|---|---|");
  for (const [name, status, how] of controls(changes, anchors)) lines.push("| " + name + " | " + status + " | " + escape(how) + " |");
  lines.push(
    "",
    "This is supporting evidence, not a compliance determination. Whether an organisation meets any of these is for its assessor to decide.",
    ""
  );

  lines.push("## How to verify this yourself", "");
  lines.push(
    "Use the log ID and anchorer address from your own records, not from this document. Pinning them is what makes a forged copy fail.",
    ""
  );
  lines.push(
    "```bash",
    "npx germline verify --log audit.jsonl --log-id <log ID from your records> --chain --anchorer <address from your records> --strict",
    "```",
    ""
  );
  lines.push(
    "Verification recomputes every hash locally and reads each anchor from 0G Chain. It needs no account and no trust in whoever produced this file.",
    ""
  );

  return lines.join("\n");
}

function changeRows(entries) {
  return entries
    .filter((e) => e && e.kind === "change")
    .map((e) => ({
      seq: e.seq,
      ts: e.ts,
      system: e.system,
      actor: e.actor,
      recordedBy: e.recordedBy || null,
      changed: (Array.isArray(e.changes) ? e.changes : []).map((c) => c.key),
      reason: e.reason || null,
      ticket: e.ticket || null,
      commit: e.commit || null,
      redacted: e.redacted === true,
      evalScore: e.eval && e.eval.score !== undefined ? e.eval.score : null,
      evalBaseline: e.eval && e.eval.baseline !== undefined ? e.eval.baseline : null,
      evalSuite: (e.eval && e.eval.suite) || null,
      configRoot: e.configRoot,
      hash: e.hash,
    }));
}

/// Machine-readable evidence, for GRC tools and spreadsheets.
function renderJson(entries, options = {}) {
  const check = verifyEntries(entries);
  const anchors = entries.filter((e) => e && e.kind === "anchor");
  return (
    JSON.stringify(
      {
        format: "germline.evidence/1",
        generated: options.now || new Date().toISOString(),
        integrity: {
          ok: check.ok,
          entries: check.entries,
          head: check.head,
          logIdReported: check.logId,
          logIdPinned: (options.pins && options.pins.logId) || null,
          problems: check.problems,
          warnings: check.warnings,
          anchored: anchors.length > 0,
          chainChecked: Boolean(options.anchorChecks),
          chainResults: options.anchorChecks || null,
          chainWarnings: options.chainWarnings || null,
        },
        changes: changeRows(entries),
        anchors: anchors.map((a) => ({
          seq: a.seq,
          ts: a.ts,
          covered: a.anchoredEntries,
          head: a.anchoredHead,
          chainId: a.chainId,
          txHash: a.txHash,
          mode: a.mode,
          anchorer: a.anchorer,
          index: a.index === undefined ? null : a.index,
          storage: a.storage || null,
        })),
      },
      null,
      2
    ) + "\n"
  );
}

// A cell that starts with = + - @ is a formula to Excel and Sheets. Prefix
// it so a commit message cannot run anything in the auditor's spreadsheet.
function csvCell(value) {
  if (value === null || value === undefined) return "";
  let text = Array.isArray(value) ? value.join("; ") : String(value);
  if (/^[=+\-@\t\r]/.test(text)) text = "'" + text;
  return /[",\r\n]/.test(text) ? '"' + text.replace(/"/g, '""') + '"' : text;
}

function renderCsv(entries) {
  const rows = changeRows(entries);
  const header = ["seq", "ts", "system", "actor", "recordedBy", "changed", "reason", "ticket", "commit", "redacted", "evalScore", "evalBaseline", "evalSuite", "configRoot", "hash"];
  return [header.join(",")].concat(rows.map((r) => header.map((h) => csvCell(r[h])).join(","))).join("\n") + "\n";
}

module.exports = { renderMarkdown, renderJson, renderCsv, controls, escape };
