const { expect } = require("chai");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");
const { openAuditLog } = require("../sdk/audit");
const { init, trackAll, discover, snapshot } = require("../sdk/track");
const { renderMarkdown } = require("../sdk/report");

// The path a team actually takes: init once, then track on every change.

function repo(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "germline-repo-"));
  for (const [name, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
    fs.writeFileSync(path.join(dir, name), content);
  }
  return dir;
}

const FILES = {
  "prompts/system.md": "You are a helpful support agent.",
  "config/agent.json": JSON.stringify({ model: "m-1", temperature: 0.7 }),
  "src/index.js": "console.log(1)",
  "package.json": "{}",
  "node_modules/x/prompt.md": "not ours",
};

describe("init and track", function () {
  beforeEach(function () {
    process.env.GERMLINE_ACTOR = "test-actor";
  });
  afterEach(function () {
    delete process.env.GERMLINE_ACTOR;
  });

  it("finds prompt and agent config files, and skips the rest", function () {
    expect(discover(repo(FILES))).to.deep.equal(["config/agent.json", "prompts/system.md"]);
  });

  it("snapshots JSON as values, text as text, and missing files as null", function () {
    const dir = repo(FILES);
    expect(snapshot(["config/agent.json", "prompts/system.md", "gone.md"], dir)).to.deep.equal({
      "config/agent.json": { model: "m-1", temperature: 0.7 },
      "prompts/system.md": "You are a helpful support agent.",
      "gone.md": null,
    });
  });

  it("init writes config, workflow and a baseline, and never overwrites", function () {
    const dir = repo(FILES);
    const first = init({ cwd: dir, system: "support" });
    expect(first).to.include({ config: "written", workflow: "written" });
    expect(first.baseline).to.have.length(1);
    expect(fs.readFileSync(path.join(dir, ".github/workflows/germline.yml"), "utf8")).to.include("let-the-dreamers-rise/germline@");
    expect(fs.readFileSync(path.join(dir, ".germline/.gitignore"), "utf8")).to.include("storage/");

    const again = init({ cwd: dir, system: "other" });
    expect(again).to.include({ config: "kept", workflow: "kept" });
    expect(again.baseline).to.have.length(0);
  });

  it("init refuses politely when it finds nothing", function () {
    expect(() => init({ cwd: repo({ "src/a.js": "" }) })).to.throw(/--files/);
  });

  it("track records only what changed, with the setting that moved", function () {
    const dir = repo(FILES);
    init({ cwd: dir, system: "support" });
    expect(trackAll({ cwd: dir }).written).to.have.length(0);

    fs.writeFileSync(path.join(dir, "config/agent.json"), JSON.stringify({ model: "m-1", temperature: 0.2 }));
    const { written, log } = trackAll({ cwd: dir, reason: "lower temperature" });
    expect(written).to.have.length(1);
    expect(written[0].changes).to.deep.equal([
      { key: "config/agent.json", from: { model: "m-1", temperature: 0.7 }, to: { model: "m-1", temperature: 0.2 } },
    ]);
    expect(written[0]).to.include({ actor: "test-actor", reason: "lower temperature" });

    fs.unlinkSync(path.join(dir, "prompts/system.md"));
    const deleted = trackAll({ cwd: dir }).written[0];
    expect(deleted.changes[0]).to.deep.include({ key: "prompts/system.md", to: null });
    expect(log.verify().ok).to.equal(true);
  });

  it("takes the reason and commit from git", function () {
    const dir = repo(FILES);
    const g = (...args) => execFileSync("git", args, { cwd: dir, stdio: "ignore" });
    g("init", "-q");
    g("-c", "user.email=t@t", "-c", "user.name=t", "add", ".");
    g("-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "Tighten refund prompt");
    init({ cwd: dir, system: "support" });
    const entry = openAuditLog(path.join(dir, ".germline/audit.jsonl")).entries()[0];
    expect(entry.reason).to.equal("baseline: germline init");
    fs.writeFileSync(path.join(dir, "prompts/system.md"), "You are terse.");
    const changed = trackAll({ cwd: dir }).written[0];
    expect(changed.reason).to.equal("Tighten refund prompt");
    expect(changed.ticket).to.match(/^[0-9a-f]{12}$/);
  });

  it("track() in the SDK is a no-op when nothing changed", function () {
    const log = openAuditLog(path.join(repo({}), "a.jsonl"));
    expect(log.track("bot", { t: 1 })).to.not.equal(null);
    expect(log.track("bot", { t: 1 })).to.equal(null);
    const second = log.track("bot", { t: 2 });
    expect(second.before).to.deep.equal({ t: 1 });
    expect(log.entries()).to.have.length(2);
  });

  it("keeps long prompts readable in the evidence pack", function () {
    const log = openAuditLog(path.join(repo({}), "a.jsonl"));
    log.track("bot", { prompt: "x".repeat(500) }, { actor: "a" });
    expect(renderMarkdown(log.entries())).to.include("(500 chars)");
  });

  it("cli: init, track, verify in a fresh repo", function () {
    const dir = repo(FILES);
    const bin = path.join(__dirname, "..", "bin", "germline.js");
    const run = (...args) => execFileSync("node", [bin, ...args], { cwd: dir, encoding: "utf8" });
    expect(run("init", "--system", "support")).to.include("germline is set up");
    expect(run("track")).to.include("no tracked config changed");
    fs.writeFileSync(path.join(dir, "prompts/system.md"), "You are terse.");
    expect(run("track")).to.match(/recorded #1 +support +prompts\/system\.md/);
    expect(run("verify")).to.match(/^ok: 2 entries/);
    expect(run("anchor", "--if-key")).to.include("skipping");
  });
});
