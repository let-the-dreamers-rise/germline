const { expect } = require("chai");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");
const { openAuditLog } = require("../sdk/audit");
const { init, trackAll, discover, snapshot, ticketFrom, loadConfig } = require("../sdk/track");
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
  // CI sets these for the germline repository itself; the temporary repos
  // here are different repositories, so hide them.
  const CI_VARS = ["GITHUB_SHA", "GITHUB_REPOSITORY", "GITHUB_ACTOR", "CI_COMMIT_SHA", "GERMLINE_ANCHOR_KEY", "DEPLOYER_KEY"];
  let saved;
  beforeEach(function () {
    saved = Object.fromEntries(CI_VARS.map((k) => [k, process.env[k]]));
    for (const k of CI_VARS) delete process.env[k];
    process.env.GERMLINE_ACTOR = "test-actor";
  });
  afterEach(function () {
    delete process.env.GERMLINE_ACTOR;
    for (const [k, v] of Object.entries(saved)) if (v !== undefined) process.env[k] = v;
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

  it("skips the workflow outside git, and names the system from package.json", function () {
    const dir = repo({ ...FILES, "package.json": JSON.stringify({ name: "@acme/support-bot" }) });
    const report = init({ cwd: dir });
    expect(report.workflow).to.equal(null);
    expect(loadConfig(dir).systems[0].name).to.equal("support-bot");
  });

  it("init writes config, workflow and a baseline, and never overwrites", function () {
    const dir = repo(FILES);
    execFileSync("git", ["init", "-q"], { cwd: dir });
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
      { key: "config/agent.json › temperature", from: 0.7, to: 0.2 },
    ]);
    expect(written[0]).to.include({ actor: "test-actor", reason: "lower temperature" });

    fs.unlinkSync(path.join(dir, "prompts/system.md"));
    const deleted = trackAll({ cwd: dir }).written[0];
    expect(deleted.changes[0]).to.deep.include({ key: "prompts/system.md", to: null });
    expect(log.verify().ok).to.equal(true);
  });

  it("records one entry per commit, credited to its author, with its ticket", function () {
    const dir = repo(FILES);
    const g = (email, ...args) => execFileSync("git", ["-c", "user.email=" + email, "-c", "user.name=n", ...args], { cwd: dir, stdio: "ignore" });
    g("a@x", "init", "-q");
    g("a@x", "add", ".");
    g("a@x", "commit", "-qm", "Tighten refund prompt");
    init({ cwd: dir, system: "support" });
    const first = openAuditLog(path.join(dir, ".germline/audit.jsonl")).entries()[0];
    expect(first).to.include({ actor: "a@x", reason: "Tighten refund prompt", recordedBy: "test-actor" });
    expect(first.commit).to.match(/^[0-9a-f]{40}$/);

    fs.writeFileSync(path.join(dir, "prompts/system.md"), "You are terse.");
    g("b@x", "commit", "-qam", "Shorter prompt (SUP-42)");
    fs.writeFileSync(path.join(dir, "config/agent.json"), JSON.stringify({ model: "m-2", temperature: 0.7 }));
    g("c@x", "commit", "-qam", "Upgrade model, fixes #7");
    const { written, log } = trackAll({ cwd: dir });
    expect(written.map((e) => [e.actor, e.ticket])).to.deep.equal([["b@x", "SUP-42"], ["c@x", "#7"]]);
    expect(written[1].changes).to.deep.equal([{ key: "config/agent.json › model", from: "m-1", to: "m-2" }]);
    expect(trackAll({ cwd: dir }).written).to.have.length(0);

    fs.writeFileSync(path.join(dir, "prompts/system.md"), "Uncommitted.");
    expect(trackAll({ cwd: dir }).written[0]).to.include({ reason: "uncommitted working-tree change", commit: null });
    expect(log.verify().ok).to.equal(true);
  });

  it("refuses tracked paths outside the repository, through links, or in .git", function () {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "germline-out-"));
    fs.writeFileSync(path.join(outside, "secret.env"), "SECRET=1");
    const dir = repo(FILES);
    fs.symlinkSync(path.join(outside, "secret.env"), path.join(dir, "agent.prompt"));
    const config = (files) => ({ systems: [{ name: "s", files }] });
    expect(() => trackAll({ cwd: dir, config: config(["../x"]) })).to.throw(/outside the repository/);
    expect(() => trackAll({ cwd: dir, config: config([path.join(outside, "secret.env")]) })).to.throw(/outside/);
    expect(() => trackAll({ cwd: dir, config: config(["agent.prompt"]) })).to.throw(/link to a file outside/);
    expect(() => trackAll({ cwd: dir, config: config([".git/config"]) })).to.throw(/inside .git/);
  });

  it("finds tickets in commit messages", function () {
    expect(ticketFrom("Fix refunds (LEGAL-88)")).to.equal("LEGAL-88");
    expect(ticketFrom("Merge pull request #12 from x")).to.equal("#12");
    expect(ticketFrom("no ticket here")).to.equal(null);
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
    log.track("bot", { prompt: "line one\nline two" }, { actor: "a" });
    const md = renderMarkdown(log.entries());
    expect(md).to.match(/prompt: \d line\(s\) changed/);
    expect(md).to.include("## Text changes").to.include("## Text changes").and.to.include("    + line two");
  });

  it("demo records, verifies, and catches the tampering it stages", function () {
    const lines = [];
    const { demo } = require("../sdk/demo");
    const result = demo({ out: (l) => lines.push(l), delay: 0 });
    expect(result.detected).to.equal(true);
    expect(lines.join("\n")).to.include("verify: OK, 4 entries").and.to.include("verify: FAILED");
    expect(fs.existsSync(result.dir)).to.equal(false);
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
