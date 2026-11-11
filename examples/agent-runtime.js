// A support agent whose config changes while it runs, audited with no human
// in the loop. The model call is a stand-in, so this needs no API key.
//
//   node examples/agent-runtime.js                       # record only
//   GERMLINE_NETWORK=botchain GERMLINE_ANCHOR_KEY=0x... node examples/agent-runtime.js
//
// With a key, the agent anchors its own log on BOT Chain from its own wallet.
// Then: npx germline verify --log .germline/agent-demo.jsonl --chain

const { JsonRpcProvider, Wallet } = require("ethers");
const { watchAgent } = require("../sdk");

const RPC = { botchain: "https://rpc.botchain.ai", bohr: "https://rpc.bohr.life", zerog: "https://evmrpc.0g.ai" };
const rpc = process.env.GERMLINE_RPC || RPC[process.env.GERMLINE_NETWORK || "botchain"];
const key = process.env.GERMLINE_ANCHOR_KEY;
const signer = key ? new Wallet(key, new JsonRpcProvider(rpc)) : null;

const audit = watchAgent({
  system: "support-agent",
  file: ".germline/agent-demo.jsonl",
  signer,
  registry: process.env.GERMLINE_REGISTRY, // default: the deployment for the chain
  anchorAfterMs: 2000,
  onAnchor: (e) => console.log("  anchored " + e.anchoredEntries + " entries on chain " + e.chainId + ": tx " + e.txHash),
});

// Stand-in for openai.chat.completions.create.
const llm = audit.wrap(async (params) => "(" + params.model + " @ " + params.temperature + ") ok");

let config = { model: "gpt-4o-mini", temperature: 0.2, system: "You are a support agent. Never promise refunds." };
const ask = (text) => llm({ model: config.model, temperature: config.temperature, messages: [{ role: "system", content: config.system }, { role: "user", content: text }] });

(async () => {
  console.log(await ask("where is my order?"));
  console.log(await ask("and the tracking number?")); // same config: nothing recorded

  // The operator raises the temperature from a dashboard.
  config = { ...config, temperature: 0.7 };
  console.log(await ask("write a friendly apology"));

  // The agent falls back to another model after a timeout.
  config = { ...config, model: "gpt-4.1-mini" };
  console.log(await ask("summarise the ticket"));

  await audit.flush();
  const changes = audit.log.entries().filter((e) => e.kind === "change");
  console.log(changes.length + " config changes recorded automatically; log: " + audit.log.file);
  if (!signer) console.log("(set GERMLINE_ANCHOR_KEY to have the agent anchor them on BOT Chain itself)");
})();
