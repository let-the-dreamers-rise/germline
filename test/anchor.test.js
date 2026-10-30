const { expect } = require("chai");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFile } = require("child_process");
const { ethers } = require("hardhat");
const { openAuditLog } = require("../sdk/audit");

// The registry and the SDK against a real EVM. Each test is an attack a
// forger with full control of the log file could try, and what catches it.

function tempLog() {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), "germline-anchor-")), "audit.jsonl");
}

// Entries written "now" by the chain's clock, so timestamps line up with the
// blocks that anchor them.
function chainClock() {
  let n = 0;
  return () => new Date(Date.now() - 60000 + n++ * 10).toISOString();
}

const A = { model: "m-1", temperature: 0.7 };
const B = { model: "m-1", temperature: 0.2 };
const ID = ethers.keccak256(ethers.toUtf8Bytes("log"));
const H1 = ethers.keccak256(ethers.toUtf8Bytes("h1"));
const H2 = ethers.keccak256(ethers.toUtf8Bytes("h2"));

describe("GermlineAnchor", function () {
  let registry, address, alice, mallory;

  beforeEach(async function () {
    [alice, mallory] = await ethers.getSigners();
    registry = await (await ethers.getContractFactory("GermlineAnchor")).deploy();
    address = await registry.getAddress();
  });

  describe("contract", function () {
    it("keeps every anchor, in order, and pages through them", async function () {
      await registry.anchor(ID, 1, H1, ethers.ZeroHash);
      await registry.anchor(ID, 3, H2, H1);
      expect(await registry.anchorCount(ID, alice.address)).to.equal(2n);
      const page = await registry.anchorsOf(ID, alice.address, 0, 10);
      expect(page.map((a) => Number(a.covered))).to.deep.equal([1, 3]);
      expect(page[1].storageRoot).to.equal(H1);
      expect(await registry.anchorsOf(ID, alice.address, 5, 10)).to.have.length(0);
      expect((await registry.latest(ID, alice.address)).head).to.equal(H2);
    });

    it("is append-only per log and anchorer", async function () {
      await registry.anchor(ID, 3, H1, ethers.ZeroHash);
      await expect(registry.anchor(ID, 3, H2, ethers.ZeroHash)).to.be.revertedWithCustomError(registry, "NotAppendOnly");
      await expect(registry.anchor(ID, 2, H2, ethers.ZeroHash)).to.be.revertedWithCustomError(registry, "NotAppendOnly");
    });

    it("cannot be written into by another sender", async function () {
      await registry.anchor(ID, 3, H1, ethers.ZeroHash);
      await registry.connect(mallory).anchor(ID, 1, H2, ethers.ZeroHash);
      expect(await registry.anchorCount(ID, alice.address)).to.equal(1n);
      expect((await registry.latest(ID, alice.address)).head).to.equal(H1);
    });

    it("rejects empty anchors", async function () {
      await expect(registry.anchor(ethers.ZeroHash, 1, H1, ethers.ZeroHash)).to.be.revertedWithCustomError(registry, "EmptyAnchor");
      await expect(registry.anchor(ID, 0, H1, ethers.ZeroHash)).to.be.revertedWithCustomError(registry, "EmptyAnchor");
      await expect(registry.anchor(ID, 1, ethers.ZeroHash, ethers.ZeroHash)).to.be.revertedWithCustomError(registry, "EmptyAnchor");
    });
  });

  describe("audit log against the registry", function () {
    async function anchoredLog() {
      const file = tempLog();
      const log = openAuditLog(file, { clock: chainClock() });
      log.record({ system: "bot", actor: "ash", before: A, after: B, reason: "original" });
      log.record({ system: "bot", actor: "ash", before: B, after: A });
      const entry = await log.anchor({ signer: alice, registry: address });
      return { file, log, entry, logId: log.verify().logId };
    }

    it("anchors into the registry and verifies with pins", async function () {
      const { log, entry, logId } = await anchoredLog();
      expect(entry).to.include({ mode: "registry", index: 0, anchoredEntries: 2, registry: address });
      const result = await log.verifyChain(ethers.provider, { logId, anchorer: alice.address, registry: address });
      expect(result.ok).to.equal(true);
      expect(result.warnings).to.deep.equal([]);
      expect(result.results).to.have.length(1);
    });

    it("warns, rather than passes silently, when nothing is pinned", async function () {
      const { log } = await anchoredLog();
      const result = await log.verifyChain(ethers.provider, {});
      expect(result.ok).to.equal(true);
      expect(result.warnings.join(" ")).to.match(/log id not pinned/).and.to.match(/anchorer not pinned/).and.to.match(/registry taken from the log/);
    });

    it("catches a consistent rewrite that also deletes the anchor record", async function () {
      const { file, logId } = await anchoredLog();
      // The forger rebuilds the log with valid hashes, keeping entry 0 so the
      // id still matches, changes entry 1, and drops the anchor line.
      const lines = fs.readFileSync(file, "utf8").trim().split("\n");
      fs.writeFileSync(file, lines[0] + "\n");
      const forged = openAuditLog(file, { clock: chainClock() });
      forged.record({ system: "bot", actor: "ash", before: B, after: { ...A, model: "m-evil" } });
      expect(forged.verify().ok).to.equal(true); // the file alone looks fine

      const result = await forged.verifyChain(ethers.provider, { logId, anchorer: alice.address, registry: address });
      expect(result.ok).to.equal(false);
      expect(result.results[0].reason).to.match(/rewritten/);
    });

    it("is blind to deleted anchor records without a registry address, and says so", async function () {
      const { file, logId } = await anchoredLog();
      const lines = fs.readFileSync(file, "utf8").trim().split("\n");
      fs.writeFileSync(file, lines.slice(0, 2).join("\n") + "\n");
      const result = await openAuditLog(file).verifyChain(ethers.provider, { logId, anchorer: alice.address });
      expect(result.warnings.join(" ")).to.match(/no registry given/).and.to.match(/nothing was anchored/);
    });

    it("catches truncation below an anchored length", async function () {
      const { file, logId } = await anchoredLog();
      const lines = fs.readFileSync(file, "utf8").trim().split("\n");
      fs.writeFileSync(file, lines[0] + "\n");
      const result = await openAuditLog(file).verifyChain(ethers.provider, { logId, anchorer: alice.address, registry: address });
      expect(result.ok).to.equal(false);
      expect(result.results[0].reason).to.match(/truncated/);
    });

    it("catches a rewrite that is re-anchored under the same key", async function () {
      const { file, logId } = await anchoredLog();
      const lines = fs.readFileSync(file, "utf8").trim().split("\n");
      fs.writeFileSync(file, lines[0] + "\n");
      const forged = openAuditLog(file, { clock: chainClock() });
      forged.record({ system: "bot", actor: "ash", after: { model: "m-evil" } });
      forged.record({ system: "bot", actor: "ash", after: { model: "m-evil", t: 1 } });
      // The registry accepts it: 3 > 2 entries. The old anchor still stands.
      await forged.anchor({ signer: alice, registry: address });

      const result = await forged.verifyChain(ethers.provider, { logId, anchorer: alice.address, registry: address });
      expect(result.ok).to.equal(false);
      const failed = result.results.filter((r) => !r.ok);
      expect(failed).to.have.length(1);
      expect(failed[0]).to.include({ index: 0 });
    });

    it("catches a fresh log under a new key, given pins", async function () {
      const { logId } = await anchoredLog();
      const forged = openAuditLog(tempLog(), { clock: chainClock() });
      forged.record({ system: "bot", actor: "ash", after: { model: "m-evil" } });
      await forged.anchor({ signer: mallory, registry: address });

      const result = await forged.verifyChain(ethers.provider, { logId, anchorer: alice.address, registry: address });
      expect(result.ok).to.equal(false);
      expect(result.results.map((r) => r.reason).join(" ")).to.match(/not the pinned/).and.to.match(/not a pinned anchorer/);
    });

    it("flags an anchor record that the registry never held", async function () {
      const { file, logId } = await anchoredLog();
      const all = fs.readFileSync(file, "utf8").trim().split("\n").map((l) => JSON.parse(l));
      // Pretend a second anchor happened by forging a record of it.
      fs.writeFileSync(file, all.map((e) => JSON.stringify(e)).join("\n") + "\n");
      const log = openAuditLog(file, { clock: chainClock() });
      const fake = { ...all[2], index: 7 };
      delete fake.hash;
      fake.seq = 3;
      fake.prev = all[2].hash;
      const { keccak256, toUtf8Bytes } = require("ethers");
      const { stableStringify } = require("../sdk/canonical");
      fake.hash = keccak256(toUtf8Bytes(stableStringify(fake)));
      fs.appendFileSync(file, JSON.stringify(fake) + "\n");

      const result = await log.verifyChain(ethers.provider, { logId, anchorer: alice.address, registry: address });
      expect(result.ok).to.equal(false);
      expect(result.results.map((r) => r.reason).join(" ")).to.match(/registry does not hold/);
    });

    it("catches entries dated after the block that anchored them", async function () {
      const file = tempLog();
      const future = openAuditLog(file, { clock: () => "2099-01-01T00:00:00.000Z" });
      future.record({ system: "bot", actor: "ash", after: B });
      await future.anchor({ signer: alice, registry: address });
      const result = await future.verifyChain(ethers.provider, { anchorer: alice.address, registry: address });
      expect(result.ok).to.equal(false);
      expect(result.results[0].reason).to.match(/after the block that anchored it/);
    });

    it("still supports plain-transaction anchors, and says they are weaker", async function () {
      const log = openAuditLog(tempLog(), { clock: chainClock() });
      log.record({ system: "bot", actor: "ash", after: B });
      const entry = await log.anchor({ signer: alice });
      expect(entry.mode).to.equal("tx");
      const result = await log.verifyChain(ethers.provider, { logId: log.verify().logId, anchorer: alice.address });
      expect(result.ok).to.equal(true);
      expect(result.warnings.join(" ")).to.match(/plain transactions/);
    });
  });

  describe("concurrent writers", function () {
    it("serialises appends from separate processes", async function () {
      const file = tempLog();
      openAuditLog(file).record({ system: "bot", actor: "seed", after: A });
      const script =
        "const { openAuditLog } = require(" + JSON.stringify(path.join(__dirname, "..", "sdk", "audit")) + ");" +
        "const log = openAuditLog(process.argv[1]);" +
        "for (let i = 0; i < 10; i++) log.record({ system: 'bot', actor: process.argv[2], after: { i } });";
      const run = (who) =>
        new Promise((resolve, reject) =>
          execFile("node", ["-e", script, file, who], (error) => (error ? reject(error) : resolve()))
        );
      await Promise.all(["w1", "w2", "w3", "w4"].map(run));
      const result = openAuditLog(file).verify();
      expect(result.ok).to.equal(true);
      expect(result.entries).to.equal(41);
    });
  });
});
