const { expect } = require("chai");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { ethers } = require("hardhat");
const { openAuditLog } = require("../sdk/audit");
const core = require("../sdk/verify-core");

// A verifier must know which chain it read. An RPC that is on another chain
// (or lies about it) must not be able to vouch for a log, and an empty list
// of anchorers must not count as a pin.

describe("verifying against a pinned chain", function () {
  let registry, address, signer, log, logId, chainId;

  beforeEach(async function () {
    [signer] = await ethers.getSigners();
    registry = await (await ethers.getContractFactory("GermlineAnchor")).deploy();
    address = await registry.getAddress();
    chainId = Number((await ethers.provider.getNetwork()).chainId);
    let n = 0;
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "germline-pin-")), "audit.jsonl");
    log = openAuditLog(file, { clock: () => new Date(Date.now() - 60000 + n++ * 10).toISOString() });
    log.record({ system: "bot", actor: "ash", after: { model: "m", temperature: 0.2 } });
    logId = log.verify().logId;
    await log.anchor({ signer, registry: address });
  });

  it("passes when the RPC is on the pinned chain", async function () {
    const r = await core.verifyChain(log.entries(), ethers.provider, { logId, anchorer: signer.address, registry: address, chainId });
    expect(r.ok).to.equal(true);
  });

  it("fails when the RPC is on a different chain, and reads nothing from it", async function () {
    const r = await core.verifyChain(log.entries(), ethers.provider, { logId, anchorer: signer.address, registry: address, chainId: 677 });
    expect(r.ok).to.equal(false);
    expect(r.results.some((x) => x.source === "chain" && /not the pinned chain 677/.test(x.reason))).to.equal(true);
    expect(r.results.some((x) => x.source === "registry")).to.equal(false);
  });

  it("asks the node, so a provider configured with a fake static network cannot pass", async function () {
    const liar = { send: async (m, p) => (m === "eth_chainId" ? "0x" + (31337).toString(16) : ethers.provider.send(m, p)), getNetwork: async () => ({ chainId: 677n }) };
    const r = await core.verifyChain(log.entries(), liar, { logId, anchorer: signer.address, registry: address, chainId: 677 });
    expect(r.ok).to.equal(false);
  });

  it("treats an empty anchorer list as not pinned", async function () {
    const r = await core.verifyChain(log.entries(), ethers.provider, { logId, anchorer: [], registry: address, chainId });
    expect(r.warnings.some((w) => /anchorer not pinned/.test(w))).to.equal(true);
  });

  it("reports a log that was never anchored as not vouched for", async function () {
    const fresh = openAuditLog(path.join(fs.mkdtempSync(path.join(os.tmpdir(), "germline-pin-")), "audit.jsonl"));
    fresh.record({ system: "bot", actor: "ash", after: { model: "m" } });
    const r = await core.verifyChain(fresh.entries(), ethers.provider, { registry: address, chainId, anchorer: [] });
    expect(r.results.length).to.equal(0);
    expect(r.warnings.some((w) => /nothing was anchored/.test(w))).to.equal(true);
  });
});
