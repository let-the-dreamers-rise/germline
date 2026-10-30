"use strict";

// The evidence pack: an audit log rendered as a document an auditor will
// actually read, with the verification result at the top rather than buried.
//
// The mapping to frameworks below says what each record supports, not that
// Germline satisfies a framework. Satisfying one is a judgement an assessor
// makes about a whole organisation; a tool that claimed otherwise would be
// the first thing a competent auditor stopped trusting.

const { verifyEntries } = require("./audit");

const EXPLORERS = {
  16661: "https://chainscan.0g.ai/tx/",
  16601: "https://chainscan-galileo.0g.ai/tx/",
};

const CONTROLS = [
  [
    "EU AI Act, Art. 12 (record-keeping)",
    "Automatically generated, timestamped record of each change to the system's configuration, who made it, and why.",
  ],
  [
    "EU AI Act, Art. 19 (retention of logs)",
    "Records are anchored on 0G Chain and the log is published to 0G Storage, so retention does not depend on one copy.",
  ],
  [
    "SOC 2 CC8.1 (change management)",
    "Each change carries an actor, a reason or ticket, before/after state, and the test evidence that justified it.",
  ],
  [
    "ISO/IEC 42001 (AI management system)",
    "Traceable record of AI system changes and the evaluations behind them, usable as operational evidence.",
  ],
];

function cell(value) {
  if (value === null || value === undefined || value === "") return "-";
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return text.replace(/\|/g, "\\|").replace(/\n/g, " ");
}

function short(hash) {
  return hash ? hash.slice(0, 10) + "…" : "-";
}

function evalSummary(evaluation) {
  if (!evaluation) return "-";
  const parts = [];
  if (evaluation.score !== undefined) parts.push("score " + evaluation.score);
  if (evaluation.baseline !== undefined) parts.push("baseline " + evaluation.baseline);
  if (evaluation.fitnessBps !== undefined) parts.push(evaluation.fitnessBps + " bps");
  if (evaluation.verdict && evaluation.verdict.winner) parts.push("vs random: " + evaluation.verdict.winner);
  if (evaluation.suite) parts.push(evaluation.suite);
  return parts.length ? parts.join(", ") : cell(evaluation);
}

/// Render entries as Markdown. `anchorChecks` is the optional output of
/// log.verifyAnchors(), so the pack can say whether each anchor was checked
/// against the live chain or only recorded.
function renderMarkdown(entries, options = {}) {
  const check = verifyEntries(entries);
  const changes = entries.filter((e) => e.kind === "change");
  const anchors = entries.filter((e) => e.kind === "anchor");
  const checks = new Map((options.anchorChecks || []).map((r) => [r.seq, r]));
  const systems = Array.from(new Set(changes.map((e) => e.system))).sort();
  const title = options.title || "AI configuration change record";
  const generated = options.now || new Date().toISOString();

  const lines = [];
  lines.push("# " + title, "");
  lines.push("Generated " + generated + " by Germline from `" + (options.source || "audit log") + "`.", "");

  lines.push("## Integrity", "");
  if (check.ok) {
    lines.push("**Hash chain verifies.** " + check.entries + " entries, none edited, removed or reordered since they were written.");
  } else {
    lines.push("**Hash chain does NOT verify.** " + check.problems.length + " problem(s):", "");
    for (const p of check.problems) lines.push("- entry " + p.seq + ": " + p.reason);
  }
  lines.push("", "Head: `" + check.head + "`", "");

  if (anchors.length === 0) {
    lines.push("Not yet anchored on chain. Until it is, whoever holds this file could rewrite all of it consistently.");
  } else {
    const last = anchors[anchors.length - 1];
    const covered = last.anchoredEntries;
    const chains = Array.from(new Set(anchors.map((a) => a.chainId)));
    const where = chains.every((id) => EXPLORERS[id]) ? "0G Chain" : "chain " + chains.join(", ");
    lines.push(
      "Anchored " + anchors.length + " time(s) on " + where + ". The latest anchor covers the first " +
        covered + " of " + check.entries + " entries."
    );
  }
  lines.push("");

  lines.push("## Summary", "");
  lines.push("| | |", "|---|---|");
  lines.push("| Systems | " + cell(systems.join(", ")) + " |");
  lines.push("| Changes recorded | " + changes.length + " |");
  lines.push("| Distinct actors | " + new Set(changes.map((e) => e.actor)).size + " |");
  lines.push("| First change | " + cell(changes[0] && changes[0].ts) + " |");
  lines.push("| Latest change | " + cell(changes.length ? changes[changes.length - 1].ts : null) + " |");
  lines.push("");

  lines.push("## Changes", "");
  lines.push("| # | When | System | Who | What changed | Why | Evidence | Config root |");
  lines.push("|---|---|---|---|---|---|---|---|");
  for (const e of changes) {
    const what = (e.changes || [])
      .map((c) => (c.from === undefined ? c.key : c.key + ": " + cell(c.from) + " → " + cell(c.to)))
      .join("; ");
    const why = [e.reason, e.ticket].filter(Boolean).join(" · ");
    lines.push(
      "| " + [e.seq, e.ts, e.system, e.actor, what || "(no field changed)", why, evalSummary(e.eval), "`" + short(e.configRoot) + "`"]
        .map(cell)
        .join(" | ") + " |"
    );
  }
  lines.push("");

  if (anchors.length) {
    lines.push("## Anchors", "");
    lines.push("| # | When | Covers | Chain | Transaction | Checked against chain | Log in 0G Storage |");
    lines.push("|---|---|---|---|---|---|---|");
    for (const a of anchors) {
      const base = EXPLORERS[a.chainId];
      const tx = base ? "[" + short(a.txHash) + "](" + base + a.txHash + ")" : "`" + short(a.txHash) + "`";
      const checked = checks.has(a.seq) ? (checks.get(a.seq).ok ? "yes" : "FAILED: " + checks.get(a.seq).reason) : "not checked";
      const stored = a.storage ? (a.storage.stored === "0g" ? a.storage.storageRoot || a.storage.uri : "local only") : "-";
      lines.push("| " + [a.seq, a.ts, "entries 0–" + (a.anchoredEntries - 1), a.chainId, tx, checked, stored].map((v, i) => (i === 4 ? v : cell(v))).join(" | ") + " |");
    }
    lines.push("");
  }

  lines.push("## What this record supports", "");
  lines.push("| Framework | How this record is relevant |", "|---|---|");
  for (const [name, how] of CONTROLS) lines.push("| " + name + " | " + how + " |");
  lines.push(
    "",
    "This is supporting evidence, not a compliance determination. Whether an organisation meets any of these is for its assessor to decide.",
    ""
  );

  lines.push("## How to verify this yourself", "");
  lines.push("```bash", "npx germline verify --log " + (options.source || ".germline/audit.jsonl") + " --chain", "```", "");
  lines.push("Verification recomputes every hash locally and reads each anchor transaction from 0G Chain. It needs no account and no trust in whoever produced this file.", "");

  return lines.join("\n");
}

module.exports = { renderMarkdown, CONTROLS };
