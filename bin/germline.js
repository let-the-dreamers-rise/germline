#!/usr/bin/env node
"use strict";

// germline: record, verify, anchor and report AI configuration changes.
//
//   germline init                      set a repo up in one command
//   germline track                     record what changed in tracked files
//   germline record --system support-agent --actor ash --after config.json \
//                   [--before old.json] [--reason "..."] [--ticket JIRA-12] \
//                   [--score 0.91] [--baseline 0.84] [--suite refunds-v4] [--redact]
//   germline verify [--chain] [--log-id 0x..] [--anchorer 0x..] [--registry 0x..]
//                                      exit 1 if the log has been tampered with
//   germline anchor [--upload] [--registry 0x..]
//                                      pin the head on 0G Chain (needs DEPLOYER_KEY)
//   germline id                        the log id to give auditors
//   germline report [--out file.md]    the evidence pack, as Markdown
//   germline log                       one line per entry
//
// Every command takes --log <file>, default .germline/audit.jsonl. The CLI is
// meant to sit in CI: record on every merge that touches a config, verify on
// every build, anchor on a schedule.

const fs = require("fs");
const { openAuditLog } = require("../sdk/audit");
const { renderMarkdown, renderJson, renderCsv } = require("../sdk/report");
const track = require("../sdk/track");

const path = require("path");

const DEFAULT_RPC = process.env.ZEROG_RPC || "https://evmrpc.0g.ai";

// The registry to anchor into: --registry, then GERMLINE_REGISTRY, then the
// address recorded in deployments/ for the chain the RPC reports. Null means
// plain-transaction anchors, which work everywhere but are weaker.
async function registryFor(flags, provider) {
  if (flags.registry) return flags.registry;
  if (process.env.GERMLINE_REGISTRY) return process.env.GERMLINE_REGISTRY;
  const { chainId } = await provider.getNetwork();
  const dir = path.join(__dirname, "..", "deployments");
  try {
    for (const name of fs.readdirSync(dir)) {
      if (!name.endsWith("-anchor.json")) continue;
      const record = JSON.parse(fs.readFileSync(path.join(dir, name), "utf8"));
      if (Number(record.chainId) === Number(chainId) && record.address) return record.address;
    }
  } catch (ignored) {}
  return null;
}

const HEX = (bytes) => new RegExp("^0x[0-9a-fA-F]{" + bytes * 2 + "}$");

function pins(flags) {
  const logId = flags["log-id"];
  const anchorer = flags.anchorer ? flags.anchorer.split(",").map((a) => a.trim()) : undefined;
  if (logId !== undefined && !HEX(32).test(logId)) throw new Error("--log-id must be a 0x-prefixed 32-byte hex id");
  for (const a of anchorer || []) if (!HEX(20).test(a)) throw new Error("--anchorer must be 0x-prefixed addresses, got " + JSON.stringify(a));
  if (flags.registry !== undefined && !HEX(20).test(flags.registry)) throw new Error("--registry must be a 0x-prefixed address");
  return { logId, anchorer };
}

async function chainCheck(log, flags) {
  const { JsonRpcProvider } = require("ethers");
  const provider = new JsonRpcProvider(DEFAULT_RPC);
  const registry = await registryFor(flags, provider);
  return log.verifyChain(provider, { ...pins(flags), registry: registry || undefined });
}

// Which flags each command takes, and whether each takes a value. Anything
// else is an error: a mistyped --anchorer that is silently ignored turns a
// pinned check into an unpinned one, which is the failure an auditor never sees.
const VALUE = "value";
const BOOL = "bool";
const COMMON = { log: VALUE };
const EVAL = { score: VALUE, baseline: VALUE, suite: VALUE, "eval-file": VALUE };
const PINS = { "log-id": VALUE, anchorer: VALUE, registry: VALUE };
const SPEC = {
  record: { ...COMMON, ...EVAL, system: VALUE, actor: VALUE, before: VALUE, after: VALUE, reason: VALUE, ticket: VALUE, redact: BOOL },
  track: { ...COMMON, ...EVAL, actor: VALUE, reason: VALUE, ticket: VALUE },
  verify: { ...COMMON, ...PINS, chain: BOOL, strict: BOOL },
  anchor: { ...COMMON, registry: VALUE, upload: BOOL, "if-key": BOOL, "allow-public": BOOL },
  report: { ...COMMON, ...PINS, out: VALUE, title: VALUE, chain: BOOL, format: VALUE },
  init: { files: VALUE, system: VALUE, redact: BOOL, "no-workflow": BOOL },
  demo: { fast: BOOL },
  id: COMMON,
  log: COMMON,
  path: COMMON,
};

function parse(argv) {
  const [command, ...rest] = argv;
  const spec = SPEC[command] || {};
  const flags = {};
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];
    if (!arg.startsWith("--")) throw new Error("unexpected argument " + JSON.stringify(arg));
    let key = arg.slice(2);
    let value;
    const eq = key.indexOf("=");
    if (eq >= 0) {
      value = key.slice(eq + 1);
      key = key.slice(0, eq);
    }
    const kind = spec[key];
    if (!kind) {
      throw new Error("unknown option --" + key + (SPEC[command] ? " for `germline " + command + "`" : "") + ". See `germline help`.");
    }
    if (kind === BOOL) {
      if (value !== undefined) throw new Error("--" + key + " takes no value");
      flags[key] = true;
      continue;
    }
    if (value === undefined) {
      // A value flag takes the next argument whatever it looks like, so
      // --reason "--force-pushed hotfix" records that reason.
      if (i + 1 >= rest.length) throw new Error("--" + key + " needs a value");
      value = rest[++i];
    }
    // An empty value is usually an unset variable ($ANCHORER). Treating it
    // as "not given" would silently drop a pin.
    if (value === "") throw new Error("--" + key + " is empty");
    flags[key] = value;
  }
  return { command, flags };
}

// Log values printed to a terminal or CI log: no control characters, so a
// key or actor cannot inject ANSI codes or GitHub "::" workflow commands.
function plain(text) {
  return String(text).replace(/[\u0000-\u001f\u007f-\u009f]/g, " ").replace(/^::/, ": :");
}

function evaluationFrom(flags) {
  const evaluation = flags["eval-file"] ? readJson(flags["eval-file"], "--eval-file") : {};
  if (evaluation === null || typeof evaluation !== "object" || Array.isArray(evaluation)) {
    throw new Error("--eval-file must hold a JSON object, e.g. {\"score\": 0.91, \"suite\": \"refunds-v4\"}");
  }
  const score = number(flags.score, "--score");
  const base = number(flags.baseline, "--baseline");
  if (score !== undefined) evaluation.score = score;
  if (base !== undefined) evaluation.baseline = base;
  if (flags.suite) evaluation.suite = flags.suite;
  return Object.keys(evaluation).length ? evaluation : undefined;
}

function readJson(file, label) {
  if (!file) return undefined;
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (error) {
    throw new Error("cannot read " + label + " from " + file + ": " + error.message);
  }
}

function number(value, label) {
  if (value === undefined) return undefined;
  const n = Number(value);
  if (!Number.isFinite(n)) throw new Error(label + " must be a number, got " + JSON.stringify(value));
  return n;
}

function anchorKey() {
  return process.env.GERMLINE_ANCHOR_KEY || process.env.DEPLOYER_KEY || null;
}

function signerFromEnv() {
  const key = anchorKey();
  if (!key) throw new Error("set GERMLINE_ANCHOR_KEY (or DEPLOYER_KEY) to a funded 0G key to anchor; an anchor is an on-chain transaction");
  const { JsonRpcProvider, Wallet } = require("ethers");
  return new Wallet(key, new JsonRpcProvider(DEFAULT_RPC));
}

const HELP = `germline -- a tamper-evident audit trail for AI configuration changes

  germline init [--files a.md,b.json] [--system <name>] [--redact] [--no-workflow]
                  find your prompt and config files, write the CI workflow, record a baseline
  germline track [--score <n>] [--baseline <n>] [--suite <name>] [--eval-file <eval.json>]
                  record whatever changed in the tracked files, one entry per commit
  germline demo   one-minute walkthrough: record, verify, tamper, catch it

  germline record --system <name> --actor <who> --after <config.json>
                  [--before <old.json>] [--reason <text>] [--ticket <id>]
                  [--score <n>] [--baseline <n>] [--suite <name>] [--eval-file <f>] [--redact]
  germline verify [--log-id <id>] [--chain [--anchorer <0x..>] [--registry <0x..>]] [--strict]
                  --strict fails on any warning, including "never anchored"
  germline anchor [--upload [--allow-public]] [--registry <0x..>] [--if-key]
  germline id     the log id to keep somewhere other than the log
  germline report [--format md|json|csv] [--out <file>] [--title <text>] [--chain [pins]]
  germline log
  germline --version

  --log <file>   audit log to use (default .germline/audit.jsonl)

Environment: GERMLINE_ANCHOR_KEY or DEPLOYER_KEY (anchor), ZEROG_RPC (default https://evmrpc.0g.ai),
GERMLINE_ACTOR (default --actor), GERMLINE_REGISTRY (anchor registry). anchor --upload also publishes the log to
0G Storage; install @0gfoundation/0g-storage-ts-sdk for that.`;

async function main() {
  const { command, flags } = parse(process.argv.slice(2));
  let file = flags.log || null;
  if (!file) {
    try {
      file = track.loadConfig().log || null;
    } catch (ignored) {}
  }
  file = file || ".germline/audit.jsonl";
  const log = openAuditLog(file);

  switch (command) {
    case "record": {
      const entry = log.record({
        system: flags.system,
        actor: flags.actor || process.env.GERMLINE_ACTOR,
        before: readJson(flags.before, "--before"),
        after: readJson(flags.after, "--after"),
        reason: flags.reason,
        ticket: flags.ticket,
        eval: evaluationFrom(flags),
        redact: flags.redact === true,
      });
      const what = entry.changes.map((c) => c.key).join(", ") || "no field changed";
      console.log(plain("recorded #" + entry.seq + "  " + entry.system + "  " + what + "  " + entry.hash));
      return;
    }

    case "verify": {
      const pinned = pins(flags);
      if ((flags.anchorer || flags.registry) && !flags.chain) {
        throw new Error("--anchorer and --registry are checked against the chain: add --chain");
      }
      const result = log.verify();
      if (result.ok) console.log("ok: " + result.entries + " entries, head " + result.head);
      else {
        console.error("FAILED: " + result.problems.length + " problem(s) in " + file);
        for (const p of result.problems) console.error("  entry " + p.seq + ": " + p.reason);
        process.exitCode = 1;
      }
      for (const w of result.warnings) console.log("  warning: entry " + w.seq + ": " + w.reason);
      // The log id pin needs no chain: it is the hash of the first entry.
      if (pinned.logId && String(result.logId).toLowerCase() !== pinned.logId.toLowerCase()) {
        console.error("FAILED: this log's id is " + result.logId + ", not the " + pinned.logId + " you pinned (it was rewritten or is a different log)");
        process.exitCode = 1;
      }
      if (flags.chain) {
        const chain = await chainCheck(log, flags);
        console.log("log id: " + chain.logId);
        for (const r of chain.results) {
          const label = r.source === "registry" ? "registry anchor #" + r.index : r.source === "tx" ? "tx anchor " + r.txHash : "pin";
          console.log((r.ok ? "  ok      " : "  FAILED  ") + label + (r.entries ? " (" + r.entries + " entries)" : "") + (r.reason ? "  " + r.reason : ""));
          if (!r.ok) process.exitCode = 1;
        }
        for (const w of chain.warnings) console.log("  warning: " + w);
        if (flags.strict && chain.warnings.length) process.exitCode = 1;
      } else if (result.ok) {
        // Offline, only the hash chain is checked. Say what that does not cover.
        const anchored = log.entries().some((e) => e.kind === "anchor");
        const why = anchored
          ? "anchors not checked: add --chain to check them against 0G"
          : "never anchored: whoever holds this file could rewrite all of it consistently";
        console.log("  warning: " + why);
        if (flags.strict) process.exitCode = 1;
      }
      return;
    }

    case "demo": {
      const { demo } = require("../sdk/demo");
      const result = demo({ delay: flags.fast ? 0 : 600 });
      if (!result.detected) process.exitCode = 1;
      return;
    }

    case "init": {
      const report = track.init({
        files: flags.files ? flags.files.split(",").map((f) => f.trim()).filter(Boolean) : undefined,
        system: flags.system,
        redact: flags.redact === true,
        workflow: flags["no-workflow"] !== true,
      });
      console.log("germline is set up.\n");
      console.log("  tracking:  " + report.files.join(", "));
      console.log("  config:    .germline/config.json (" + report.config + ")");
      if (report.workflow) console.log("  workflow:  .github/workflows/germline.yml (" + report.workflow + ")");
      else if (!report.git) console.log("  workflow:  skipped (not a git repository; run init again after git init)");
      if (report.deferred) {
        console.log("  history:   the first CI run records one entry per past commit, on the germline-audit branch");
      } else {
        console.log("  baseline:  " + (report.baseline.length ? report.baseline.length + " entr" + (report.baseline.length === 1 ? "y" : "ies") + " recorded" : "already recorded"));
      }
      console.log("\nNext:");
      console.log("  1. Check the file list in .germline/config.json (npx germline track --log /tmp/preview.jsonl previews it)");
      console.log("  2. git add .germline .github && git commit -m \"Track AI config with germline\" && git push");
      console.log("  3. Optional: add a funded 0G key as the repo secret GERMLINE_ANCHOR_KEY to anchor on chain");
      console.log("  4. After the first run: npx germline id --log <the log>, and give that ID to your auditor out of band");
      return;
    }

    case "track": {
      // In GitHub Actions, look up who approved each new commit's pull
      // request before recording, so the approval is part of the entry.
      let approvals;
      if (process.env.GITHUB_ACTIONS === "true" && process.env.GITHUB_TOKEN) {
        const { approvalsFor } = require("../sdk/github");
        approvals = await approvalsFor(track.pendingCommits({ log: flags.log }), {
          onError: (sha, error) => console.log("  note: no approval found for " + sha.slice(0, 10) + ": " + error.message),
        });
      }
      const { written } = track.trackAll({
        log: flags.log,
        approvals,
        actor: flags.actor,
        reason: flags.reason,
        ticket: flags.ticket,
        eval: evaluationFrom(flags),
      });
      if (!written.length) console.log("no tracked config changed");
      for (const e of written) {
        const approved = e.approval && e.approval.approvedBy.length ? "  approved by " + e.approval.approvedBy.join(", ") : "";
        console.log(plain("recorded #" + e.seq + "  " + e.system + "  " + (e.changes.map((c) => c.key).join(", ") || "baseline") + "  " + e.actor + approved));
      }
      return;
    }

    case "path": {
      console.log(file);
      return;
    }

    case "anchor": {
      if (flags["if-key"] && !anchorKey()) {
        console.log("no anchor key set; skipping the on-chain anchor (the log is still recorded and verified)");
        return;
      }
      // 0G Storage is public and permanent. Refuse to publish prompts and
      // settings in the clear unless the caller says that is intended.
      if (flags.upload && !flags["allow-public"]) {
        const clear = log.entries().filter((e) => e.kind === "change" && !e.redacted && e.after !== undefined);
        if (clear.length) {
          throw new Error(
            clear.length + " entr" + (clear.length === 1 ? "y holds" : "ies hold") + " unredacted config, and 0G Storage is public. " +
              'Set "redact": true for the system in .germline/config.json (applies to new entries), or pass --allow-public if publishing it is intended.'
          );
        }
      }
      const signer = signerFromEnv();
      if (flags.registry) pins(flags);
      const registry = await registryFor(flags, signer.provider);
      const entry = await log.anchor({ signer, upload: flags.upload === true, registry: registry || undefined });
      console.log("anchored " + entry.anchoredEntries + " entries, head " + entry.anchoredHead);
      console.log("  mode:    " + (entry.mode === "registry" ? "registry " + entry.registry + " #" + entry.index : "plain transaction (no registry on this chain; weaker, see docs/AUDIT.md)"));
      console.log("  log id:  " + entry.logId + "  anchorer " + entry.anchorer);
      console.log("  tx:      " + entry.txHash + "  (chain " + entry.chainId + ", block " + entry.block + ")");
      if (entry.storage) {
        console.log("  storage: " + entry.storage.stored + "  " + (entry.storage.storageRoot || entry.storage.uri));
      }
      return;
    }

    case "report": {
      const format = flags.format || (flags.out && /\.json$/i.test(flags.out) ? "json" : flags.out && /\.csv$/i.test(flags.out) ? "csv" : "md");
      if (!["md", "json", "csv"].includes(format)) throw new Error("--format must be md, json or csv");
      const pinned = pins(flags);
      if ((flags.anchorer || flags.registry) && !flags.chain) {
        throw new Error("--anchorer and --registry are checked against the chain: add --chain");
      }
      let chain;
      if (flags.chain) chain = await chainCheck(log, flags);
      const options = {
        source: file,
        title: flags.title,
        pins: pinned,
        anchorChecks: chain ? chain.results : undefined,
        chainWarnings: chain ? chain.warnings : undefined,
      };
      const text = format === "json" ? renderJson(log.entries(), options) : format === "csv" ? renderCsv(log.entries()) : renderMarkdown(log.entries(), options);
      if (flags.out) {
        fs.writeFileSync(flags.out, text, "utf8");
        console.log("wrote " + flags.out);
      } else process.stdout.write(text);
      return;
    }

    case "id": {
      const result = log.verify();
      if (!result.logId) throw new Error("the log is empty, so it has no id yet");
      console.log(result.logId);
      return;
    }

    case "log": {
      for (const e of log.entries()) {
        if (e.kind === "anchor") console.log("#" + e.seq + "  " + e.ts + "  ANCHOR  " + e.anchoredEntries + " entries  " + e.txHash);
        else console.log(plain("#" + e.seq + "  " + e.ts + "  " + e.system + "  " + e.actor + "  " + (e.changes || []).map((c) => c.key).join(", ")));
      }
      return;
    }

    case "--version":
    case "-v":
    case "version":
      console.log(require("../package.json").version);
      return;

    case undefined:
    case "help":
    case "--help":
      console.log(HELP);
      return;

    default:
      throw new Error("unknown command " + JSON.stringify(command) + "\n\n" + HELP);
  }
}

// Network failures from ethers are long and cryptic. Say what to check.
function friendly(error) {
  const code = error && (error.code || (error.error && error.error.code));
  const text = String((error && (error.shortMessage || error.message)) || error);
  if (/ENOTFOUND|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|NETWORK_ERROR|failed to detect network|fetch failed/i.test(text + " " + code)) {
    return "cannot reach the 0G RPC at " + DEFAULT_RPC + ". Check your connection, or set ZEROG_RPC to another endpoint. (" + text.slice(0, 120) + ")";
  }
  if (code === "INSUFFICIENT_FUNDS" || /insufficient funds/i.test(text)) {
    return "the anchor key has no 0G to pay for the transaction. Fund its address and try again.";
  }
  if (/NotAppendOnly/.test(text)) {
    return "the registry already holds a longer anchor for this log from this key. An anchor can only move forward; see SECURITY.md (leaked keys).";
  }
  return text;
}

main().catch((error) => {
  console.error("germline: " + friendly(error));
  process.exitCode = 1;
});
