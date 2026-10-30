const { expect } = require("chai");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");
const { openAuditLog, verifyEntries, diff, ANCHOR_TAG } = require("../sdk/audit");
const { renderMarkdown } = require("../sdk/report");

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
  });
});
