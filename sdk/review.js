"use strict";

// A second pair of eyes on every change, run on 0G Compute.
//
// For each change not yet reviewed, a model reads the setting-level diff and
// the stated reason, and writes a two-sentence summary for the approver plus
// a risk level and any concerns. The review is appended to the log as its own
// entry, bound to the change by hash, with the model's name and the hashes of
// the exact request and response, so anyone holding the request can re-run
// it and compare.
//
// It is advice, not approval: the evidence pack lists it next to the human
// approval, never instead of it. Redacted changes are reviewed from their
// keys alone; their values are never sent.

const { keccak256, toUtf8Bytes } = require("ethers");
const { stableStringify } = require("./canonical");

const SYSTEM = [
  "You review changes to an AI system's prompts and configuration for the engineer who must approve them.",
  "Reply with JSON only: {\"summary\": string, \"risk\": \"low\"|\"medium\"|\"high\", \"concerns\": string[]}.",
  "summary: at most two sentences, plain language, what changed and its likely effect on the system's behaviour.",
  "risk: high if the change could plausibly cause harmful, non-compliant, or much less accurate output; medium if behaviour changes noticeably; low otherwise.",
  "concerns: specific things the approver should check, at most three. Empty if none.",
].join(" ");

function clip(value, n) {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return text === undefined ? "(none)" : text.length > n ? text.slice(0, n) + "… (" + text.length + " chars)" : text;
}

function describe(entry) {
  const lines = ["System: " + entry.system, "Reason given: " + (entry.reason || "(none)") + (entry.ticket ? " [" + entry.ticket + "]" : "")];
  for (const c of entry.changes || []) {
    if (entry.redacted) lines.push("- " + c.key + " changed (value redacted)");
    else if (c.lines) lines.push("- " + c.key + ":\n" + c.lines.slice(0, 80).join("\n"));
    else lines.push("- " + c.key + ": " + clip(c.from, 400) + " -> " + clip(c.to, 400));
  }
  if (entry.eval) lines.push("Evaluation: " + clip(entry.eval, 300));
  return lines.join("\n");
}

function parse(text) {
  const match = String(text || "").match(/\{[\s\S]*\}/);
  if (!match) return null;
  try {
    const out = JSON.parse(match[0]);
    const risk = ["low", "medium", "high"].includes(out.risk) ? out.risk : null;
    if (typeof out.summary !== "string" || !risk) return null;
    return {
      summary: out.summary.slice(0, 600),
      risk,
      concerns: (Array.isArray(out.concerns) ? out.concerns : []).filter((c) => typeof c === "string").slice(0, 3).map((c) => c.slice(0, 300)),
    };
  } catch (ignored) {
    return null;
  }
}

const hash = (value) => keccak256(toUtf8Bytes(typeof value === "string" ? value : stableStringify(value)));

/// Review every change entry that has no review yet. Returns { written, skipped }.
async function reviewPending(log, options = {}) {
  const complete = options.complete || require("../lib/compute").complete;
  const all = log.entries();
  const reviewed = new Set(all.filter((e) => e.kind === "review").map((e) => e.reviews));
  const pending = all.filter((e) => e.kind === "change" && !reviewed.has(e.seq) && (e.changes || []).length).slice(-(options.limit || 20));
  const written = [];
  const skipped = [];
  for (const entry of pending) {
    const messages = [
      { role: "system", content: SYSTEM },
      { role: "user", content: describe(entry) },
    ];
    const request = { model: options.model || null, messages };
    const result = await complete(messages, { model: options.model, temperature: 0, maxTokens: 400 });
    const verdict = result && result.ok ? parse(result.text) : null;
    if (!verdict) {
      skipped.push({ seq: entry.seq, reason: (result && result.note) || "the model's reply was not the JSON asked for" });
      continue;
    }
    written.push(
      log.recordReview({
        seq: entry.seq,
        reviewer: "0g-compute:" + (result.model || options.model || "default"),
        ...verdict,
        evidence: { provider: "0g-compute", model: result.model || null, requestHash: hash(request), responseHash: hash(result.text) },
      })
    );
  }
  return { written, skipped };
}

module.exports = { reviewPending, describe, parse, SYSTEM };
