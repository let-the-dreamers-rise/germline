const { expect } = require("chai");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync, spawnSync } = require("child_process");
const { openAuditLog } = require("../sdk/audit");
const core = require("../sdk/verify-core");
const { init, trackAll, loadConfig } = require("../sdk/track");

// Regression tests for the 2026-10-31 red-team pass. Each one is an input
// that used to pass verification, crash it, go unrecorded, or make the CLI
// and the browser verifier disagree.

const CLI = path.join(__dirname, "..", "bin", "germline.js");
const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), "germline-hard-" + (p || "")));

function goodLog() {
  const file = path.join(tmp(), "audit.jsonl");
  const log = openAuditLog(file);
  log.record({ system: "bot", actor: "ash", after: { model: "m-1", temperature: 0.7 } });
  log.record({ system: "bot", actor: "ash", before: { model: "m-1", temperature: 0.7 }, after: { model: "m-1", temperature: 0.2 } });
  return file;
}

describe("hardening", function () {
  it("the browser verifier runs the very same core as the CLI", function () {
    const sdk = fs.readFileSync(path.join(__dirname, "..", "sdk", "verify-core.js"));
    const web = fs.readFileSync(path.join(__dirname, "..", "web", "verify-core.js"));
    expect(web.equals(sdk), "web/verify-core.js differs from sdk/verify-core.js; copy it over").to.equal(true);
    const html = fs.readFileSync(path.join(__dirname, "..", "web", "verify.html"), "utf8");
    expect(html).to.include('<script src="verify-core.js"></script>');
    expect(html).to.include("GermlineVerify.verifyChain(");
    expect(html).not.to.match(/function verifyEntries|function stableStringify/);
  });

  it("rejects a log with a byte-order mark, in every verifier", function () {
    const file = goodLog();
    fs.writeFileSync(file, Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), fs.readFileSync(file)]));
    const result = openAuditLog(file).verify();
    expect(result.ok).to.equal(false);
    expect(result.problems[0].reason).to.match(/byte-order mark/);
  });

  it("rejects bytes that are not UTF-8, so two files can't share a head", function () {
    const file = goodLog();
    const original = openAuditLog(file).verify();
    const bytes = fs.readFileSync(file);
    // Put a raw 0xFF inside a string value, where lossy decoding would have
    // read it as U+FFFD and hashed the same as a different file.
    const at = bytes.indexOf(Buffer.from('"ash"')) + 2;
    const forged = Buffer.concat([bytes.subarray(0, at), Buffer.from([0xff]), bytes.subarray(at)]);
    fs.writeFileSync(file, forged);
    const result = openAuditLog(file).verify();
    expect(result.ok).to.equal(false);
    expect(result.problems.map((p) => p.reason).join(" ")).to.match(/not valid UTF-8/);
    expect(original.ok).to.equal(true);
  });

  it("reports, rather than crashes on, absurdly nested configs", function () {
    let deep = 1;
    for (let i = 0; i < 3000; i++) deep = { d: deep };
    const entry = { format: core.FORMAT, seq: 0, prev: core.GENESIS, ts: new Date().toISOString(), kind: "change", system: "x", actor: "x", configRoot: "0x00", after: deep, hash: "0x00" };
    const result = core.verifyEntries([entry]);
    expect(result.ok).to.equal(false);
    expect(result.problems.map((p) => p.reason).join(" ")).to.match(/nested deeper/);
  });

  it("reads timestamps the same way in every JavaScript engine", function () {
    expect(core.parseTimestamp("2026-10-31T12:00:00Z")).to.equal(Date.UTC(2026, 9, 31, 12));
    expect(core.parseTimestamp("2026-10-31T12:00:00.250+05:30")).to.equal(Date.UTC(2026, 9, 31, 6, 30, 0, 250));
    expect(core.parseTimestamp("2024-02-29T00:00:00Z")).to.equal(Date.UTC(2024, 1, 29));
    for (const bad of ["2024-02-30T00:00:00Z", "2023-02-29T00:00:00Z", "2026-10-31T24:00:00Z", "2026-13-01T00:00:00Z", "2026-10-31T12:00:00", "2026-10-31T12:00:60Z"]) {
      expect(core.parseTimestamp(bad), bad).to.be.NaN;
    }
  });

  describe("tracking", function () {
    const g = (cwd, ...args) => execFileSync("git", ["-c", "user.email=dev@x", "-c", "user.name=dev", ...args], { cwd, stdio: "ignore" });

    it("records a change to a prompt that isn't UTF-8", function () {
      const dir = tmp();
      g(dir, "init", "-q");
      fs.mkdirSync(path.join(dir, "prompts"));
      fs.writeFileSync(path.join(dir, "prompts", "system.md"), Buffer.from("caf\xe9", "latin1"));
      g(dir, "add", "-A");
      g(dir, "commit", "-qm", "first");
      init({ cwd: dir, files: ["prompts/system.md"], workflow: false });
      fs.writeFileSync(path.join(dir, "prompts", "system.md"), Buffer.from("caf\xe8", "latin1"));
      g(dir, "commit", "-qam", "second");
      const { written } = trackAll({ cwd: dir });
      expect(written).to.have.length(1);
      expect(written[0].after["prompts/system.md"]).to.deep.equal({ encoding: "base64", data: Buffer.from("caf\xe8", "latin1").toString("base64") });
    });

    it("records the right history when run from a monorepo subdirectory", function () {
      const root = tmp();
      g(root, "init", "-q");
      const svc = path.join(root, "svc");
      fs.mkdirSync(path.join(svc, "prompts"), { recursive: true });
      fs.writeFileSync(path.join(svc, "prompts", "system.md"), "v1");
      g(root, "add", "-A");
      g(root, "commit", "-qm", "first");
      fs.writeFileSync(path.join(svc, "prompts", "system.md"), "v2");
      g(root, "commit", "-qam", "second PROJ-7");
      init({ cwd: svc, files: ["prompts/system.md"], workflow: false });
      const entries = openAuditLog(path.join(svc, ".germline", "audit.jsonl")).entries().filter((e) => e.kind === "change");
      expect(entries.map((e) => e.after["prompts/system.md"])).to.deep.equal(["v1", "v2"]);
      expect(entries[1].ticket).to.equal("PROJ-7");
    });

    it("refuses a config whose log path escapes the repo or carries a newline", function () {
      const dir = tmp();
      fs.mkdirSync(path.join(dir, ".germline"));
      const write = (log) => fs.writeFileSync(path.join(dir, ".germline", "config.json"), JSON.stringify({ log, systems: [{ name: "x", files: ["a.md"] }] }));
      write("../outside/escaped.jsonl");
      expect(() => loadConfig(dir)).to.throw(/outside the repository/);
      write("x.jsonl\nNODE_OPTIONS=--require=./evil.js");
      expect(() => loadConfig(dir)).to.throw(/plain relative path/);
      // And the CLI fails rather than quietly using some other log.
      const run = spawnSync(process.execPath, [CLI, "path"], { cwd: dir, encoding: "utf8" });
      expect(run.status).to.equal(1);
      expect(run.stdout).not.to.include("NODE_OPTIONS");
      write(".germline/audit.jsonl");
      expect(loadConfig(dir).log).to.equal(".germline/audit.jsonl");
    });
  });

  it("never lets log content print a CI workflow command", function () {
    const file = goodLog();
    const lines = fs.readFileSync(file, "utf8").trim().split("\n").map((l) => JSON.parse(l));
    // A forged entry whose seq is a workflow command and whose actor carries an escape sequence.
    lines.push({ ...lines[1], seq: "::error title=germline::ok: 2 entries, verified", actor: "\u001b[2K::stop-commands::x" });
    fs.writeFileSync(file, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
    for (const cmd of ["verify", "log", "report"]) {
      const run = spawnSync(process.execPath, [CLI, cmd, "--log", file], { encoding: "utf8" });
      const out = run.stdout + run.stderr;
      for (const line of out.split("\n")) expect(line.startsWith("::"), cmd + ": " + line).to.equal(false);
      expect(out).not.to.include("\u001b");
    }
  });
});
