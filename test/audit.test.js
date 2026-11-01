const { expect } = require("chai");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");
const { openAuditLog, verifyEntries, diff, ANCHOR_TAG } = require("../sdk/audit");
const { renderMarkdown, renderJson, renderCsv } = require("../sdk/report");

// Plain mocha, no hardhat: the audit trail must work for a team that never
// touches a chain, so its tests must not need one either.

function tempLog() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "germline-audit-"));
  return path.join(dir, "audit.jsonl");
}

function fixedClock() {
  let n = 0;
  return () => new Date(Date.UTC(2026, 9, 30, 12, 0, n++)).toISOString();
}

const BEFORE = { model: "m-1", temperature: 0.7, prompt: { system: "be nice" } };
const AFTER = { model: "m-1", temperature: 0.2, prompt: { system: "be nice" } };

// A signer that records what it was asked to send and answers like ethers.
function fakeSigner(chainId = 16661) {
  const sent = [];
  const address = "0x00000000000000000000000000000000000000aa";
  const provider = {
    getNetwork: async () => ({ chainId: BigInt(chainId) }),
    getTransaction: async (hash) => {
      const tx = sent.find((t) => t.hash === hash);
      return tx ? { data: tx.data, from: address } : null;
    },
  };
  return {
    sent,
    provider,
    getAddress: async () => address,
    sendTransaction: async (tx) => {
      const hash = "0x" + String(sent.length + 1).padStart(64, "0");
      sent.push({ ...tx, hash });
      return { hash, wait: async () => ({ hash, blockNumber: 100 + sent.length }) };
    },
  };
}

describe("audit trail", function () {
  it("diffs by canonical form, so key order is not a change", function () {
    const changes = diff({ a: { x: 1, y: 2 }, b: 1 }, { a: { y: 2, x: 1 }, b: 2, c: true });
    expect(changes).to.deep.equal([
      { key: "b", from: 1, to: 2 },
      { key: "c", from: null, to: true },
    ]);
  });

  it("records a change and verifies an untouched log", function () {
    const log = openAuditLog(tempLog(), { clock: fixedClock() });
    const entry = log.record({
      system: "support-agent",
      actor: "ash",
      before: BEFORE,
      after: AFTER,
      reason: "fewer hallucinated refunds",
      eval: { score: 0.91, baseline: 0.84 },
    });
    expect(entry.seq).to.equal(0);
    expect(entry.changes).to.deep.equal([{ key: "temperature", from: 0.7, to: 0.2 }]);
    log.record({ system: "support-agent", actor: "ash", before: AFTER, after: { ...AFTER, model: "m-2" } });
    const result = log.verify();
    expect(result.ok).to.equal(true);
    expect(result.entries).to.equal(2);
  });

  it("requires a system, an actor and the new config", function () {
    const log = openAuditLog(tempLog());
    expect(() => log.record({ actor: "ash", after: AFTER })).to.throw(/system/);
    expect(() => log.record({ system: "s", after: AFTER })).to.throw(/actor/);
    expect(() => log.record({ system: "s", actor: "ash" })).to.throw(/after/);
  });

  it("detects an entry edited after it was written", function () {
    const file = tempLog();
    const log = openAuditLog(file, { clock: fixedClock() });
    log.record({ system: "s", actor: "ash", before: BEFORE, after: AFTER, reason: "honest" });
    log.record({ system: "s", actor: "ash", before: AFTER, after: BEFORE });
    const lines = fs.readFileSync(file, "utf8").trim().split("\n");
    const first = JSON.parse(lines[0]);
    first.actor = "someone-else";
    lines[0] = JSON.stringify(first);
    fs.writeFileSync(file, lines.join("\n") + "\n");

    const result = log.verify();
    expect(result.ok).to.equal(false);
    expect(result.problems[0]).to.include({ seq: 0 });
    expect(result.problems[0].reason).to.match(/edited/);
  });

  it("detects a deleted entry", function () {
    const file = tempLog();
    const log = openAuditLog(file, { clock: fixedClock() });
    for (let i = 0; i < 3; i++) log.record({ system: "s", actor: "ash", after: { v: i } });
    const lines = fs.readFileSync(file, "utf8").trim().split("\n");
    fs.writeFileSync(file, [lines[0], lines[2]].join("\n") + "\n");
    expect(log.verify().ok).to.equal(false);
  });

  it("detects a stored config swapped for another one", function () {
    const file = tempLog();
    const log = openAuditLog(file, { clock: fixedClock() });
    log.record({ system: "s", actor: "ash", after: AFTER });
    const entry = JSON.parse(fs.readFileSync(file, "utf8"));
    entry.after = BEFORE;
    // Re-hash so only the config root check can catch it.
    const { hash, ...rest } = entry;
    const { keccak256, toUtf8Bytes } = require("ethers");
    const { stableStringify } = require("../sdk/canonical");
    entry.hash = keccak256(toUtf8Bytes(stableStringify(rest)));
    fs.writeFileSync(file, JSON.stringify(entry) + "\n");
    const result = log.verify();
    expect(result.ok).to.equal(false);
    expect(result.problems.map((p) => p.reason).join()).to.match(/recorded root/);
  });

  it("refuses to append to a broken log rather than launder the break", function () {
    const file = tempLog();
    const log = openAuditLog(file);
    log.record({ system: "s", actor: "ash", after: AFTER });
    fs.appendFileSync(file, "not json\n");
    expect(() => log.record({ system: "s", actor: "ash", after: BEFORE })).to.throw(/does not verify/);
  });

  it("redacts config values but keeps their roots", function () {
    const log = openAuditLog(tempLog());
    const entry = log.record({ system: "s", actor: "ash", before: BEFORE, after: AFTER, redact: true });
    expect(entry).to.not.have.property("after");
    expect(entry.changes).to.deep.equal([{ key: "temperature" }]);
    expect(entry.configRoot).to.match(/^0x[0-9a-f]{64}$/);
    expect(log.verify().ok).to.equal(true);
  });

  it("anchors the head on chain and checks the anchor back", async function () {
    const log = openAuditLog(tempLog(), { clock: fixedClock() });
    log.record({ system: "s", actor: "ash", after: AFTER });
    const head = log.verify().head;
    const signer = fakeSigner();
    const anchor = await log.anchor({ signer });

    expect(signer.sent[0].data).to.equal(ANCHOR_TAG + head.slice(2));
    expect(anchor).to.include({ kind: "anchor", anchoredHead: head, anchoredEntries: 1, chainId: 16661 });
    expect(log.verify().ok).to.equal(true);

    const checks = await log.verifyAnchors(signer.provider);
    expect(checks).to.have.length(1);
    expect(checks[0].ok).to.equal(true);
  });

  it("an anchor catches a log rewritten consistently from scratch", async function () {
    const file = tempLog();
    const log = openAuditLog(file, { clock: fixedClock() });
    log.record({ system: "s", actor: "ash", after: AFTER, reason: "original" });
    const signer = fakeSigner();
    await log.anchor({ signer });
    const anchorLine = fs.readFileSync(file, "utf8").trim().split("\n")[1];

    // Rewrite the history with valid hashes, keeping the anchor record.
    fs.writeFileSync(file, "");
    const forged = openAuditLog(file, { clock: fixedClock() });
    forged.record({ system: "s", actor: "ash", after: AFTER, reason: "rewritten" });
    fs.appendFileSync(file, anchorLine + "\n");

    const checks = await forged.verifyAnchors(signer.provider);
    const chainOk = forged.verify().ok;
    expect(chainOk && checks.every((c) => c.ok)).to.equal(false);
  });

  it("records a search run as the evidence for its best config", function () {
    const log = openAuditLog(tempLog());
    const run = {
      strategy: "random",
      best: { config: { depth: 4 }, fitnessBps: 8333 },
      evaluations: 40,
      verdict: { winner: "random" },
      baseline: { median: 8100 },
    };
    const entry = log.recordSearch(run, { system: "rag", actor: "ci", before: { depth: 1 } });
    expect(entry.after).to.deep.equal({ depth: 4 });
    expect(entry.eval).to.include({ source: "germline.search", fitnessBps: 8333, baselineMedian: 8100 });
  });

  it("renders an evidence pack that leads with integrity", async function () {
    const log = openAuditLog(tempLog(), { clock: fixedClock() });
    log.record({ system: "support-agent", actor: "ash", before: BEFORE, after: AFTER, reason: "r", ticket: "GOV-1", eval: { score: 0.9 } });
    const signer = fakeSigner();
    await log.anchor({ signer });
    const md = renderMarkdown(log.entries(), { now: "2026-10-30T00:00:00Z", anchorChecks: await log.verifyAnchors(signer.provider) });
    expect(md).to.include("**Hash chain verifies.**");
    expect(md).to.include("temperature: 0.7 → 0.2");
    expect(md).to.include("chainscan.0g.ai/tx/");
    expect(md).to.include("EU AI Act, Art. 12");
    expect(md).to.include("not a compliance determination");
  });

  it("verifyEntries reports problems instead of throwing", function () {
    const result = verifyEntries([{ __unparseable: true, line: 1 }, { seq: 1 }]);
    expect(result.ok).to.equal(false);
    expect(result.problems.length).to.be.greaterThan(0);
  });

  describe("hostile and damaged logs", function () {
    it("does not crash on a null, numeric or array line", function () {
      for (const bad of ["null", "42", "[1]"]) {
        const file = tempLog();
        const log = openAuditLog(file);
        log.record({ system: "s", actor: "a", after: AFTER });
        fs.appendFileSync(file, bad + "\n");
        const result = log.verify();
        expect(result.ok).to.equal(false);
        expect(() => renderMarkdown(log.entries())).to.not.throw();
      }
    });

    it("rejects lines that are not the canonical bytes of their value", function () {
      const file = tempLog();
      openAuditLog(file).record({ system: "s", actor: "alice", after: AFTER });
      const line = fs.readFileSync(file, "utf8").trim();
      fs.writeFileSync(file, line.replace('"actor":"alice"', '"actor":"mallory","actor":"alice"') + "\n");
      const result = openAuditLog(file).verify();
      expect(result.ok).to.equal(false);
      expect(result.problems[0].reason).to.match(/canonical/);
    });

    it("rejects timestamps without a time zone", function () {
      const log = openAuditLog(tempLog(), { clock: () => "2026-10-30T12:00:00" });
      log.record({ system: "s", actor: "a", after: AFTER });
      expect(log.verify().ok).to.equal(false);
    });

    it("appends safely to a file that lost its trailing newline", function () {
      const file = tempLog();
      const log = openAuditLog(file);
      log.record({ system: "s", actor: "a", after: AFTER });
      fs.writeFileSync(file, fs.readFileSync(file, "utf8").trimEnd());
      log.record({ system: "s", actor: "a", after: BEFORE });
      expect(log.verify()).to.include({ ok: true, entries: 2 });
    });

    it("hashes exactly what it writes, even for values with toJSON", function () {
      const log = openAuditLog(tempLog());
      log.record({ system: "s", actor: "a", after: AFTER, eval: { artifact: Buffer.from("hi"), at: new Date(0) } });
      log.record({ system: "s", actor: "a", after: BEFORE });
      expect(log.verify().ok).to.equal(true);
    });

    it("redaction keeps leaf roots, so later changes still name the setting", function () {
      const log = openAuditLog(tempLog());
      log.track("s", BEFORE, { actor: "a", redact: true });
      const next = log.track("s", AFTER, { actor: "a", redact: true });
      expect(next.changes).to.deep.equal([{ key: "temperature" }]);
      expect(JSON.stringify(next)).to.not.include("0.2");
      expect(log.verify().ok).to.equal(true);
    });

    it("diffs nested settings and prompt lines", function () {
      const changes = diff({ p: { system: "a\nb\nc" }, t: { x: 1 } }, { p: { system: "a\nB\nc" }, t: { x: 2 } });
      expect(changes.map((c) => c.key)).to.deep.equal(["p › system", "t › x"]);
      expect(changes[0].lines).to.deep.equal(["- b", "+ B"]);
    });
  });

  describe("evidence pack is safe to hand an auditor", function () {
    function forged() {
      const file = tempLog();
      const log = openAuditLog(file);
      log.record({ system: "s", actor: "a", after: AFTER, reason: "[click](https://evil.example) **approved** <img src=x>\r| x |" });
      return log;
    }

    it("escapes markdown and HTML from log values", function () {
      const md = renderMarkdown(forged().entries());
      expect(md).to.not.match(/[^\\]\]\(https:\/\/evil/);
      expect(md).to.not.match(/[^\\]<img/);
      expect(md).to.not.include("**approved**");
    });

    it("never takes verification pins from the file under audit", function () {
      const log = forged();
      const md = renderMarkdown(log.entries());
      const command = md.split("```bash")[1];
      expect(command).to.include("<log ID from your records>");
      expect(command).to.not.include(log.verify().logId);
      const pinned = renderMarkdown(log.entries(), { pins: { logId: "0x" + "1".repeat(64) } });
      expect(pinned).to.include("does NOT match the pinned value");
    });

    it("states what the log does not show instead of overclaiming", function () {
      const md = renderMarkdown(forged().entries());
      expect(md).to.match(/CC8\.1 \(change management\) \| Partial \| Of 1 change\(s\): 1 give a reason or ticket, 0 record an approval, 0 carry test evidence/);
      expect(md).to.match(/ISO\/IEC 42001 \(AI management system\) \| Missing/);
      expect(md).to.not.match(/Supported|compliant\b/);
    });

    it("exports JSON and spreadsheet-safe CSV", function () {
      const log = openAuditLog(tempLog());
      log.record({ system: "s", actor: "a", after: AFTER, reason: '=HYPERLINK("x")', eval: { score: 0.9 } });
      const json = JSON.parse(renderJson(log.entries()));
      expect(json.integrity.ok).to.equal(true);
      expect(json.changes[0]).to.include({ evalScore: 0.9 });
      const csv = renderCsv(log.entries()).split("\n");
      expect(csv[0]).to.match(/^seq,ts,system,actor/);
      expect(csv[1]).to.include(`"'=HYPERLINK(""x"")"`);
    });
  });

  describe("model review on 0G Compute", function () {
    const { reviewPending } = require("../sdk/review");
    const { renderCc81 } = require("../sdk/report");

    it("reviews each unreviewed change once, bound to it by hash", async function () {
      const log = openAuditLog(tempLog());
      log.record({ system: "s", actor: "a", before: BEFORE, after: AFTER, reason: "lower temperature" });
      const seen = [];
      const complete = async (messages) => {
        seen.push(messages[1].content);
        return { ok: true, model: "0gm-1.0-35b-a3b", text: 'Sure: {"summary":"Lowers temperature.","risk":"low","concerns":[]}' };
      };
      const first = await reviewPending(log, { complete });
      expect(first.written).to.have.length(1);
      expect(first.written[0]).to.include({ kind: "review", reviews: 0, risk: "low", reviewer: "0g-compute:0gm-1.0-35b-a3b" });
      expect(first.written[0].evidence.requestHash).to.match(/^0x[0-9a-f]{64}$/);
      expect(seen[0]).to.include("temperature: 0.7 -> 0.2");
      expect((await reviewPending(log, { complete })).written).to.have.length(0);
      expect(log.verify().ok).to.equal(true);
      expect(renderMarkdown(log.entries())).to.include("## Model reviews");
    });

    it("never sends redacted values, and skips replies that are not the JSON asked for", async function () {
      const log = openAuditLog(tempLog());
      log.track("s", { secret: "do not leak" }, { actor: "a", redact: true });
      log.track("s", { secret: "still secret" }, { actor: "a", redact: true });
      let sent = "";
      const result = await reviewPending(log, { complete: async (m) => ((sent += m[1].content), { ok: true, text: "no json here" }) });
      expect(sent).to.not.include("secret\"").and.to.not.include("do not leak").and.to.not.include("still secret");
      expect(result.written).to.have.length(0);
      expect(result.skipped[0].reason).to.match(/JSON/);
    });

    it("catches a review moved onto a different change", function () {
      const file = tempLog();
      const log = openAuditLog(file);
      log.record({ system: "s", actor: "a", after: BEFORE });
      log.record({ system: "s", actor: "a", before: BEFORE, after: AFTER });
      log.recordReview({ seq: 1, reviewer: "x", summary: "ok", risk: "low" });
      const lines = fs.readFileSync(file, "utf8").trim().split("\n");
      const forged = JSON.parse(lines[2]);
      forged.reviews = 0;
      lines[2] = JSON.stringify(forged);
      fs.writeFileSync(file, lines.join("\n") + "\n");
      expect(openAuditLog(file).verify().problems.map((p) => p.reason).join(" ")).to.match(/review does not point/);
    });

    it("exports SOC 2 CC8.1 evidence rows that say what is missing", function () {
      const log = openAuditLog(tempLog());
      log.record({ system: "s", actor: "a", after: AFTER, reason: "tune", ticket: "SUP-1", eval: { score: 0.9, baseline: 0.8 } });
      const csv = renderCc81(log.entries()).trim().split("\n");
      expect(csv[0]).to.match(/^"Control","Change ID"/);
      expect(csv[1]).to.include('"CC8.1","#0"').and.to.include("score 0.9 vs baseline 0.8").and.to.include('"Missing: approval"');
    });
  });

  describe("cli", function () {
    const bin = path.join(__dirname, "..", "bin", "germline.js");

    it("records, verifies and reports, and exits non-zero on tampering", function () {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "germline-cli-"));
      const file = path.join(dir, "audit.jsonl");
      fs.writeFileSync(path.join(dir, "old.json"), JSON.stringify(BEFORE));
      fs.writeFileSync(path.join(dir, "new.json"), JSON.stringify(AFTER));
      const run = (...args) => execFileSync("node", [bin, ...args, "--log", file], { cwd: dir, encoding: "utf8" });

      expect(run("record", "--system", "bot", "--actor", "ash", "--before", "old.json", "--after", "new.json", "--score", "0.9")).to.match(/recorded #0/);
      expect(run("verify")).to.match(/^ok: 1 entries/);
      expect(run("report")).to.include("# AI configuration change record");

      fs.writeFileSync(file, fs.readFileSync(file, "utf8").replace('"ash"', '"eve"'));
      let code = 0;
      try {
        run("verify");
      } catch (error) {
        code = error.status;
      }
      expect(code).to.equal(1);
    });

    function attempt(dir, ...args) {
      try {
        return { code: 0, out: execFileSync("node", [bin, ...args], { cwd: dir, encoding: "utf8", stdio: "pipe" }) };
      } catch (error) {
        return { code: error.status, out: String(error.stdout) + String(error.stderr) };
      }
    }

    it("checks a pinned log id offline and rejects unknown or misplaced options", function () {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "germline-cli-"));
      fs.writeFileSync(path.join(dir, "new.json"), JSON.stringify(AFTER));
      const file = path.join(dir, "audit.jsonl");
      expect(attempt(dir, "record", "--system", "bot", "--actor", "ash", "--after", "new.json", "--reason", "--force-pushed hotfix", "--log", file).code).to.equal(0);
      expect(openAuditLog(file).entries()[0].reason).to.equal("--force-pushed hotfix");
      const id = attempt(dir, "id", "--log", file).out.trim();
      expect(attempt(dir, "verify", "--log", file, "--log-id", id).code).to.equal(0);
      expect(attempt(dir, "verify", "--log", file, "--log-id", "0x" + "2".repeat(64))).to.include({ code: 1 });
      expect(attempt(dir, "verify", "--log", file, "--strict").code).to.equal(1);
      expect(attempt(dir, "verify", "--log", file, "--anchorer", "0x" + "a".repeat(40)).out).to.include("add --chain");
      expect(attempt(dir, "verify", "--log", file, "--anchorr", "0x1").out).to.include("unknown option --anchorr");
      expect(attempt(dir, "--version").out.trim()).to.equal(require("../package.json").version);
      expect(attempt(dir, "verify", "--log", file, "--log-id", "").out).to.include("--log-id is empty");
      const upload = attempt(dir, "anchor", "--log", file, "--upload");
      expect(upload.code).to.equal(1);
      expect(upload.out).to.include("0G Storage is public");
    });

    it("writes json and csv reports", function () {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "germline-cli-"));
      fs.writeFileSync(path.join(dir, "new.json"), JSON.stringify(AFTER));
      attempt(dir, "record", "--system", "bot", "--actor", "ash", "--after", "new.json", "--score", "0.9");
      expect(attempt(dir, "report", "--out", "pack.csv").code).to.equal(0);
      expect(fs.readFileSync(path.join(dir, "pack.csv"), "utf8")).to.match(/^seq,ts/);
      expect(JSON.parse(attempt(dir, "report", "--format", "json").out).changes).to.have.length(1);
    });
  });
});
