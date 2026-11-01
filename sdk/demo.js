"use strict";

// `germline demo`: the whole idea in under a minute, with no wallet, no
// network and nothing left behind in the caller's directory.
//
// It sets up a throwaway repository, records three ordinary changes to a
// support agent's prompt and settings, verifies the log, then plays the
// insider who quietly edits history -- and shows verify catching it.

const fs = require("fs");
const os = require("os");
const path = require("path");
const { openAuditLog } = require("./audit");
const { init, trackAll } = require("./track");

function pause(ms) {
  if (ms > 0) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function demo({ out = console.log, delay = 600 } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "germline-demo-"));
  const write = (file, content) => {
    fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
    fs.writeFileSync(path.join(dir, file), typeof content === "string" ? content : JSON.stringify(content, null, 2));
  };
  const step = (text) => {
    out("");
    out("> " + text);
    pause(delay);
  };
  const saved = process.env.GERMLINE_ACTOR;

  try {
    write("prompts/support.md", "You are a support agent. Offer refunds within 30 days.");
    write("config/agent.json", { model: "open-model-35b", temperature: 0.7, retrievalDepth: 4 });

    step("A team's support agent: one prompt, one config file. `germline init` starts tracking them.");
    process.env.GERMLINE_ACTOR = "github:priya";
    const setup = init({ cwd: dir, system: "support-agent", workflow: false });
    out("  tracking " + setup.files.join(", "));

    step("Three ordinary changes over a week, each recorded by CI on merge:");
    const changes = [
      ["github:priya", "config/agent.json", { model: "open-model-35b", temperature: 0.2, retrievalDepth: 4 }, "Lower temperature: fewer invented refund rules"],
      ["github:marco", "prompts/support.md", "You are a support agent. Offer refunds within 14 days.", "Policy change: 14-day refund window (LEGAL-88)"],
      ["github:priya", "config/agent.json", { model: "open-model-35b", temperature: 0.2, retrievalDepth: 8 }, "Deeper retrieval for long tickets"],
    ];
    for (const [actor, file, content, reason] of changes) {
      process.env.GERMLINE_ACTOR = actor;
      write(file, content);
      for (const e of trackAll({ cwd: dir, reason }).written) {
        const what = e.changes.map((c) => c.key.replace(/^.*› /, "")).join(", ");
        out("  #" + e.seq + "  " + e.actor.padEnd(14) + what.padEnd(20) + "  " + reason);
      }
    }

    const logFile = path.join(dir, ".germline", "audit.jsonl");
    const log = openAuditLog(logFile);
    step("Anyone can verify the log, offline, without trusting whoever kept it:");
    const ok = log.verify();
    out("  verify: OK, " + ok.entries + " entries, head " + ok.head.slice(0, 18) + "…");

    step("Months later a customer disputes a refund. Someone edits the log so the 14-day change looks like it came from priya, with a different reason:");
    const lines = fs.readFileSync(logFile, "utf8").trim().split("\n");
    const target = JSON.parse(lines[2]);
    target.actor = "github:priya";
    target.reason = "Routine copy edit";
    lines[2] = JSON.stringify(target);
    fs.writeFileSync(logFile, lines.join("\n") + "\n");
    out("  (one line of .germline/audit.jsonl changed; the file still looks perfectly normal)");

    step("Verify again:");
    const bad = log.verify();
    out("  verify: FAILED");
    for (const p of bad.problems) out("    entry " + p.seq + ": " + p.reason);

    step("And once the log is anchored on 0G, even rewriting the whole file consistently is caught, because the chain holds every head it ever had.");
    out("  germline anchor          # one 0G transaction, or automatic in CI with GERMLINE_ANCHOR_KEY");
    out("  germline verify --chain --log-id 0x… --anchorer 0x…");
    out("");
    out("Set it up in your own repository:  npx germline init");
    return { dir, detected: !bad.ok };
  } finally {
    if (saved === undefined) delete process.env.GERMLINE_ACTOR;
    else process.env.GERMLINE_ACTOR = saved;
    if (!process.env.GERMLINE_DEMO_KEEP) fs.rmSync(dir, { recursive: true, force: true });
  }
}

module.exports = { demo };
