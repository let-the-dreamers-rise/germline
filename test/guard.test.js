const { expect } = require("chai");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { ethers, network } = require("hardhat");
const { openAuditLog } = require("../sdk/audit");

// GermlineGuard: an agent may act only under its anchored config, and only
// once that config has been public for `delay` seconds.

const DELAY = 3600;
const ID = ethers.keccak256(ethers.toUtf8Bytes("agent-log"));
const H1 = ethers.keccak256(ethers.toUtf8Bytes("h1"));
const H2 = ethers.keccak256(ethers.toUtf8Bytes("h2"));

async function wait(seconds) {
  await network.provider.send("evm_increaseTime", [seconds]);
  await network.provider.send("evm_mine");
}

describe("GermlineGuard", function () {
  let registry, guard, operator, depositor, stranger;

  beforeEach(async function () {
    [operator, depositor, stranger] = await ethers.getSigners();
    registry = await (await ethers.getContractFactory("GermlineAnchor")).deploy();
    guard = await (await ethers.getContractFactory("GermlineGuard")).deploy(await registry.getAddress(), ID, operator.address, DELAY);
  });

  it("refuses zero parameters at deployment", async function () {
    const F = await ethers.getContractFactory("GermlineGuard");
    await expect(F.deploy(ethers.ZeroAddress, ID, operator.address, DELAY)).to.be.revertedWithCustomError(guard, "ZeroParameter");
    await expect(F.deploy(await registry.getAddress(), ethers.ZeroHash, operator.address, DELAY)).to.be.revertedWithCustomError(guard, "ZeroParameter");
    await expect(F.deploy(await registry.getAddress(), ID, ethers.ZeroAddress, DELAY)).to.be.revertedWithCustomError(guard, "ZeroParameter");
    await expect(F.deploy(await registry.getAddress(), ID, operator.address, 3651 * 86400)).to.be.revertedWithCustomError(guard, "DelayTooLong");
  });

  it("blocks an agent whose log was never anchored", async function () {
    expect(await guard.settled()).to.equal(false);
    await expect(guard.check(H1)).to.be.revertedWithCustomError(guard, "NoAnchor");
  });

  it("holds a new config for the delay, then lets it act", async function () {
    await registry.anchor(ID, 1, H1, ethers.ZeroHash);
    await expect(guard.check(H1)).to.be.revertedWithCustomError(guard, "NotSettled");
    await wait(DELAY);
    expect(await guard.settled()).to.equal(true);
    await guard.check(H1);
    const [head, covered, anchoredAt, settlesAt] = await guard.current();
    expect(head).to.equal(H1);
    expect(covered).to.equal(1n);
    expect(settlesAt - anchoredAt).to.equal(BigInt(DELAY));
  });

  it("a config change pauses the agent again, and the old config stops working at once", async function () {
    await registry.anchor(ID, 1, H1, ethers.ZeroHash);
    await wait(DELAY);
    await guard.check(H1);
    await registry.anchor(ID, 2, H2, ethers.ZeroHash);
    await expect(guard.check(H1)).to.be.revertedWithCustomError(guard, "WrongHead");
    await expect(guard.check(H2)).to.be.revertedWithCustomError(guard, "NotSettled");
    await wait(DELAY);
    await guard.check(H2);
  });

  it("ignores anchors from anyone but the pinned operator", async function () {
    await registry.anchor(ID, 1, H1, ethers.ZeroHash);
    await wait(DELAY);
    // A stranger anchoring the same log id cannot reset or replace the config.
    await registry.connect(stranger).anchor(ID, 5, H2, ethers.ZeroHash);
    await guard.check(H1);
    await expect(guard.check(H2)).to.be.revertedWithCustomError(guard, "WrongHead");
  });

  describe("AgentVault example", function () {
    let vault, agent;

    beforeEach(async function () {
      agent = stranger;
      vault = await (await ethers.getContractFactory("AgentVault")).connect(depositor).deploy(await guard.getAddress(), agent.address);
      await depositor.sendTransaction({ to: await vault.getAddress(), value: ethers.parseEther("1") });
    });

    it("lets the agent pay only under a settled config, and only the agent", async function () {
      await registry.anchor(ID, 1, H1, ethers.ZeroHash);
      await expect(vault.connect(agent).pay(operator.address, 1000n, H1)).to.be.revertedWithCustomError(guard, "NotSettled");
      await wait(DELAY);
      await expect(vault.connect(operator).pay(operator.address, 1000n, H1)).to.be.revertedWithCustomError(vault, "NotAgent");
      await expect(vault.connect(agent).pay(operator.address, 1000n, H1)).to.emit(vault, "Paid").withArgs(operator.address, 1000n, H1);
    });

    it("gives the depositor the delay to leave after a config change", async function () {
      await registry.anchor(ID, 1, H1, ethers.ZeroHash);
      await wait(DELAY);
      await registry.anchor(ID, 2, H2, ethers.ZeroHash); // operator changes the prompt
      await expect(vault.connect(agent).pay(agent.address, 1000n, H2)).to.be.revertedWithCustomError(guard, "NotSettled");
      await expect(vault.connect(stranger).withdraw()).to.be.revertedWithCustomError(vault, "NotOwner");
      await vault.connect(depositor).withdraw(); // never gated
      expect(await ethers.provider.getBalance(await vault.getAddress())).to.equal(0n);
    });
  });

  it("works end to end with a real Germline log and the SDK", async function () {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "germline-guard-")), "audit.jsonl");
    let n = 0;
    const log = openAuditLog(file, { clock: () => new Date(Date.now() - 60000 + n++ * 10).toISOString() });
    log.record({ system: "trader", actor: "ash", after: { model: "m-1", maxTradeUsd: 100 }, reason: "launch" });
    const logId = log.verify().logId;
    const realGuard = await (await ethers.getContractFactory("GermlineGuard")).deploy(await registry.getAddress(), logId, operator.address, DELAY);

    await log.anchor({ signer: operator, registry: await registry.getAddress() });
    const claimed = log.lastAnchor().anchoredHead;
    await wait(DELAY);
    await realGuard.check(claimed);

    // The operator raises the trade limit; once anchored, the agent is paused.
    log.record({ system: "trader", actor: "ash", before: { model: "m-1", maxTradeUsd: 100 }, after: { model: "m-1", maxTradeUsd: 100000 } });
    await log.anchor({ signer: operator, registry: await registry.getAddress() });
    await expect(realGuard.check(claimed)).to.be.revertedWithCustomError(realGuard, "WrongHead");
    await expect(realGuard.check(log.lastAnchor().anchoredHead)).to.be.revertedWithCustomError(realGuard, "NotSettled");
  });
});
