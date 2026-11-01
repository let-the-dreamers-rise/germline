// Measures what Germline costs an agent operator, on a local Hardhat chain:
//
//   gas to deploy the anchor registry, a guard and a guarded vault
//   gas per anchor (first, and each one after)
//   gas the guard adds to every agent payment, against an unguarded vault
//   time to verify a log of N entries, offline
//
//   npx hardhat run scripts/bench-guard.js            (N defaults to 300)
//   BENCH_ENTRIES=1000 npx hardhat run scripts/bench-guard.js
//
// Gas is deterministic for these contracts, so the numbers don't depend on the
// machine. Verify time does; the script prints the Node version and CPU with it.

const fs = require("fs");
const os = require("os");
const path = require("path");
const hre = require("hardhat");
const { openAuditLog } = require("../sdk/audit");

const { ethers, network } = hre;

async function gasOf(txPromise) {
  const tx = await txPromise;
  const receipt = await tx.wait();
  return Number(receipt.gasUsed);
}

async function deployGas(name, args, signer) {
  const F = await ethers.getContractFactory(name, signer);
  const c = await F.deploy(...args);
  const receipt = await c.deploymentTransaction().wait();
  return { contract: c, gas: Number(receipt.gasUsed) };
}

function buildLog(n) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "germline-bench-"));
  const file = path.join(dir, "audit.jsonl");
  const log = openAuditLog(file, { clock: () => "2026-11-01T00:00:00.000Z" });
  let config = { model: "model-a", temperature: 0.2, maxTradeUsd: 100, prompt: "You are a careful trading agent." };
  // record() re-verifies the whole chain before each append (it refuses to
  // extend a broken log), so building is O(n^2). Only the final verify is timed.
  for (let i = 0; i < n; i++) {
    const before = config;
    config = { ...config, maxTradeUsd: 100 + i, prompt: "You are a careful trading agent. Revision " + i + "." };
    log.record({ system: "trader", actor: "bench", before, after: config, reason: "bench change " + i });
  }
  return { log, file, dir };
}

async function main() {
  if (network.name !== "hardhat") throw new Error("run this on the local hardhat network, not " + network.name);
  const [operator, depositor, agent, payee] = await ethers.getSigners();
  const DELAY = 3600;
  const logId = ethers.keccak256(ethers.toUtf8Bytes("bench-log"));
  const H1 = ethers.keccak256(ethers.toUtf8Bytes("head-1"));
  const H2 = ethers.keccak256(ethers.toUtf8Bytes("head-2"));

  const anchorDeploy = await deployGas("GermlineAnchor", [], operator);
  const registry = anchorDeploy.contract;
  const guardDeploy = await deployGas("GermlineGuard", [await registry.getAddress(), logId, operator.address, DELAY], operator);
  const guard = guardDeploy.contract;
  const vaultDeploy = await deployGas("AgentVault", [await guard.getAddress(), agent.address], depositor);
  const vault = vaultDeploy.contract;
  const plainDeploy = await deployGas("PlainVault", [agent.address], depositor);
  const plain = plainDeploy.contract;

  const firstAnchor = await gasOf(registry.connect(operator).anchor(logId, 1, H1, ethers.ZeroHash));
  await network.provider.send("evm_increaseTime", [DELAY]);
  await network.provider.send("evm_mine");

  const amount = ethers.parseEther("0.01");
  await (await depositor.sendTransaction({ to: await vault.getAddress(), value: ethers.parseEther("1") })).wait();
  await (await depositor.sendTransaction({ to: await plain.getAddress(), value: ethers.parseEther("1") })).wait();

  // Warm the payee account in both vaults so neither pays the new-account cost.
  await (await vault.connect(agent).pay(payee.address, amount, H1)).wait();
  await (await plain.connect(agent).pay(payee.address, amount, H1)).wait();
  const guardedPay = await gasOf(vault.connect(agent).pay(payee.address, amount, H1));
  const plainPay = await gasOf(plain.connect(agent).pay(payee.address, amount, H1));

  // A config change: the next anchor, and the agent is paused until it settles.
  const nextAnchor = await gasOf(registry.connect(operator).anchor(logId, 2, H2, ethers.ZeroHash));
  let pausedAfterChange = false;
  try {
    await vault.connect(agent).pay.staticCall(payee.address, amount, H2);
  } catch (e) {
    pausedAfterChange = /NotSettled/.test(String(e.message || e));
  }
  let oldConfigRejected = false;
  try {
    await vault.connect(agent).pay.staticCall(payee.address, amount, H1);
  } catch (e) {
    oldConfigRejected = /WrongHead/.test(String(e.message || e));
  }

  const n = Number(process.env.BENCH_ENTRIES || 300);
  const { log, dir } = buildLog(n);
  const runs = [];
  let result;
  for (let i = 0; i < 5; i++) {
    const t0 = process.hrtime.bigint();
    result = log.verify();
    runs.push(Number(process.hrtime.bigint() - t0) / 1e6);
  }
  runs.sort((a, b) => a - b);
  const median = runs[2];
  fs.rmSync(dir, { recursive: true, force: true });

  const out = {
    gas: {
      deployAnchorRegistry: anchorDeploy.gas,
      deployGuard: guardDeploy.gas,
      deployAgentVault: vaultDeploy.gas,
      firstAnchor,
      nextAnchor,
      paymentUnguarded: plainPay,
      paymentGuarded: guardedPay,
      guardOverheadPerPayment: guardedPay - plainPay,
    },
    behaviour: {
      configChangePausesAgent: pausedAfterChange,
      oldConfigRejectedAfterChange: oldConfigRejected,
      delaySeconds: DELAY,
    },
    verify: {
      entries: n,
      ok: result.ok,
      medianMs: Number(median.toFixed(1)),
      perEntryUs: Number(((median * 1000) / n).toFixed(1)),
      node: process.version,
      cpu: (os.cpus()[0] || {}).model || "unknown",
    },
  };
  console.log(JSON.stringify(out, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
