"use strict";

// Germline inside a running agent. An agent's config does not change in a
// pull request: the agent, its operator's dashboard, or a tool call swaps the
// model, rewrites the system prompt or raises a limit while it runs. This
// records each of those changes the moment it takes effect, and anchors the
// log on chain from the agent's own key, with no human in the loop.
//
//     const { watchAgent } = require("germline");
//     const audit = watchAgent({ system: "support-agent", signer });   // signer: the agent's wallet
//
//     // Either wrap the model call: every call's effective config is checked
//     const create = audit.wrap((params) => openai.chat.completions.create(params));
//     await create({ model: "gpt-4o-mini", temperature: 0.2, messages });
//
//     // or report the config yourself whenever the agent changes it
//     audit.observe({ model, temperature, systemPrompt, tools }, { actor: "operator", reason: "raise limit" });
//
// Recording is synchronous and local: a change is in the hash-chained log
// before the call it governs is made. Anchoring is batched: after a change,
// one anchor transaction goes out within `anchorAfterMs` (sooner once
// `anchorEvery` changes are waiting), so a busy agent does not pay gas per
// call. A failed anchor never breaks the agent: it is reported to `onError`
// and retried with the next one, and the log keeps every entry.

const fs = require("fs");
const path = require("path");
const { openAuditLog, needsAnchor } = require("./audit");

// The registry recorded in deployments/ for a chain id, or null.
function registryForChain(chainId) {
  const dir = path.join(__dirname, "..", "deployments");
  try {
    for (const name of fs.readdirSync(dir)) {
      if (!name.endsWith("-anchor.json")) continue;
      const record = JSON.parse(fs.readFileSync(path.join(dir, name), "utf8"));
      if (Number(record.chainId) === Number(chainId) && record.address) return record.address;
    }
  } catch (ignored) {}
  return null;
}

/// The parts of an OpenAI-style request that are configuration, not
/// conversation: model, sampling, limits, the system prompt and tool names.
/// Messages other than the system prompt change every call and are left out.
function configOfRequest(params = {}) {
  const config = {};
  for (const key of ["model", "temperature", "top_p", "max_tokens", "max_completion_tokens", "frequency_penalty", "presence_penalty", "seed", "response_format", "tool_choice", "reasoning_effort"]) {
    if (params[key] !== undefined) config[key] = params[key];
  }
  const system = (params.messages || []).filter((m) => m && (m.role === "system" || m.role === "developer")).map((m) => (typeof m.content === "string" ? m.content : JSON.stringify(m.content)));
  if (params.system !== undefined) system.unshift(typeof params.system === "string" ? params.system : JSON.stringify(params.system));
  if (system.length) config.system = system.join("\n\n");
  if (Array.isArray(params.tools)) config.tools = params.tools.map((t) => (t && t.function && t.function.name) || (t && t.name) || "?").sort();
  return JSON.parse(JSON.stringify(config));
}

function watchAgent(options = {}) {
  const system = options.system;
  if (!system || typeof system !== "string") throw new TypeError("watchAgent() needs a system name");
  const log = options.log || openAuditLog(options.file || path.join(".germline", "audit.jsonl"));
  const signer = options.signer || null;
  const anchorAfterMs = options.anchorAfterMs === undefined ? 60000 : options.anchorAfterMs;
  const anchorEvery = options.anchorEvery || 10;
  const onError = options.onError || ((error) => console.error("germline: anchor failed, will retry with the next change: " + error.message));
  const onAnchor = options.onAnchor || (() => {});
  const actor = options.actor || "agent:" + system;

  let pending = 0;

  let timer = null;
  let inflight = null;

  async function anchorNow() {
    if (timer) clearTimeout(timer);
    timer = null;
    if (!signer) return null;
    if (inflight) return inflight;
    inflight = (async () => {
      try {
        let registry = options.registry;
        if (registry === undefined) registry = registryForChain((await signer.provider.getNetwork()).chainId);
        const entry = await log.anchor({ signer, registry: registry || undefined });
        pending = 0;
        if (entry) onAnchor(entry);
        return entry;
      } catch (error) {
        onError(error);
        return null;
      } finally {
        inflight = null;
      }
    })();
    const done = inflight;
    // Changes recorded while that transaction was in flight are not covered
    // by it: make sure they get an anchor of their own, even if no further
    // change ever comes.
    done.then((entry) => { if (entry && needsAnchor(log.entries())) { pending = Math.max(pending, 1); schedule(); } });
    return done;
  }

  function schedule() {
    if (!signer) return;
    if (pending >= anchorEvery) {
      anchorNow();
      return;
    }
    if (!timer) {
      timer = setTimeout(anchorNow, anchorAfterMs);
      if (timer.unref) timer.unref();
    }
  }

  /// Record `config` if it differs from the last one recorded for this
  /// system. Returns the new entry, or null when nothing changed.
  function observe(config, meta = {}) {
    const entry = log.track(system, config, { actor: meta.actor || actor, reason: meta.reason || null, ticket: meta.ticket, eval: meta.eval });
    if (entry) {
      pending++;
      schedule();
    }
    return entry;
  }

  /// Wrap a model call. The request's config is observed before the call is
  /// made, so the log never trails what the agent actually ran.
  function wrap(call, pick = configOfRequest) {
    return function (params, ...rest) {
      observe(pick(params));
      return call.call(this, params, ...rest);
    };
  }

  /// Anchor anything waiting now, e.g. before the process exits.
  async function flush() {
    if (inflight) await inflight;
    if (needsAnchor(log.entries())) return anchorNow();
    return null;
  }

  function stop() {
    if (timer) clearTimeout(timer);
    timer = null;
  }

  return { observe, wrap, flush, stop, log };
}

module.exports = { watchAgent, configOfRequest, registryForChain };
