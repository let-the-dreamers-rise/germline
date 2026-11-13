const { expect } = require("chai");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");
const { openAuditLog } = require("../sdk/audit");
const core = require("../sdk/verify-core");
const write = require("../web/anchor-core");

// The browser app (web/anchor.html) writes logs with web/anchor-core.js.
// Those logs must be the CLI's logs: same hashes, verifiable by the CLI, and
// appendable by it afterwards.

const CLI = path.join(__dirname, "..", "bin", "germline.js");
const TS = ["2026-11-12T00:00:00.000Z", "2026-11-12T00:01:00.000Z", "2026-11-12T00:02:00.000Z"];

describe("browser log writer", function () {
  it("writes the same change entries, byte for byte, as the SDK", function () {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "germline-web-")), "audit.jsonl");
    let i = 0;
    const log = openAuditLog(file, { clock: () => TS[i++] });
    const v1 = { model: "gpt-4o-mini", temperature: 0.2, tools: { search: true } };
    const v2 = { model: "gpt-4o-mini", temperature: 0.7, tools: { search: false } };
    log.record({ system: "agent", actor: "ash", after: v1, reason: "first" });
    log.record({ system: "agent", actor: "ash", before: v1, after: v2, reason: "warmer" });

    const web = [];
    web.push(write.change(web, { system: "agent", actor: "ash", after: v1, reason: "first", ts: TS[0] }));
    web.push(write.change(web, { system: "agent", actor: "ash", after: v2, reason: "warmer", ts: TS[1] }));
    expect(write.serialize(web)).to.equal(fs.readFileSync(file, "utf8"));
  });

  it("writes anchor entries the verifier accepts, and the CLI can keep appending", function () {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "germline-web-"));
    const web = [];
    web.push(write.change(web, { system: "agent", actor: "0xabc", after: { model: "m" }, ts: TS[0] }));
    const check = core.verifyEntries(web);
    web.push(
      write.anchor(
        web,
        { logId: check.logId, head: check.head, entries: check.entries, chainId: 677, registry: "0x" + "1".repeat(40), index: 0, txHash: "0x" + "2".repeat(64), block: 5, anchorer: "0x" + "3".repeat(40) },
        TS[1]
      )
    );
    expect(core.verifyEntries(web).ok).to.equal(true);
    const file = path.join(dir, "audit.jsonl");
    fs.writeFileSync(file, write.serialize(web));
    fs.writeFileSync(path.join(dir, "v2.json"), JSON.stringify({ model: "m2" }));
    execFileSync("node", [CLI, "record", "--log", file, "--system", "agent", "--actor", "ash", "--after", path.join(dir, "v2.json")]);
    const out = execFileSync("node", [CLI, "verify", "--log", file]).toString();
    expect(out).to.match(/^ok: 3 entries/);
  });

  it("records commit fields the way germline track does", function () {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "germline-web-")), "audit.jsonl");
    const log = openAuditLog(file, { clock: () => TS[0] });
    log.record({ system: "agent", actor: "a@b.c", after: { m: 1 }, reason: "tune", commit: "abc123", committedAt: "2026-11-01T00:00:00Z" });
    const web = [write.change([], { system: "agent", actor: "a@b.c", after: { m: 1 }, reason: "tune", commit: "abc123", committedAt: "2026-11-01T00:00:00Z", ts: TS[0] })];
    expect(write.serialize(web)).to.equal(fs.readFileSync(file, "utf8"));
    expect(Array.from(write.recordedCommits(web))).to.deep.equal(["abc123"]);
  });

  it("refuses to append to a log that does not verify", function () {
    const web = [write.change([], { system: "a", actor: "b", after: { x: 1 } })];
    web[0].after = { x: 2 };
    expect(() => write.change(web, { system: "a", actor: "b", after: { x: 3 } })).to.throw(/does not verify/);
  });

  it("knows when a change is not yet covered by any anchor", function () {
    const W = require("../web/anchor-core.js");
    const { needsAnchor } = require("../sdk/audit");
    const log = [];
    log.push(W.change(log, { system: "s", actor: "a", after: { m: 1 } }));
    const head = log[0].hash;
    log.push(W.change(log, { system: "s", actor: "a", after: { m: 2 } })); // recorded while the anchor tx was in flight
    log.push(W.anchor(log, { logId: head, head, entries: 1, chainId: 677, registry: "0x" + "1".repeat(40), index: 0, txHash: "0x" + "2".repeat(64), block: 1, anchorer: "0x" + "3".repeat(40) }));
    expect(W.needsAnchor(log)).to.equal(true);
    expect(needsAnchor(log)).to.equal(true);
    expect(W.needsAnchor(log.slice(0, 1))).to.equal(true);
    expect(W.needsAnchor([])).to.equal(false);
  });
});
