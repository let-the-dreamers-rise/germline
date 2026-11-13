const { expect } = require("chai");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { watchAgent, configOfRequest } = require("../sdk");

// A stand-in for an agent's wallet: records what it is asked to send.
function fakeSigner(sent) {
  return {
    provider: { getNetwork: async () => ({ chainId: 31337n }) },
    getAddress: async () => "0x" + "a".repeat(40),
    sendTransaction: async (tx) => {
      sent.push(tx);
      const hash = "0x" + String(sent.length).padStart(64, "0");
      return { hash, wait: async () => ({ hash, blockNumber: sent.length, logs: [] }) };
    },
  };
}

const tmpLog = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), "germline-agent-")), "audit.jsonl");

describe("watchAgent", function () {
  it("takes the config out of an OpenAI-style request and leaves the conversation", function () {
    const config = configOfRequest({
      model: "gpt-4o-mini",
      temperature: 0.2,
      messages: [{ role: "system", content: "Be careful." }, { role: "user", content: "hi" }],
      tools: [{ type: "function", function: { name: "refund" } }, { type: "function", function: { name: "lookup" } }],
    });
    expect(config).to.deep.equal({ model: "gpt-4o-mini", temperature: 0.2, system: "Be careful.", tools: ["lookup", "refund"] });
  });

  it("records a runtime change once, before the call, and ignores repeats", async function () {
    const file = tmpLog();
    const audit = watchAgent({ system: "bot", file });
    const seen = [];
    const call = audit.wrap(async (params) => { seen.push(audit.log.entries().length); return "ok"; });
    const messages = [{ role: "system", content: "Be careful." }, { role: "user", content: "hi" }];
    await call({ model: "m1", temperature: 0.2, messages });
    await call({ model: "m1", temperature: 0.2, messages: [...messages, { role: "user", content: "again" }] });
    await call({ model: "m1", temperature: 0.9, messages });
    const changes = audit.log.entries();
    expect(changes.map((e) => e.kind)).to.deep.equal(["change", "change"]);
    expect(changes[1].changes).to.deep.equal([{ key: "temperature", from: 0.2, to: 0.9 }]);
    expect(changes[1].actor).to.equal("agent:bot");
    expect(seen).to.deep.equal([1, 1, 2]);
    expect(audit.log.verify().ok).to.equal(true);
  });

  it("anchors from the agent's own key in one batch, without anyone pressing a button", async function () {
    const sent = [];
    const anchored = [];
    const audit = watchAgent({ system: "bot", file: tmpLog(), signer: fakeSigner(sent), registry: null, anchorAfterMs: 20, onAnchor: (e) => anchored.push(e) });
    audit.observe({ model: "m1" });
    audit.observe({ model: "m2" }, { actor: "operator", reason: "upgrade" });
    expect(sent.length).to.equal(0);
    await new Promise((r) => setTimeout(r, 120));
    expect(sent.length).to.equal(1);
    expect(anchored[0].anchoredEntries).to.equal(2);
    expect(audit.log.verify().ok).to.equal(true);
    expect(await audit.flush()).to.equal(null);
  });

  it("anchors at once when anchorEvery changes are waiting", async function () {
    const sent = [];
    const audit = watchAgent({ system: "bot", file: tmpLog(), signer: fakeSigner(sent), registry: null, anchorAfterMs: 60000, anchorEvery: 2 });
    audit.observe({ t: 1 });
    audit.observe({ t: 2 });
    await audit.flush();
    expect(sent.length).to.equal(1);
    audit.stop();
  });

  it("never throws into the agent when anchoring fails", async function () {
    const errors = [];
    const signer = fakeSigner([]);
    signer.sendTransaction = async () => { throw new Error("no gas"); };
    const audit = watchAgent({ system: "bot", file: tmpLog(), signer, registry: null, anchorAfterMs: 10, onError: (e) => errors.push(e.message) });
    audit.observe({ t: 1 });
    await new Promise((r) => setTimeout(r, 60));
    expect(errors).to.deep.equal(["no gas"]);
    expect(audit.log.entries().length).to.equal(1);
  });

  it("anchors changes made while an anchor transaction was still in flight", async function () {
    const sent = [];
    let release;
    const gate = new Promise((r) => (release = r));
    const signer = fakeSigner(sent);
    const send = signer.sendTransaction;
    signer.sendTransaction = async (tx) => { const out = await send(tx); if (sent.length === 1) await gate; return out; };
    const anchored = [];
    const audit = watchAgent({ system: "bot", file: tmpLog(), signer, registry: null, anchorAfterMs: 20, onAnchor: (e) => anchored.push(e) });
    audit.observe({ model: "m1" });
    await new Promise((r) => setTimeout(r, 50)); // first anchor is now waiting on the chain
    audit.observe({ model: "m2" }, { actor: "operator", reason: "mid-flight" });
    release();
    await new Promise((r) => setTimeout(r, 150));
    expect(sent.length).to.equal(2);
    expect(anchored.map((e) => e.anchoredEntries)).to.deep.equal([1, 3]);
    expect(audit.log.verify().ok).to.equal(true);
    expect(await audit.flush()).to.equal(null);
  });
});
