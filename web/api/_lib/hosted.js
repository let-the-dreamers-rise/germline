// Hosted anchoring: the paid tier's server side.
//
// A customer's CI sends (logId, entries, head) with a bearer token. We check
// the token, check it is bound to that log id, and anchor the head in the
// GermlineAnchor registry from Germline's own key. The customer never holds
// the anchoring key, so they cannot rewrite their history and re-anchor it
// under the same anchorer, and the auditor pins one public address: ours.
//
// Nothing about the customer's prompts reaches us: only the log id, the
// entry count and the head hash, which are already public once anchored.
//
// A customer authenticates one of two ways: a GitHub Actions OIDC token
// (no secret to store; bound to the repository's numeric id), or a bearer
// token for CI elsewhere.
//
// Customers live in one environment variable, GERMLINE_CUSTOMERS, a JSON
// array of { id, name, repositoryId?, repository?, tokenHash?, logId, since, public }. tokenHash is the
// sha256 hex of the bearer token (scripts/hosted-customer.js makes both), so
// a leaked environment does not leak working tokens. Revoking a token is
// removing its row; the customer's anchor history and pins do not change.
//
// This file has no Vercel dependency, so the SDK tests exercise it directly.

const crypto = require("crypto");

const REGISTRY_ABI = [
  "function anchor(bytes32 logId, uint64 entries, bytes32 head, bytes32 storageRoot) returns (uint256)",
  "function latest(bytes32 logId, address anchorer) view returns (tuple(uint64 covered, uint64 timestamp, uint64 blockNumber, bytes32 head, bytes32 storageRoot))",
  "event Anchored(bytes32 indexed logId, address indexed anchorer, uint256 indexed index, uint64 entries, bytes32 head, bytes32 storageRoot)",
];

const HASH = /^0x[0-9a-fA-F]{64}$/;
const SHA256_HEX = /^[0-9a-f]{64}$/;
const ZERO = "0x" + "0".repeat(64);
const MAX_ENTRIES = 2 ** 63;
// One anchor per log every few minutes is plenty for CI and caps what a
// leaked token can cost us in gas.
const DEFAULT_MIN_INTERVAL = 300;
// The most one call may extend a log past its last anchor. Anchoring is
// append-only and permanent, so without a cap one leaked token could anchor
// a huge entry count and every honest anchor after it would be refused.
const MAX_ENTRIES_JUMP = 100000;
// How long to wait for an anchor to be mined before answering.
const TX_TIMEOUT_MS = 90 * 1000;

/// GERMLINE_MIN_INTERVAL as seconds. Anything but a positive integer stops
/// the service at start-up: a typo such as "5m" must not switch the gas
/// limit off.
function parseMinInterval(value) {
  if (value === undefined || value === null || value === "") return DEFAULT_MIN_INTERVAL;
  const text = String(value).trim();
  if (!/^[1-9][0-9]{0,6}$/.test(text)) {
    throw new Error("GERMLINE_MIN_INTERVAL must be a whole number of seconds, at least 1 (got " + JSON.stringify(text.slice(0, 20)) + ")");
  }
  return Number(text);
}

function sha256(text) {
  return crypto.createHash("sha256").update(String(text), "utf8").digest("hex");
}

function parseCustomers(raw) {
  if (!raw) return [];
  let list;
  try {
    list = JSON.parse(raw);
  } catch (e) {
    throw new Error("GERMLINE_CUSTOMERS is not valid JSON");
  }
  if (!Array.isArray(list)) throw new Error("GERMLINE_CUSTOMERS must be a JSON array");
  return list.map((c, i) => {
    if (!c || typeof c !== "object") throw new Error("customer " + i + " is not an object");
    if (typeof c.id !== "string" || !c.id) throw new Error("customer " + i + " has no id");
    const hasToken = SHA256_HEX.test(c.tokenHash || "");
    const hasRepo = Number.isSafeInteger(c.repositoryId) && c.repositoryId > 0;
    if (c.tokenHash !== undefined && !hasToken) throw new Error("customer " + c.id + " has an invalid tokenHash");
    if (c.repositoryId !== undefined && !hasRepo) throw new Error("customer " + c.id + " has an invalid repositoryId");
    if (!hasToken && !hasRepo) throw new Error("customer " + c.id + " needs a tokenHash or a repositoryId");
    if (!HASH.test(c.logId || "")) throw new Error("customer " + c.id + " has no valid logId");
    return {
      id: c.id,
      name: typeof c.name === "string" ? c.name : c.id,
      tokenHash: hasToken ? c.tokenHash : null,
      repositoryId: hasRepo ? c.repositoryId : null,
      repositoryOwnerId: Number.isSafeInteger(c.repositoryOwnerId) && c.repositoryOwnerId > 0 ? c.repositoryOwnerId : null,
      repository: typeof c.repository === "string" ? c.repository : null,
      logId: c.logId.toLowerCase(),
      since: typeof c.since === "string" ? c.since : null,
      public: c.public === true,
    };
  });
}

// Compare against every row so the time taken does not say which rows exist.
function findByToken(customers, token) {
  if (typeof token !== "string" || token.length < 20) return null;
  const given = Buffer.from(sha256(token), "hex");
  let found = null;
  for (const c of customers) {
    if (!c.tokenHash) continue;
    if (crypto.timingSafeEqual(given, Buffer.from(c.tokenHash, "hex")) && !found) found = c;
  }
  return found;
}

// GitHub Actions OIDC. A workflow with `id-token: write` can ask GitHub for a
// short-lived JWT naming the repository it runs in. We check GitHub's
// signature, the issuer, our audience and the expiry, then match the
// repository's numeric id (which survives renames and can't be re-registered
// by someone else) against the customer list. The customer stores no secret.
const GITHUB_ISSUER = "https://token.actions.githubusercontent.com";
const DEFAULT_AUDIENCE = "germline-hosted";
let jwksCache = null;

function b64urlJson(part) {
  return JSON.parse(Buffer.from(part, "base64url").toString("utf8"));
}

// GitHub's signing keys. A refresh that fails or returns no keys keeps the
// keys we have, and an unknown kid triggers at most one refetch a minute, so
// a flood of junk tokens can neither wipe the cache nor make us hammer GitHub.
const JWKS_MAX_AGE_MS = 10 * 60 * 1000;
const JWKS_MIN_REFETCH_MS = 60 * 1000;
let jwksLastFetch = 0;

function defaultFetchJwks(url) {
  return globalThis.fetch(url, { signal: AbortSignal.timeout(3000) }).then((r) => {
    if (!r.ok) throw new Error("JWKS fetch answered " + r.status);
    return r.json();
  });
}

async function githubKeys(fetchJwks, kid) {
  const now = Date.now();
  const stale = !jwksCache || now - jwksCache.at > JWKS_MAX_AGE_MS;
  const unknown = !jwksCache || !jwksCache.keys.some((k) => k.kid === kid);
  const mayFetch = stale || now - jwksLastFetch >= JWKS_MIN_REFETCH_MS;
  if ((stale || unknown) && mayFetch) {
    jwksLastFetch = now;
    let body = null;
    try {
      body = await (fetchJwks || defaultFetchJwks)(GITHUB_ISSUER + "/.well-known/jwks");
    } catch (e) {
      body = null;
    }
    const keys = body && Array.isArray(body.keys) ? body.keys.filter((k) => k && typeof k.kid === "string") : [];
    if (keys.length) jwksCache = { at: now, keys };
  }
  return jwksCache ? jwksCache.keys : [];
}

/// For tests: forget cached keys and the refetch throttle.
function _resetJwksCache() {
  jwksCache = null;
  jwksLastFetch = 0;
}

/// Returns the verified claims, or null. Never throws on a bad token.
async function verifyGithubOidc(jwt, { audience = DEFAULT_AUDIENCE, fetchJwks, now } = {}) {
  if (typeof jwt !== "string") return null;
  const parts = jwt.split(".");
  if (parts.length !== 3) return null;
  let header, claims;
  try {
    header = b64urlJson(parts[0]);
    claims = b64urlJson(parts[1]);
  } catch (e) {
    return null;
  }
  if (!header || header.alg !== "RS256" || typeof header.kid !== "string") return null;
  let keys;
  try {
    keys = await githubKeys(fetchJwks, header.kid);
  } catch (e) {
    return null;
  }
  const jwk = keys.find((k) => k.kid === header.kid && k.kty === "RSA");
  if (!jwk) return null;
  let valid = false;
  try {
    const key = crypto.createPublicKey({ key: jwk, format: "jwk" });
    valid = crypto.verify("RSA-SHA256", Buffer.from(parts[0] + "." + parts[1]), key, Buffer.from(parts[2], "base64url"));
  } catch (e) {
    return null;
  }
  if (!valid || !claims) return null;
  const t = Math.floor((now ? now() : Date.now()) / 1000);
  if (claims.iss !== GITHUB_ISSUER) return null;
  const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (!aud.includes(audience)) return null;
  if (!Number.isFinite(claims.exp) || claims.exp < t - 60) return null;
  if (Number.isFinite(claims.nbf) && claims.nbf > t + 60) return null;
  if (Number.isFinite(claims.iat) && claims.iat < t - 600) return null;
  // Only runs that land code on a branch anchor; a pull request from a fork
  // must not be able to anchor into the customer's log.
  if (!["push", "workflow_dispatch", "schedule"].includes(claims.event_name)) return null;
  return claims;
}

async function authenticate(customers, token, options) {
  if (typeof token === "string" && token.split(".").length === 3) {
    const claims = await verifyGithubOidc(token, options);
    if (!claims) return null;
    const id = Number(claims.repository_id);
    const owner = Number(claims.repository_owner_id);
    return customers.find((c) => c.repositoryId && c.repositoryId === id && (!c.repositoryOwnerId || c.repositoryOwnerId === owner)) || null;
  }
  return findByToken(customers, token);
}

function bearer(headers) {
  const h = headers && (headers.authorization || headers.Authorization);
  if (typeof h !== "string") return null;
  const m = /^Bearer\s+(\S+)$/.exec(h.trim());
  return m ? m[1] : null;
}

function reply(status, body) {
  return { status, body };
}

/// POST /api/anchor. `deps` = { customers, registry, signer, audience?, fetchJwks?, now?, minInterval? }.
/// `audience` is what GitHub OIDC tokens must be issued for (default germline-hosted).
/// Returns { status, body } and never throws for a client error.
async function handleAnchor(request, deps) {
  if (request.method !== "POST") return reply(405, { error: "use POST" });
  const customer = await authenticate(deps.customers, bearer(request.headers), { audience: deps.audience, fetchJwks: deps.fetchJwks, now: deps.now });
  if (!customer) return reply(401, { error: "unknown or missing token" });

  let body = request.body;
  if (typeof body === "string") {
    try {
      body = JSON.parse(body);
    } catch (e) {
      return reply(400, { error: "body is not JSON" });
    }
  }
  if (!body || typeof body !== "object") return reply(400, { error: "body must be a JSON object" });
  const { logId, head } = body;
  const entries = body.entries;
  const storageRoot = body.storageRoot == null ? ZERO : body.storageRoot;
  if (!HASH.test(logId || "")) return reply(400, { error: "logId must be a 32-byte hex hash" });
  if (!HASH.test(head || "") || /^0x0+$/.test(head)) return reply(400, { error: "head must be a non-zero 32-byte hex hash" });
  if (!HASH.test(storageRoot)) return reply(400, { error: "storageRoot must be a 32-byte hex hash or null" });
  if (!Number.isSafeInteger(entries) || entries < 1 || entries >= MAX_ENTRIES) return reply(400, { error: "entries must be a positive integer" });
  // The token is for one log. A customer who could anchor any log id under
  // our address could start a fresh, rewritten log and have it look like ours.
  if (logId.toLowerCase() !== customer.logId) return reply(403, { error: "this token is not for that log id" });

  const { Contract } = require("ethers");
  const anchorer = await deps.signer.getAddress();
  const contract = new Contract(deps.registry, REGISTRY_ABI, deps.signer);
  const now = Math.floor((deps.now ? deps.now() : Date.now()) / 1000);
  const minInterval = deps.minInterval == null ? DEFAULT_MIN_INTERVAL : deps.minInterval;

  let last;
  try {
    last = await contract.latest(logId, anchorer);
  } catch (e) {
    return reply(502, { error: "could not read the registry; try again" });
  }
  const covered = Number(last.covered);
  if (covered >= entries) {
    return reply(409, { error: "not append-only: already anchored " + covered + " entries", anchored: covered });
  }
  if (entries - covered > MAX_ENTRIES_JUMP) {
    return reply(400, { error: "entries is more than " + MAX_ENTRIES_JUMP + " past the last anchor (" + covered + "); anchor more often" });
  }
  const wait = Number(last.timestamp) + minInterval - now;
  if (covered > 0 && minInterval > 0 && wait > 0) return reply(429, { error: "anchored recently; try again later", retryAfter: wait });

  let receipt;
  let sent = null;
  try {
    sent = await contract.anchor(logId, entries, head, storageRoot);
    receipt = await sent.wait(1, TX_TIMEOUT_MS);
  } catch (e) {
    // Once sent, the anchor may still land: say so, rather than claim
    // nothing happened and invite a retry that would then be refused.
    if (sent) return reply(502, { error: "the anchor transaction was sent but not confirmed in time; check the registry before retrying", txHash: sent.hash });
    return reply(502, { error: "the anchor transaction could not be sent; nothing was anchored" });
  }
  if (!receipt) return reply(502, { error: "the anchor transaction was sent but not confirmed in time; check the registry before retrying", txHash: sent.hash });
  let index = null;
  for (const log of receipt.logs || []) {
    let parsed = null;
    try {
      parsed = contract.interface.parseLog(log);
    } catch (ignored) {}
    if (parsed && parsed.name === "Anchored") index = Number(parsed.args.index);
  }
  if (index === null) return reply(502, { error: "the anchor transaction emitted no Anchored event", txHash: receipt.hash });
  const network = await deps.signer.provider.getNetwork();
  return reply(200, {
    logId: logId.toLowerCase(),
    entries,
    head: head.toLowerCase(),
    anchorer,
    registry: deps.registry,
    chainId: Number(network.chainId),
    index,
    txHash: receipt.hash,
    block: receipt.blockNumber,
  });
}

/// GET /api/pins?logId=0x… The pins an auditor should hold for a hosted log,
/// published by us rather than by the customer. Only for customers marked
/// public; anything else answers 404 so ids cannot be probed.
async function handlePins(request, deps) {
  if (request.method !== "GET") return reply(405, { error: "use GET" });
  const logId = String((request.query && request.query.logId) || "").toLowerCase();
  if (!HASH.test(logId)) return reply(400, { error: "logId must be a 32-byte hex hash" });
  const customer = deps.customers.find((c) => c.public && c.logId === logId);
  if (!customer) return reply(404, { error: "no published pins for that log id" });
  return reply(200, {
    name: customer.name,
    logId: customer.logId,
    anchorer: deps.anchorer,
    registry: deps.registry,
    chainId: deps.chainId,
    since: customer.since,
  });
}

module.exports = { handleAnchor, handlePins, parseCustomers, findByToken, verifyGithubOidc, sha256, parseMinInterval, _resetJwksCache, DEFAULT_AUDIENCE, REGISTRY_ABI, DEFAULT_MIN_INTERVAL, MAX_ENTRIES_JUMP, GITHUB_ISSUER };
