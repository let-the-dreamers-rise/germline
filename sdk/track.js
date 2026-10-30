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
const { openAuditLog } = require("./audit");

const CONFIG_FILE = path.join(".germline", "config.json");

// What a file holding AI behaviour tends to be called. Deliberately loose:
// init shows what it found and the team edits the list, which is faster than
// asking them to type paths from memory.
const NAME_HINT = /(prompt|system[-_.]?message|instruction|persona|agent|assistant|llm|model[-_.]?config|ai[-_.]?config|guardrail|rubric|eval)/i;
const EXT = /\.(json|ya?ml|md|txt|prompt|jinja2?|j2|hbs|mustache|toml)$/i;
const SKIP_DIR = /(^|\/)(node_modules|\.git|\.germline|dist|build|out|coverage|vendor|\.next|\.venv|venv|__pycache__|artifacts|cache)(\/|$)/;
const SKIP_FILE = /(^|\/)(package(-lock)?\.json|yarn\.lock|pnpm-lock\.yaml|tsconfig.*\.json|\.eslintrc.*|CHANGELOG\.md|LICENSE.*|README.*)$/i;

function git(args, cwd) {
  try {
    return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch (error) {
    return null;
  }
}

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
    const full = path.join(cwd, file);
    if (!fs.existsSync(full)) {
      state[file] = null;
      continue;
    }
    const text = fs.readFileSync(full, "utf8");
    if (/\.json$/i.test(file)) {
      try {
        state[file] = JSON.parse(text);
        continue;
      } catch (ignored) {
        // An unparseable JSON file is still a file whose content changed.
      }
    }
    state[file] = text;
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

/// Who, why and which commit, from whatever CI or git can tell us.
function commitContext(cwd = process.cwd()) {
  const env = process.env;
  const sha = env.GITHUB_SHA || env.CI_COMMIT_SHA || git(["rev-parse", "HEAD"], cwd);
  const subject = git(["log", "-1", "--pretty=%s"], cwd);
  const repo = env.GITHUB_REPOSITORY || null;
  return {
    reason: subject || null,
    ticket: sha ? (repo ? repo + "@" + sha.slice(0, 12) : sha.slice(0, 12)) : null,
  };
}

/// Record every tracked system whose files changed since the log last saw
/// them. Returns the entries written; an empty array means nothing changed.
function trackAll(options = {}) {
  const cwd = options.cwd || process.cwd();
  const config = options.config || loadConfig(cwd);
  const log = openAuditLog(path.join(cwd, config.log || path.join(".germline", "audit.jsonl")));
  const context = commitContext(cwd);
  const written = [];
  for (const system of config.systems) {
    const entry = log.track(system.name, snapshot(system.files, cwd), {
      actor: options.actor,
      reason: options.reason || context.reason,
      ticket: options.ticket || context.ticket,
      redact: system.redact === true,
      eval: options.eval,
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
  contents: write

jobs:
  audit:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: let-the-dreamers-rise/germline@main
        with:
          # Optional. Without it, changes are still recorded and verified;
          # they are just not anchored on chain until you add a key.
          anchor-key: \${{ secrets.GERMLINE_ANCHOR_KEY }}
`;
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
    const name = options.system || path.basename(path.resolve(cwd));
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

  if (options.workflow !== false) {
    const wf = path.join(cwd, ".github", "workflows", "germline.yml");
    if (fs.existsSync(wf)) report.workflow = "kept";
    else {
      fs.mkdirSync(path.dirname(wf), { recursive: true });
      fs.writeFileSync(wf, workflow());
      report.workflow = "written";
    }
  }

  report.baseline = trackAll({ cwd, config, reason: "baseline: germline init", ...options.meta }).written;
  return report;
}

module.exports = { init, trackAll, discover, snapshot, loadConfig, commitContext, workflow, CONFIG_FILE };
