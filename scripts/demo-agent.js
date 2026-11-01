// The agent timelock, end to end, paced for a screen recording.
//
//   npm run demo:agent            (PACE=fast to rehearse)
//
// Runs on hardhat's in-process chain, so it needs no wallet, no network and
// no tokens. Everything is real: the contracts are the ones in contracts/,
// the log is a real Germline log, and every refusal is the contract
// reverting.
//
// The story: an AI trading agent runs out of a vault its owner funded. Its
// operator quietly raises the agent's trade limit. With Germline the change
// is public, the agent is paused, and the owner gets out before it can act.

const fs = require("fs");
const os = require("os");
const path = require("path");
const hre = require("hardhat");
const { openAuditLog } = require("../sdk/audit");

const FAST = process.env.PACE === "fast";
const DELAY = 24 * 3600; // the guard's timelock: one day
const sleep = (ms) => new Promise((r) => setTimeout(r, FAST ? 0 : ms));
const BAR = "=".repeat(68);
const short = (h) => h.slice(0, 10) + "…";
const eth = (wei) => hre.ethers.formatEther(wei) + " ETH";

async function beat(title) {
  console.log("\n" + BAR + "\n  " + title + "\n" + BAR + "\n");
  await sleep(1400);
}
async function say(text, ms = 900) {
  console.log(text);
  await sleep(ms);
}
async function advance(seconds) {
  await hre.network.provider.send("evm_increaseTime", [seconds]);
  await hre.network.provider.send("evm_mine");
}
async function attempt(label, fn) {
  try {
    await fn();
    await say("  " + label + ": OK");
    return true;
  } catch (error) {
    const reason = (error.message.match(/reverted with custom error '([A-Za-z]+)/) || [])[1] || error.shortMessage || error.message;
    await say("  " + label + ": REFUSED by the contract (" + reason + ")");
    return false;
  }
}

async function main() {
  const { ethers } = hre;
  const [operator, owner, agent, exchange] = await ethers.getSigners();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "germline-agent-demo-"));
  let tick = 0;
  // Entries dated by the chain's clock, so the anchors' block times line up.
  const chainNow = async () => Number((await ethers.provider.getBlock("latest")).timestamp) * 1000;
  let clockBase = await chainNow();
  const log = openAuditLog(path.join(dir, "audit.jsonl"), { clock: () => new Date(clockBase + tick++).toISOString() });

  await beat("1. An AI trading agent, and the config that defines it");
  const v1 = { model: "open-model-35b", prompt: "Rebalance into stablecoins when volatility is high.", maxTradeUsd: 100, allowedVenues: ["dex-a"] };
  await say("  " + JSON.stringify(v1));
  log.record({ system: "trader", actor: "github:operator", after: v1, reason: "launch", ticket: "#1" });
  const registry = await (await ethers.getContractFactory("GermlineAnchor")).deploy();
  const logId = log.verify().logId;
  const guard = await (await ethers.getContractFactory("GermlineGuard")).deploy(await registry.getAddress(), logId, operator.address, DELAY);
  await say("\n  Germline records it, and the operator anchors the log on chain.");
  await log.anchor({ signer: operator, registry: await registry.getAddress() });
  let head = log.lastAnchor().anchoredHead;
  await say("  anchored head " + short(head) + "  (log id " + short(logId) + ")");
  await say("  GermlineGuard pins that log and operator, with a " + DELAY / 3600 + "-hour timelock.");

  await beat("2. The owner funds a vault the agent trades from");
  const vault = await (await ethers.getContractFactory("AgentVault")).connect(owner).deploy(await guard.getAddress(), agent.address);
  await owner.sendTransaction({ to: await vault.getAddress(), value: ethers.parseEther("10") });
  await say("  vault balance " + eth(await ethers.provider.getBalance(await vault.getAddress())));
  await advance(DELAY);
  clockBase = await chainNow();
  await say("  A day later, config v1 has settled. The agent trades:");
  await attempt("agent pays 0.1 ETH under config " + short(head), () => vault.connect(agent).pay(exchange.address, ethers.parseEther("0.1"), head));

  await beat("3. The operator quietly raises the trade limit");
  const v2 = { ...v1, maxTradeUsd: 100000, allowedVenues: ["dex-a", "new-venue-x"] };
  log.record({ system: "trader", actor: "github:operator", before: v1, after: v2, reason: "tune for volume" });
  const change = log.lastChange("trader");
  for (const c of change.changes) await say("  " + c.key + ": " + JSON.stringify(c.from) + " → " + JSON.stringify(c.to), 700);
  await log.anchor({ signer: operator, registry: await registry.getAddress() });
  const newHead = log.lastAnchor().anchoredHead;
  await say("\n  Anchored as head " + short(newHead) + " It's public now, and can't be edited or hidden.");

  await beat("4. The guard pauses the agent");
  await attempt("agent pays 5 ETH under the OLD config", () => vault.connect(agent).pay(exchange.address, ethers.parseEther("5"), head));
  await attempt("agent pays 5 ETH under the NEW config", () => vault.connect(agent).pay(exchange.address, ethers.parseEther("5"), newHead));
  const [, , , settlesAt] = await guard.current();
  await say("  The new config takes effect at " + new Date(Number(settlesAt) * 1000).toISOString() + ".");

  await beat("5. The owner reads the change and leaves");
  await say("  germline verify: " + (log.verify().ok ? "OK, the history is intact" : "FAILED"));
  await attempt("owner withdraws", () => vault.connect(owner).withdraw());
  await say("  vault balance " + eth(await ethers.provider.getBalance(await vault.getAddress())));

  await beat("6. And if someone rewrites history instead?");
  const lines = fs.readFileSync(log.file, "utf8").trim().split("\n");
  const forged = JSON.parse(lines[2]);
  forged.changes = forged.changes.filter((c) => c.key !== "maxTradeUsd");
  lines[2] = JSON.stringify(forged);
  fs.writeFileSync(log.file, lines.join("\n") + "\n");
  await say("  Someone deletes the limit change from the log file.");
  const check = await log.verifyChain(ethers.provider, { logId, anchorer: operator.address, registry: await registry.getAddress() });
  await say("  germline verify --chain: " + (check.ok ? "OK" : "FAILED"));
  const problem = openAuditLog(log.file).verify().problems[0];
  if (problem) await say("    entry " + problem.seq + ": " + problem.reason);

  await say("\nAn agent's instructions, made public, permanent, and enforceable on 0G.");
  await say("github.com/let-the-dreamers-rise/germline · docs/AGENTS.md", 0);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
