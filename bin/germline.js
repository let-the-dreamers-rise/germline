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
const { renderMarkdown } = require("../sdk/report");
const track = require("../sdk/track");

const path = require("path");

const DEFAULT_RPC = process.env.ZEROG_RPC || "https://evmrpc.0g.ai";

// The registry to anchor into: --registry, then GERMLINE_REGISTRY, then the
// address recorded in deployments/ for the chain the RPC reports. Null means
// plain-transaction anchors, which work everywhere but are weaker.
async function registryFor(flags, provider) {
  if (flags.registry && flags.registry !== true) return flags.registry;
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

function pins(flags) {
  return {
    logId: flags["log-id"] && flags["log-id"] !== true ? flags["log-id"] : undefined,
    anchorer: flags.anchorer && flags.anchorer !== true ? flags.anchorer.split(",") : undefined,
  };
}

async function chainCheck(log, flags) {
  const { JsonRpcProvider } = require("ethers");
  const provider = new JsonRpcProvider(DEFAULT_RPC);
  const registry = await registryFor(flags, provider);
  return log.verifyChain(provider, { ...pins(flags), registry: registry || undefined });
}

function parse(argv) {
  const [command, ...rest] = argv;
  const flags = {};
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];
    if (!arg.startsWith("--")) throw new Error("unexpected argument " + JSON.stringify(arg));
    const key = arg.slice(2);
    const next = rest[i + 1];
    if (next === undefined || next.startsWith("--")) flags[key] = true;
    else {
      flags[key] = next;
      i++;
    }
  }
  return { command, flags };
}

function readJson(file, label) {
  if (!file || file === true) return undefined;
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
  germline track  record whatever changed in the tracked files since last time

  germline record --system <name> --actor <who> --after <config.json>
                  [--before <old.json>] [--reason <text>] [--ticket <id>]
                  [--score <n>] [--baseline <n>] [--suite <name>] [--redact]
  germline verify [--chain] [--strict] [--log-id <id>] [--anchorer <0x..>]
  germline anchor [--upload] [--registry <0x..>] [--if-key]
  germline id
  germline report [--out <file.md>] [--title <text>] [--chain]
  germline log

  --log <file>   audit log to use (default .germline/audit.jsonl)

Environment: GERMLINE_ANCHOR_KEY or DEPLOYER_KEY (anchor), ZEROG_RPC (default https://evmrpc.0g.ai),
GERMLINE_ACTOR (default --actor), GERMLINE_REGISTRY (anchor registry). anchor --upload also publishes the log to
0G Storage; install @0gfoundation/0g-storage-ts-sdk for that.`;

async function main() {
  const { command, flags } = parse(process.argv.slice(2));
  let file = flags.log && flags.log !== true ? flags.log : null;
  if (!file) {
    try {
      file = track.loadConfig().log || null;
    } catch (ignored) {}
  }
  file = file || ".germline/audit.jsonl";
  const log = openAuditLog(file);

  switch (command) {
    case "record": {
      const evaluation = {};
      const score = number(flags.score, "--score");
      const base = number(flags.baseline, "--baseline");
      if (score !== undefined) evaluation.score = score;
      if (base !== undefined) evaluation.baseline = base;
      if (flags.suite && flags.suite !== true) evaluation.suite = flags.suite;
      const entry = log.record({
        system: flags.system === true ? undefined : flags.system,
        actor: flags.actor === true ? undefined : flags.actor || process.env.GERMLINE_ACTOR,
        before: readJson(flags.before, "--before"),
        after: readJson(flags.after, "--after"),
        reason: flags.reason === true ? undefined : flags.reason,
        ticket: flags.ticket === true ? undefined : flags.ticket,
        eval: Object.keys(evaluation).length ? evaluation : undefined,
        redact: flags.redact === true,
      });
      const what = entry.changes.map((c) => c.key).join(", ") || "no field changed";
      console.log("recorded #" + entry.seq + "  " + entry.system + "  " + what + "  " + entry.hash);
      return;
    }

    case "verify": {
      const result = log.verify();
      if (result.ok) console.log("ok: " + result.entries + " entries, head " + result.head);
      else {
        console.error("FAILED: " + result.problems.length + " problem(s) in " + file);
        for (const p of result.problems) console.error("  entry " + p.seq + ": " + p.reason);
        process.exitCode = 1;
      }
      for (const w of result.warnings) console.log("  warning: entry " + w.seq + ": " + w.reason);
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
      }      return;
    }

    case "init": {
      const report = track.init({
        files: flags.files && flags.files !== true ? flags.files.split(",").map((f) => f.trim()).filter(Boolean) : undefined,
        system: flags.system && flags.system !== true ? flags.system : undefined,
        redact: flags.redact === true,
        workflow: flags["no-workflow"] !== true,
      });
      console.log("germline is set up.\n");
      console.log("  tracking:  " + report.files.join(", "));
      console.log("  config:    .germline/config.json (" + report.config + ")");
      if (report.workflow) console.log("  workflow:  .github/workflows/germline.yml (" + report.workflow + ")");
      console.log("  baseline:  " + (report.baseline.length ? report.baseline.length + " system(s) recorded" : "already recorded"));
      console.log("\nNext:");
      console.log("  1. Check the file list in .germline/config.json");
      console.log("  2. git add .germline .github && git commit -m \"Track AI config with germline\" && git push");
      console.log("  3. Optional: add a funded 0G key as the repo secret GERMLINE_ANCHOR_KEY to anchor on chain");
      return;
    }

    case "track": {
      const { written } = track.trackAll({
        actor: flags.actor && flags.actor !== true ? flags.actor : undefined,
        reason: flags.reason && flags.reason !== true ? flags.reason : undefined,
        ticket: flags.ticket && flags.ticket !== true ? flags.ticket : undefined,
      });
      if (!written.length) console.log("no tracked config changed");
      for (const e of written) {
        console.log("recorded #" + e.seq + "  " + e.system + "  " + (e.changes.map((c) => c.key).join(", ") || "baseline") + "  " + e.actor);
      }
      return;
    }

    case "anchor": {
      if (flags["if-key"] && !anchorKey()) {
        console.log("no anchor key set; skipping the on-chain anchor (the log is still recorded and verified)");
        return;
      }
      const signer = signerFromEnv();
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
      let chain;
      if (flags.chain) chain = await chainCheck(log, flags);
      const markdown = renderMarkdown(log.entries(), {
        source: file,
        title: flags.title === true ? undefined : flags.title,
        anchorChecks: chain ? chain.results : undefined,
        chainWarnings: chain ? chain.warnings : undefined,
      });
      if (flags.out && flags.out !== true) {
        fs.writeFileSync(flags.out, markdown, "utf8");
        console.log("wrote " + flags.out);
      } else process.stdout.write(markdown);
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
        else console.log("#" + e.seq + "  " + e.ts + "  " + e.system + "  " + e.actor + "  " + (e.changes || []).map((c) => c.key).join(", "));
      }
      return;
    }

    case undefined:
    case "help":
    case "--help":
      console.log(HELP);
      return;

    default:
      throw new Error("unknown command " + JSON.stringify(command) + "\n\n" + HELP);
  }
}

main().catch((error) => {
  console.error("germline: " + error.message);
  process.exitCode = 1;
});
