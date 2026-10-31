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

  it("finds on-chain agent configs: ElizaOS characters, SOUL files, MCP tool lists", function () {
    const dir = repo({
      "characters/trader.character.json": "{}",
      "SOUL.md": "be careful",
      "mcp.json": "{}",
      "docs/privacy.md": "not ai config",
    });
    expect(discover(dir)).to.deep.equal(["SOUL.md", "characters/trader.character.json", "mcp.json"]);
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
    expect(first).to.include({ config: "written", workflow: "written", deferred: true });
    expect(first.baseline).to.have.length(0);
    expect(fs.readFileSync(path.join(dir, ".germline/.gitignore"), "utf8")).to.include("audit.jsonl");
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
    init({ cwd: dir, system: "support", workflow: false });
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

  it("keeps attributing per commit when files end in a newline", function () {
    const dir = repo({ "prompts/system.md": "v1\n", "config/agent.json": '{"model":"m-1"}\n' });
    const g = (email, ...args) => execFileSync("git", ["-c", "user.email=" + email, "-c", "user.name=n", ...args], { cwd: dir, stdio: "ignore" });
    g("a@x", "init", "-q");
    g("a@x", "add", ".");
    g("a@x", "commit", "-qm", "first");
    init({ cwd: dir, system: "s", workflow: false });
    expect(trackAll({ cwd: dir }).written).to.have.length(0);
    fs.writeFileSync(path.join(dir, "prompts/system.md"), "v2\n");
    g("b@x", "commit", "-qam", "Tighten refunds per LEGAL-88");
    const [entry, ...rest] = trackAll({ cwd: dir }).written;
    expect(rest).to.have.length(0);
    expect(entry).to.include({ actor: "b@x", reason: "Tighten refunds per LEGAL-88", ticket: "LEGAL-88" });
    expect(entry.commit).to.match(/^[0-9a-f]{40}$/);
  });

  it("a commit message cannot invent commits", function () {
    const dir = repo({ "prompts/system.md": "v1" });
    const g = (...args) => execFileSync("git", ["-c", "user.email=dev@x", "-c", "user.name=n", ...args], { cwd: dir, stdio: "ignore" });
    g("init", "-q");
    g("add", ".");
    g("commit", "-qm", "first");
    const first = execFileSync("git", ["rev-parse", "HEAD"], { cwd: dir, encoding: "utf8" }).trim();
    init({ cwd: dir, system: "s", files: ["prompts/system.md"], workflow: false });
    fs.writeFileSync(path.join(dir, "prompts/system.md"), "v2");
    g("commit", "-qam", "tweak\x1e" + first + "\x1fCEO\x1fceo@corp.com\x1f2020-01-01T00:00:00Z\x1fApproved by board SEC-1");
    const { written } = trackAll({ cwd: dir });
    expect(written).to.have.length(1);
    expect(written[0].actor).to.equal("dev@x");
  });

  it("refuses tracked paths outside the repository, through links, or in .git", function () {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "germline-out-"));
    fs.writeFileSync(path.join(outside, "secret.env"), "SECRET=1");
    const dir = repo(FILES);
    fs.symlinkSync(path.join(outside, "secret.env"), path.join(dir, "agent.prompt"));
    const config = (files) => ({ systems: [{ name: "s", files }] });
    expect(() => trackAll({ cwd: dir, config: config(["../x"]) })).to.throw(/outside the repository/);
    expect(() => trackAll({ cwd: dir, config: config([path.join(outside, "secret.env")]) })).to.throw(/outside/);
    expect(() => trackAll({ cwd: dir, config: config(["agent.prompt"]) })).to.throw(/symbolic link/);
    expect(() => trackAll({ cwd: dir, config: config([".git/config"]) })).to.throw(/inside .git/);
    expect(() => trackAll({ cwd: dir, config: config([".GIT/config"]) })).to.throw(/inside .git/);
    fs.mkdirSync(path.join(dir, ".git"));
    fs.writeFileSync(path.join(dir, ".git", "config"), "extraheader = AUTHORIZATION: basic c2VjcmV0");
    fs.symlinkSync(".git", path.join(dir, "foo"));
    expect(() => trackAll({ cwd: dir, config: config(["foo/config"]) })).to.throw(/symbolic link/);
  });

  it("records who approved each commit's pull request, from GitHub", async function () {
    const { approvalsFor } = require("../sdk/github");
    const sha = "a".repeat(40);
    const calls = [];
    const fetch = async (url) => {
      calls.push(url);
      const body = url.endsWith("/pulls")
        ? [{ number: 12, merged_at: "2026-10-01T00:00:00Z", html_url: "https://github.com/o/r/pull/12" }]
        : url.endsWith("/pulls/12")
          ? { merged_by: { login: "lead" } }
          : [
              { user: { login: "rev1" }, state: "APPROVED", submitted_at: "2026-09-30T10:00:00Z" },
              { user: { login: "rev2" }, state: "APPROVED", submitted_at: "2026-09-30T11:00:00Z" },
              { user: { login: "rev2" }, state: "CHANGES_REQUESTED", submitted_at: "2026-09-30T12:00:00Z" },
              { user: { login: "rev1" }, state: "COMMENTED", submitted_at: "2026-09-30T13:00:00Z" },
            ];
      return { ok: true, json: async () => body };
    };
    const out = await approvalsFor([sha, "not-a-sha"], { repo: "o/r", token: "t", fetch });
    expect(out[sha]).to.include({ pr: 12, mergedBy: "lead", approvedAt: "2026-09-30T10:00:00Z" });
    expect(out[sha].approvedBy).to.deep.equal(["rev1"]);
    expect(calls.every((u) => u.startsWith("https://api.github.com/repos/o/r/"))).to.equal(true);
    expect(await approvalsFor([sha], { repo: "o/r", token: undefined, fetch })).to.deep.equal({});

    const log = openAuditLog(path.join(repo({}), "a.jsonl"));
    log.record({ system: "s", actor: "a", after: { t: 1 }, reason: "x", commit: sha, approval: out[sha] });
    expect(renderMarkdown(log.entries())).to.include("approved by rev1 in PR \\#12");
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
