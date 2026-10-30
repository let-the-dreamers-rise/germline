"use strict";

// Zero-friction adoption: point Germline at the files that hold an AI
// system's behaviour, and it records every change to them from then on.
//
//     npx germline init      finds likely files, writes .germline/config.json
//                            and a GitHub workflow, records the baseline
//     npx germline track     records whatever changed since last time
//
// A team should never have to assemble before.json and after.json by hand.
// The previous state is already in the log, so `track` reads it from there,
// and the reason and ticket come from the commit that made the change.

const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");
const { openAuditLog, defaultActor } = require("./audit");

const CONFIG_FILE = path.join(".germline", "config.json");
const VERSION = require("../package.json").version;

// What a file holding AI behaviour tends to be called. Deliberately loose:
// init shows what it found and the team edits the list, which is faster than
// asking them to type paths from memory.
const NAME_HINT = /(prompt|system[-_.]?message|instruction|persona|agent|assistant|llm|model[-_.]?config|ai[-_.]?config|guardrail|rubric|eval)/i;
const EXT = /\.(json|ya?ml|md|txt|prompt|jinja2?|j2|hbs|mustache|toml)$/i;
const SKIP_DIR = /(^|\/)(node_modules|\.git|\.germline|dist|build|out|coverage|vendor|\.next|\.venv|venv|__pycache__|artifacts|cache)(\/|$)/;
const SKIP_FILE = /(^|\/)(package(-lock)?\.json|yarn\.lock|pnpm-lock\.yaml|tsconfig.*\.json|\.eslintrc.*|CHANGELOG\.md|LICENSE.*|README.*)$/i;

// Output is trimmed unless `raw`: file contents must keep their exact bytes,
// or a prompt ending in a newline would never match its working-tree copy.
function git(args, cwd, raw = false) {
  try {
    const out = execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], maxBuffer: 64 * 1024 * 1024 });
    return raw ? out : out.trim();
  } catch (error) {
    return null;
  }
}

const SHA = /^[0-9a-f]{40}([0-9a-f]{24})?$/;

function listFiles(cwd) {
  const tracked = git(["ls-files", "--cached", "--others", "--exclude-standard"], cwd);
  if (tracked !== null) return tracked.split("\n").filter(Boolean);
  const out = [];
  (function walk(dir) {
    for (const entry of fs.readdirSync(path.join(cwd, dir), { withFileTypes: true })) {
      const rel = dir ? dir + "/" + entry.name : entry.name;
      if (SKIP_DIR.test(rel)) continue;
      if (entry.isDirectory()) walk(rel);
      else out.push(rel);
    }
  })("");
  return out;
}

/// Files that look like they define an AI system's behaviour.
function discover(cwd = process.cwd()) {
  return listFiles(cwd)
    .filter((f) => !SKIP_DIR.test(f) && !SKIP_FILE.test(f) && EXT.test(f) && NAME_HINT.test(f))
    .sort()
    .slice(0, 50);
}

/// The tracked state of a system: each file's content, keyed by path. JSON is
/// parsed so a diff shows which setting moved; anything else is kept as text.
/// A missing file is recorded as null, because deleting a prompt is a change.
function snapshot(files, cwd = process.cwd()) {
  const state = {};
  for (const file of files) {
    const full = safePath(cwd, file);
    state[file] = fs.existsSync(full) ? parseContent(file, fs.readFileSync(full, "utf8")) : null;
  }
  return state;
}

function loadConfig(cwd = process.cwd(), file = CONFIG_FILE) {
  const full = path.join(cwd, file);
  if (!fs.existsSync(full)) {
    throw new Error("no " + file + " here. Run `npx germline init` first.");
  }
  const config = JSON.parse(fs.readFileSync(full, "utf8"));
  if (!Array.isArray(config.systems) || config.systems.length === 0) {
    throw new Error(file + " lists no systems to track");
  }
  return config;
}

/// Who, why and which commit, from whatever CI or git can tell us. Used for
/// changes git cannot attribute: a working tree with uncommitted edits, or a
/// checkout too shallow to walk.
function commitContext(cwd = process.cwd()) {
  const env = process.env;
  // The repository being tracked is the authority on its own commit; CI
  // variables are the fallback for checkouts git cannot read.
  const local = git(["rev-parse", "HEAD"], cwd);
  const sha = local || env.GITHUB_SHA || env.CI_COMMIT_SHA || null;
  const message = git(["log", "-1", "--pretty=%B"], cwd);
  return {
    reason: message ? message.split("\n")[0] : null,
    ticket: ticketFrom(message),
    commit: sha || null,
  };
}

// A ticket reference in a commit message: JIRA-style keys first, then a
// GitHub issue or PR number. The first one wins; the commit hash is recorded
// separately, so a message with no ticket just has none.
function ticketFrom(message) {
  if (!message) return null;
  const key = message.match(/\b[A-Z][A-Z0-9]{1,9}-\d+\b/);
  if (key) return key[0];
  const issue = message.match(/(^|\s|\()#(\d+)\b/);
  return issue ? "#" + issue[2] : null;
}

// Paths come from a config file anyone with commit access can edit, so a
// tracked path must stay inside the repository: no absolute paths, no `..`.
function safePath(cwd, file) {
  if (typeof file !== "string" || !file || file.includes("\0")) throw new Error("tracked path " + JSON.stringify(file) + " is not a file name");
  const root = fs.realpathSync(path.resolve(cwd));
  const full = path.resolve(root, file);
  const inside = (p) => p === root || p.startsWith(root + path.sep);
  if (path.isAbsolute(file) || !inside(full)) {
    throw new Error("tracked path " + JSON.stringify(file) + " is outside the repository");
  }
  const parts = path.relative(root, full).split(path.sep);
  // Case-insensitive: on macOS and Windows runners .GIT is .git.
  if (parts.some((p) => p.toLowerCase() === ".git")) {
    throw new Error("tracked path " + JSON.stringify(file) + " is inside .git");
  }
  // No symlinks anywhere along the path. A link to a parent (foo -> .git) or
  // to a file outside the repository could otherwise copy the CI token or a
  // runner secret into a log that is committed and pushed.
  let at = root;
  for (const part of parts) {
    at = path.join(at, part);
    let stat;
    try {
      stat = fs.lstatSync(at);
    } catch (missing) {
      break;
    }
    if (stat.isSymbolicLink()) {
      throw new Error("tracked path " + JSON.stringify(file) + " goes through a symbolic link (" + path.relative(root, at) + "); track the real file");
    }
  }
  return full;
}

function parseContent(file, text) {
  if (/\.json$/i.test(file)) {
    try {
      return JSON.parse(text);
    } catch (ignored) {
      // An unparseable JSON file is still a file whose content changed.
    }
  }
  return text;
}

/// The tracked files as they were at one commit.
function snapshotAt(files, sha, cwd) {
  const state = {};
  for (const file of files) {
    safePath(cwd, file);
    if (!SHA.test(sha)) throw new Error("not a commit hash: " + JSON.stringify(sha));
    const text = git(["show", sha + ":" + file.split(path.sep).join("/")], cwd, true);
    state[file] = text === null ? null : parseContent(file, text);
  }
  return state;
}

/// Commits that touched `files`, oldest first, after `since` (exclusive), or
/// the whole history when `since` is null. Null when git cannot answer, e.g.
/// `since` was rebased away or is beyond a shallow checkout.
///
/// Hashes come from one call and each commit's details from another, split
/// on NUL, which a commit message cannot contain. Splitting one combined log
/// on printable separators would let a crafted message invent commits.
function commitsTouching(files, since, cwd, limit) {
  if (since && git(["merge-base", "--is-ancestor", since, "HEAD"], cwd) === null) return null;
  const range = since ? [since + "..HEAD"] : ["HEAD"];
  const out = git(["log", "--reverse", "--format=%H", ...range, "--", ...files], cwd);
  if (out === null) return null;
  let shas = out.split("\n").filter(Boolean);
  if (shas.some((sha) => !SHA.test(sha))) return null;
  let skipped = 0;
  if (limit && shas.length > limit) {
    skipped = shas.length - limit;
    shas = shas.slice(skipped);
  }
  const commits = shas.map((sha) => {
    const raw = git(["show", "-s", "--format=%an%x00%ae%x00%aI%x00%cI%x00%B", sha], cwd, true) || "";
    const [name, email, authored, committed, ...rest] = raw.split("\0");
    return { sha, name, email, date: committed || authored, authoredAt: authored, message: rest.join(" ").trim() };
  });
  commits.skipped = skipped;
  return commits;
}

/// Record every tracked system's changes since the log last saw them.
///
/// In a git repository this walks the commits that touched the tracked
/// files, one entry per commit, credited to the commit's author with the
/// commit's own message -- so two commits pushed together stay two records.
/// The CI identity that ran the recording is kept as `recordedBy`. Anything
/// git cannot attribute (uncommitted edits, a checkout too shallow to reach
/// the last recorded commit) is recorded once, from the working tree.
///
/// Returns the entries written; an empty array means nothing changed.
function trackAll(options = {}) {
  const cwd = options.cwd || process.cwd();
  const config = options.config || loadConfig(cwd);
  const log = openAuditLog(options.log ? path.resolve(cwd, options.log) : path.join(cwd, config.log || path.join(".germline", "audit.jsonl")));
  const inGit = git(["rev-parse", "HEAD"], cwd) !== null;
  const recordedBy = defaultActor();
  const written = [];

  for (const system of config.systems) {
    for (const file of system.files) safePath(cwd, file);
    const common = { redact: system.redact === true, eval: options.eval, recordedBy };
    const last = log.lastChange(system.name);

    let gap = null;
    if (inGit && options.history !== false) {
      // Walk from the last commit this system recorded. Working-tree entries
      // carry no commit and do not reset the walk.
      const history = log.entries().filter((e) => e.kind === "change" && e.system === system.name);
      const lastCommitted = [...history].reverse().find((e) => typeof e.commit === "string" && SHA.test(e.commit));
      const since = lastCommitted ? lastCommitted.commit : null;
      // Entries but none from git: written before commit tracking or outside
      // git, and walking all history would replay them.
      const commits = history.length && !since ? null : commitsTouching(system.files, since, cwd, options.limit || 200);
      if (commits === null && since) gap = "history since the last recorded commit is not available (rebased, force-pushed, or a shallow checkout)";
      if (commits && commits.skipped) gap = commits.skipped + " older commit(s) not walked (limit " + (options.limit || 200) + ")";
      for (const c of commits || []) {
        const approval = options.approvals && options.approvals[c.sha];
        const entry = log.track(system.name, snapshotAt(system.files, c.sha, cwd), {
          ...common,
          // The author git reports. Not authenticated by git itself; an
          // approval from the GitHub API, when present, is.
          actor: options.actor || c.email || c.name,
          reason: options.reason || c.message.split("\n")[0] || null,
          ticket: options.ticket || ticketFrom(c.message) || (approval && approval.pr ? "#" + approval.pr : null),
          commit: c.sha,
          committedAt: c.date,
          approval: approval || undefined,
        });
        if (entry) written.push(entry);
      }
    }

    // Whatever is on disk now and not yet recorded.
    const context = commitContext(cwd);
    const entry = log.track(system.name, snapshot(system.files, cwd), {
      ...common,
      actor: options.actor || recordedBy,
      reason:
        options.reason ||
        (written.some((e) => e.system === system.name) || !options.baselineReason
          ? inGit
            ? gap || "uncommitted working-tree change"
            : context.reason
          : options.baselineReason),
      ticket: options.ticket || (inGit ? null : context.ticket),
      commit: inGit ? null : context.commit,
    });
    if (entry) written.push(entry);
  }
  return { log, written };
}

function workflow() {
  return `# Records every change to your AI configuration in a tamper-evident log,
# and anchors it on 0G when GERMLINE_ANCHOR_KEY is set. Written by
# \`germline init\`; edit freely.
name: germline
on:
  push:
    branches: [main, master]
  workflow_dispatch:

permissions:
  contents: write        # push the log to its branch
  pull-requests: read    # record who approved each change

# One recorder at a time, so two merges cannot fork the log.
concurrency:
  group: germline
  cancel-in-progress: false

jobs:
  audit:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          # Full history, so each commit that touched a tracked file is
          # recorded on its own, credited to its author.
          fetch-depth: 0
      # Pinned to a release. Review the diff before moving it: this step
      # holds a write token and your anchor key.
      - uses: let-the-dreamers-rise/germline@v${VERSION}
        with:
          # The log lives on its own branch, so a protected main needs no
          # bot bypass. Remove this line to keep it beside your code.
          log-branch: germline-audit
          # Optional. Without it, changes are still recorded and verified;
          # they are just not anchored on chain until you add a key.
          anchor-key: \${{ secrets.GERMLINE_ANCHOR_KEY }}
`;
}

// A name a reader recognises: package.json, then the git remote, then the folder.
function systemName(cwd) {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(cwd, "package.json"), "utf8"));
    if (pkg.name && typeof pkg.name === "string") return pkg.name.replace(/^@[^/]+\//, "");
  } catch (ignored) {}
  const remote = git(["remote", "get-url", "origin"], cwd);
  const match = remote && remote.match(/([^/:]+?)(\.git)?$/);
  return match ? match[1] : path.basename(path.resolve(cwd));
}

/// Set a repository up in one step. Never overwrites an existing config or
/// workflow; reports what it did and what it left alone.
function init(options = {}) {
  const cwd = options.cwd || process.cwd();
  const report = { config: null, workflow: null, files: [], baseline: [] };
  const configPath = path.join(cwd, CONFIG_FILE);

  let config;
  if (fs.existsSync(configPath)) {
    config = loadConfig(cwd);
    report.config = "kept";
  } else {
    const files = options.files && options.files.length ? options.files : discover(cwd);
    if (files.length === 0) {
      throw new Error(
        "found no files that look like prompts or AI config. Name them: npx germline init --files prompts/system.md,config/agent.json"
      );
    }
    const name = options.system || systemName(cwd);
    config = {
      version: 1,
      log: ".germline/audit.jsonl",
      systems: [{ name, files, redact: options.redact === true }],
    };
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n");
    // The log and config belong in the repository: git history then becomes
    // a second, independent copy. The local storage cache and lock do not.
    const ignore = path.join(cwd, ".germline", ".gitignore");
    if (!fs.existsSync(ignore)) fs.writeFileSync(ignore, "storage/\n*.lock\n");
    report.config = "written";
  }
  report.files = config.systems.flatMap((s) => s.files);

  // A workflow file means nothing outside a git repository.
  report.git = git(["rev-parse", "--git-dir"], cwd) !== null;
  if (options.workflow !== false && report.git) {
    const wf = path.join(cwd, ".github", "workflows", "germline.yml");
    if (fs.existsSync(wf)) report.workflow = "kept";
    else {
      fs.mkdirSync(path.dirname(wf), { recursive: true });
      fs.writeFileSync(wf, workflow());
      report.workflow = "written";
    }
  }

  // With the workflow in place, CI owns the log: it lives on the
  // germline-audit branch, and the first run backfills one entry per past
  // commit. A local copy here would be a second, divergent log on main.
  if (report.workflow) {
    report.baseline = [];
    report.deferred = true;
    const ignore = path.join(cwd, ".germline", ".gitignore");
    const lines = fs.existsSync(ignore) ? fs.readFileSync(ignore, "utf8") : "";
    if (!/^audit\.jsonl$/m.test(lines)) fs.writeFileSync(ignore, lines + "audit.jsonl\n");
    return report;
  }
  // Backfilled commits keep their own messages; only a state git cannot
  // attribute (no history, or uncommitted files) is labelled as the baseline.
  report.baseline = trackAll({ cwd, config, baselineReason: "baseline: germline init", ...options.meta }).written;
  return report;
}

/// Commits trackAll would record next, per system, so a caller can look up
/// their approvals first (that needs the network; trackAll does not).
function pendingCommits(options = {}) {
  const cwd = options.cwd || process.cwd();
  const config = options.config || loadConfig(cwd);
  const log = openAuditLog(options.log ? path.resolve(cwd, options.log) : path.join(cwd, config.log || path.join(".germline", "audit.jsonl")));
  const shas = new Set();
  for (const system of config.systems) {
    const history = log.entries().filter((e) => e.kind === "change" && e.system === system.name);
    const last = [...history].reverse().find((e) => typeof e.commit === "string" && SHA.test(e.commit));
    if (history.length && !last) continue;
    for (const c of commitsTouching(system.files, last ? last.commit : null, cwd, options.limit || 200) || []) shas.add(c.sha);
  }
  return Array.from(shas);
}

module.exports = { init, trackAll, pendingCommits, discover, snapshot, snapshotAt, loadConfig, commitContext, ticketFrom, workflow, safePath, CONFIG_FILE };
