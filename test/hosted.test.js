const { expect } = require("chai");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { ethers } = require("hardhat");
const { openAuditLog } = require("../sdk/audit");
const hosted = require("../web/api/_lib/hosted");

// The hosted tier end to end on a real EVM: the customer's CLI talks to the
// service's handler, the service anchors from its own key, and the auditor
// verifies with the service's address pinned. Each test after the first is
// something a customer, a thief or a broken service could try.

function tempLog() {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), "germline-hosted-")), "audit.jsonl");
}
function chainClock() {
  let n = 0;
  return () => new Date(Date.now() - 60000 + n++ * 10).toISOString();
}
const A = { model: "m-1", temperature: 0.7 };
const B = { model: "m-1", temperature: 0.2 };
const TOKEN = "gl_" + "a".repeat(40);
const OTHER = "gl_" + "b".repeat(40);

async function rejects(promise, pattern) {
  let error = null;
  try {
    await promise;
  } catch (e) {
    error = e;
  }
  expect(error, "expected a rejection").to.be.an("error");
  if (pattern) expect(error.message).to.match(pattern);
  return error;
}

// A fetch that calls the handler in-process, the way Vercel would.
function fetchInto(deps, tamper) {
  return async (url, init) => {
    const result = await hosted.handleAnchor({ method: init.method, headers: init.headers, body: init.body }, deps);
    const body = tamper ? tamper(result.body) : result.body;
    return { ok: result.status >= 200 && result.status < 300, status: result.status, json: async () => body };
  };
}

describe("hosted anchoring", function () {
  let registry, address, service, customer, log, file, logId, deps;

  beforeEach(async function () {
    [service, customer] = await ethers.getSigners();
    registry = await (await ethers.getContractFactory("GermlineAnchor")).deploy();
    address = await registry.getAddress();
    file = tempLog();
    log = openAuditLog(file, { clock: chainClock() });
    log.record({ system: "bot", actor: "ash", before: A, after: B, reason: "lower temperature" });
    logId = log.verify().logId;
    const customers = hosted.parseCustomers(
      JSON.stringify([
        { id: "acme", name: "Acme", tokenHash: hosted.sha256(TOKEN), logId, since: "2026-11-01", public: true },
        { id: "other", name: "Other", tokenHash: hosted.sha256(OTHER), logId: ethers.keccak256(ethers.toUtf8Bytes("x")) },
      ])
    );
    deps = { customers, registry: address, signer: service, minInterval: 0 };
  });

  function client(extra = {}) {
    return { url: "https://germline.example", token: TOKEN, fetch: fetchInto(deps, extra.tamper), provider: ethers.provider, ...extra };
  }

  it("anchors from the service's key and verifies with the service pinned", async function () {
    const entry = await log.anchor({ hosted: client() });
    expect(entry).to.include({ mode: "registry", index: 0, anchoredEntries: 1, registry: address, anchorer: service.address, hosted: "https://germline.example" });
    const result = await log.verifyChain(ethers.provider, { logId, anchorer: service.address, registry: address });
    expect(result.ok).to.equal(true);
    expect(result.warnings).to.deep.equal([]);
    // The customer's own key holds no anchors for this log.
    expect(await registry.anchorCount(logId, customer.address)).to.equal(0n);
  });

  it("keeps anchoring as the log grows, and skips when nothing changed", async function () {
    await log.anchor({ hosted: client() });
    expect(await log.anchor({ hosted: client() })).to.equal(null);
    log.record({ system: "bot", actor: "ash", before: B, after: A });
    const second = await log.anchor({ hosted: client() });
    expect(second.index).to.equal(1);
    const result = await log.verifyChain(ethers.provider, { logId, anchorer: service.address, registry: address });
    expect(result.ok).to.equal(true);
  });

  it("catches a customer who rewrites history after a hosted anchor", async function () {
    await log.anchor({ hosted: client() });
    // Rewrite the first change and rebuild the chain consistently.
    const forgedFile = tempLog();
    const forged = openAuditLog(forgedFile, { clock: chainClock() });
    forged.record({ system: "bot", actor: "ash", before: A, after: { model: "m-1", temperature: 0.9 }, reason: "lower temperature" });
    const result = await forged.verifyChain(ethers.provider, { logId, anchorer: service.address, registry: address });
    expect(result.ok).to.equal(false);
  });

  it("refuses a missing or unknown token", async function () {
    for (const token of ["", "short", "gl_" + "z".repeat(40)]) {
      const r = await hosted.handleAnchor({ method: "POST", headers: { authorization: "Bearer " + token }, body: {} }, deps);
      expect(r.status).to.equal(401);
    }
    await rejects(log.anchor({ hosted: client({ token: "gl_" + "z".repeat(40) }) }), /refused: unknown or missing token/);
  });

  it("refuses a token used for a different log id", async function () {
    await rejects(log.anchor({ hosted: client({ token: OTHER }) }), /not for that log id/);
    expect(await registry.anchorCount(logId, service.address)).to.equal(0n);
  });

  it("refuses an anchor that does not extend the last one", async function () {
    await log.anchor({ hosted: client() });
    const r = await hosted.handleAnchor(
      { method: "POST", headers: { authorization: "Bearer " + TOKEN }, body: { logId, entries: 1, head: ethers.keccak256("0x01") } },
      deps
    );
    expect(r.status).to.equal(409);
  });

  it("rate-limits anchors per log", async function () {
    await log.anchor({ hosted: client() });
    log.record({ system: "bot", actor: "ash", before: B, after: A });
    deps.minInterval = 3600;
    const err = await log.anchor({ hosted: client() }).catch((e) => e);
    expect(err.status).to.equal(429);
    expect(err.retryAfter).to.be.greaterThan(3000);
  });

  it("validates the request body", async function () {
    const call = (body) => hosted.handleAnchor({ method: "POST", headers: { authorization: "Bearer " + TOKEN }, body }, deps);
    expect((await call("not json")).status).to.equal(400);
    expect((await call({ logId, entries: 0, head: ethers.keccak256("0x01") })).status).to.equal(400);
    expect((await call({ logId, entries: 1.5, head: ethers.keccak256("0x01") })).status).to.equal(400);
    expect((await call({ logId, entries: 1, head: ethers.ZeroHash })).status).to.equal(400);
    expect((await call({ logId: "0x12", entries: 1, head: ethers.keccak256("0x01") })).status).to.equal(400);
    expect((await hosted.handleAnchor({ method: "GET", headers: {}, body: null }, deps)).status).to.equal(405);
  });

  it("does not record a receipt that doesn't match the log", async function () {
    const before = fs.readFileSync(file, "utf8");
    await rejects(log.anchor({ hosted: client({ tamper: (b) => ({ ...b, head: ethers.keccak256("0x02") }) }) }), /does not match this log/);
    expect(fs.readFileSync(file, "utf8")).to.equal(before);
  });

  it("does not record an anchor the registry doesn't hold", async function () {
    // A service that answers success but points at an index that isn't there.
    const before = fs.readFileSync(file, "utf8");
    await rejects(log.anchor({ hosted: client({ tamper: (b) => ({ ...b, index: 7 }) }) }));
    expect(fs.readFileSync(file, "utf8")).to.equal(before);
  });

  it("revoking a token stops it without changing the pins", async function () {
    await log.anchor({ hosted: client() });
    deps.customers = deps.customers.filter((c) => c.id !== "acme");
    log.record({ system: "bot", actor: "ash", before: B, after: A });
    await rejects(log.anchor({ hosted: client() }), /unknown or missing token/);
    const result = await log.verifyChain(ethers.provider, { logId, anchorer: service.address, registry: address });
    expect(result.ok).to.equal(true);
  });

  it("publishes pins only for public customers", async function () {
    const pinsDeps = { customers: deps.customers, anchorer: service.address, registry: address, chainId: 16661 };
    const ok = await hosted.handlePins({ method: "GET", query: { logId } }, pinsDeps);
    expect(ok.status).to.equal(200);
    expect(ok.body).to.deep.equal({ name: "Acme", logId: logId.toLowerCase(), anchorer: service.address, registry: address, chainId: 16661, since: "2026-11-01" });
    const other = deps.customers.find((c) => c.id === "other");
    expect((await hosted.handlePins({ method: "GET", query: { logId: other.logId } }, pinsDeps)).status).to.equal(404);
    expect((await hosted.handlePins({ method: "GET", query: { logId: "nope" } }, pinsDeps)).status).to.equal(400);
  });

  it("rejects a malformed customer list at start-up", function () {
    expect(() => hosted.parseCustomers("{")).to.throw(/not valid JSON/);
    expect(() => hosted.parseCustomers("{}")).to.throw(/array/);
    expect(() => hosted.parseCustomers(JSON.stringify([{ id: "x", tokenHash: "nope", logId }]))).to.throw(/tokenHash/);
    expect(hosted.parseCustomers("")).to.deep.equal([]);
  });

  it("refuses a non-https service URL", async function () {
    await rejects(log.anchor({ hosted: client({ url: "http://evil.example" }) }), /https URL/);
  });
});

describe("hosted anchoring with GitHub OIDC", function () {
  const crypto = require("crypto");
  const { privateKey, publicKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
  const kid = "test-" + crypto.randomBytes(4).toString("hex");
  const jwks = { keys: [{ ...publicKey.export({ format: "jwk" }), kid, alg: "RS256", use: "sig" }] };
  const fetchJwks = async () => jwks;
  const REPO_ID = 123456;

  function jwt(claims, { key = privateKey, header = {} } = {}) {
    const now = Math.floor(Date.now() / 1000);
    const h = Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT", kid, ...header })).toString("base64url");
    const body = {
      iss: hosted.GITHUB_ISSUER,
      aud: "germline-hosted",
      iat: now,
      nbf: now - 5,
      exp: now + 300,
      repository: "acme/agents",
      repository_id: String(REPO_ID),
      repository_owner_id: "999",
      event_name: "push",
      ...claims,
    };
    const p = Buffer.from(JSON.stringify(body)).toString("base64url");
    const sig = crypto.sign("RSA-SHA256", Buffer.from(h + "." + p), key).toString("base64url");
    return h + "." + p + "." + sig;
  }

  let registry, address, service, log, logId, deps;
  beforeEach(async function () {
    [service] = await ethers.getSigners();
    registry = await (await ethers.getContractFactory("GermlineAnchor")).deploy();
    address = await registry.getAddress();
    log = openAuditLog(tempLog(), { clock: chainClock() });
    log.record({ system: "bot", actor: "ash", before: A, after: B });
    logId = log.verify().logId;
    deps = {
      customers: hosted.parseCustomers(JSON.stringify([{ id: "acme", repositoryId: REPO_ID, repositoryOwnerId: 999, repository: "acme/agents", logId }])),
      registry: address,
      signer: service,
      minInterval: 0,
      fetchJwks,
    };
  });
  const anchorWith = (token) => log.anchor({ hosted: { url: "https://germline.example", token, fetch: fetchInto(deps), provider: ethers.provider } });

  it("anchors for a repository GitHub vouches for, with no stored secret", async function () {
    const entry = await anchorWith(jwt({}));
    expect(entry.anchorer).to.equal(service.address);
    const result = await log.verifyChain(ethers.provider, { logId, anchorer: service.address, registry: address });
    expect(result.ok).to.equal(true);
  });

  const refused = {
    "another repository": { repository_id: "654321" },
    "the same repo name under a new id (renamed or re-registered)": { repository_id: "777" },
    "another owner": { repository_owner_id: "1" },
    "a token for another service": { aud: "someone-else" },
    "another issuer": { iss: "https://evil.example" },
    "an expired token": { exp: Math.floor(Date.now() / 1000) - 120 },
    "an old token": { iat: Math.floor(Date.now() / 1000) - 3600 },
    "a pull request run": { event_name: "pull_request" },
    "a pull_request_target run": { event_name: "pull_request_target" },
  };
  for (const [name, claims] of Object.entries(refused)) {
    it("refuses " + name, async function () {
      await rejects(anchorWith(jwt(claims)), /unknown or missing token/);
      expect(await registry.anchorCount(logId, service.address)).to.equal(0n);
    });
  }

  it("refuses a token not signed by GitHub, or with a swapped algorithm", async function () {
    const other = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey;
    await rejects(anchorWith(jwt({}, { key: other })), /unknown or missing token/);
    const none = jwt({}).split(".");
    const forgedHeader = Buffer.from(JSON.stringify({ alg: "none", kid })).toString("base64url");
    await rejects(anchorWith(forgedHeader + "." + none[1] + "."), /unknown or missing token/);
    await rejects(anchorWith(jwt({}, { header: { kid: "unknown-kid" } })), /unknown or missing token/);
  });

  it("refuses a valid token for a log id the repository is not bound to", async function () {
    const other = openAuditLog(tempLog(), { clock: chainClock() });
    other.record({ system: "bot", actor: "ash", before: B, after: A });
    await rejects(
      other.anchor({ hosted: { url: "https://germline.example", token: jwt({}), fetch: fetchInto(deps), provider: ethers.provider } }),
      /not for that log id/
    );
  });
});
