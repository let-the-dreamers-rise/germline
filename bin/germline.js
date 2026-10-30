#!/usr/bin/env node
"use strict";

// germline: record, verify, anchor and report AI configuration changes.
//
//   germline record --system support-agent --actor ash --after config.json \
//                   [--before old.json] [--reason "..."] [--ticket JIRA-12] \
//                   [--score 0.91] [--baseline 0.84] [--suite refunds-v4] [--redact]
//   germline verify [--chain]          exit 1 if the log has been tampered with
//   germline anchor [--upload]         pin the head on 0G Chain (needs DEPLOYER_KEY)
//   germline report [--out file.md]    the evidence pack, as Markdown
//   germline log                       one line per entry
//
// Every command takes --log <file>, default .germline/audit.jsonl. The CLI is
// meant to sit in CI: record on every merge that touches a config, verify on
// every build, anchor on a schedule.

const fs = require("fs");
const { openAuditLog } = require("../sdk/audit");
const { renderMarkdown } = require("../sdk/report");

const DEFAULT_RPC = process.env.ZEROG_RPC || "https://evmrpc.0g.ai";

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

function signerFromEnv() {
  const key = process.env.DEPLOYER_KEY;
  if (!key) throw new Error("set DEPLOYER_KEY to a funded 0G key to anchor; an anchor is an on-chain transaction");
  const { JsonRpcProvider, Wallet } = require("ethers");
  return new Wallet(key, new JsonRpcProvider(DEFAULT_RPC));
}

const HELP = `germline -- a tamper-evident audit trail for AI configuration changes

  germline record --system <name> --actor <who> --after <config.json>
                  [--before <old.json>] [--reason <text>] [--ticket <id>]
                  [--score <n>] [--baseline <n>] [--suite <name>] [--redact]
  germline verify [--chain]
  germline anchor [--upload]
  germline report [--out <file.md>] [--title <text>] [--chain]
  germline log

  --log <file>   audit log to use (default .germline/audit.jsonl)

Environment: DEPLOYER_KEY (anchor), ZEROG_RPC (default https://evmrpc.0g.ai),
GERMLINE_ACTOR (default --actor). anchor --upload also publishes the log to
0G Storage; install @0gfoundation/0g-storage-ts-sdk for that.`;

async function main() {
  const { command, flags } = parse(process.argv.slice(2));
  const file = flags.log && flags.log !== true ? flags.log : ".germline/audit.jsonl";
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
      if (flags.chain) {
        const { JsonRpcProvider } = require("ethers");
        const anchors = await log.verifyAnchors(new JsonRpcProvider(DEFAULT_RPC));
        if (!anchors.length) console.log("no anchors to check");
        for (const a of anchors) {
          console.log((a.ok ? "  anchor ok     " : "  anchor FAILED ") + "#" + a.seq + "  " + a.txHash + (a.reason ? "  " + a.reason : ""));
          if (!a.ok) process.exitCode = 1;
        }
      }
      return;
    }

    case "anchor": {
      const entry = await log.anchor({ signer: signerFromEnv(), upload: flags.upload === true });
      console.log("anchored " + entry.anchoredEntries + " entries, head " + entry.anchoredHead);
      console.log("  tx:      " + entry.txHash + "  (chain " + entry.chainId + ", block " + entry.block + ")");
      if (entry.storage) {
        console.log("  storage: " + entry.storage.stored + "  " + (entry.storage.storageRoot || entry.storage.uri));
      }
      return;
    }

    case "report": {
      let anchorChecks;
      if (flags.chain) {
        const { JsonRpcProvider } = require("ethers");
        anchorChecks = await log.verifyAnchors(new JsonRpcProvider(DEFAULT_RPC));
      }
      const markdown = renderMarkdown(log.entries(), {
        source: file,
        title: flags.title === true ? undefined : flags.title,
        anchorChecks,
      });
      if (flags.out && flags.out !== true) {
        fs.writeFileSync(flags.out, markdown, "utf8");
        console.log("wrote " + flags.out);
      } else process.stdout.write(markdown);
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
