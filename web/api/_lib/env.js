// Shared set-up for the hosted endpoints, read once per cold start.
const { parseCustomers, parseMinInterval } = require("./hosted");

let cached = null;

function config() {
  if (cached) return cached;
  const { JsonRpcProvider, Wallet, getAddress } = require("ethers");
  const key = process.env.GERMLINE_HOSTED_KEY;
  const registry = process.env.GERMLINE_REGISTRY;
  if (!registry) throw new Error("GERMLINE_REGISTRY is not set");
  const rpc = process.env.ZEROG_RPC || "https://evmrpc.0g.ai";
  const chainId = Number(process.env.ZEROG_CHAIN_ID || 16661);
  const provider = new JsonRpcProvider(rpc, chainId, { staticNetwork: true });
  const signer = key ? new Wallet(key, provider) : null;
  cached = {
    customers: parseCustomers(process.env.GERMLINE_CUSTOMERS),
    registry: getAddress(registry),
    signer,
    anchorer: signer ? signer.address : process.env.GERMLINE_HOSTED_ADDRESS || null,
    chainId,
    // GitHub OIDC tokens must name this audience (default germline-hosted).
    audience: process.env.GERMLINE_HOSTED_AUDIENCE || undefined,
    // Throws on a malformed value, so the endpoint answers 503 rather than
    // running without a rate limit.
    minInterval: parseMinInterval(process.env.GERMLINE_MIN_INTERVAL),
  };
  return cached;
}

function send(res, result) {
  res.setHeader("content-type", "application/json");
  res.setHeader("cache-control", "no-store");
  if (result.body && result.body.retryAfter) res.setHeader("retry-after", String(result.body.retryAfter));
  res.statusCode = result.status;
  res.end(JSON.stringify(result.body));
}

module.exports = { config, send };
