"use strict";

// 0G Compute, used where it actually belongs in this system.
//
// WHERE IT DOES NOT BELONG. The obvious idea is to have a model propose the
// next mutation. It is also wrong here, and the reason is worth stating: a
// child configuration must be re-derivable from its parent and the on-chain
// seed, or verifiable heredity stops meaning anything. A model's output is
// not reproducible, so an LLM-proposed mutation would quietly turn every
// lineage into an unfalsifiable claim -- trading the one property this
// project exists to provide for a marginally better search.
//
// WHERE IT DOES BELONG. Scoring. Most real trials cannot score themselves
// with arithmetic: you are judging whether a support answer was correct,
// whether a summary kept the facts, whether a rewrite preserved intent. That
// is what an eval harness spends its money on, and it is the part of the loop
// a decentralised inference network genuinely serves.
//
// So Compute sits inside evaluate(), not inside mutate(). Fitness is allowed
// to be measured by a model; heredity is not allowed to be invented by one.
//
// ESTABLISHED BY PROBE, 2026-09-03, no key required for the model list:
//
//   GET  https://router-api.0g.ai/v1/models  ->  200, 20+ models including
//        0gm-1.0-35b-a3b, 0G Foundation's in-house model
//
// The Router is OpenAI-compatible and takes a single API key, so this is
// plain fetch rather than another SDK. That matters: the storage SDK is
// published as deprecated and installing it broke this project's toolchain.

const ROUTER = process.env.ZEROG_COMPUTE_URL || "https://router-api.0g.ai/v1";
const KEY = () => process.env.ZEROG_COMPUTE_KEY || "";

// 0G Foundation's own model. Chosen as the default because this runs on 0G,
// and because a mid-sized model is the right size for a judge: the task is
// scoring against a rubric, not open reasoning.
const DEFAULT_MODEL = process.env.ZEROG_COMPUTE_MODEL || "0gm-1.0-35b-a3b";

const TIMEOUT_MS = 60000;

async function withTimeout(url, options, ms = TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

/// Which models the network is serving. Needs no key, so it doubles as a
/// reachability check that costs nothing.
async function models() {
  try {
    const response = await withTimeout(ROUTER + "/models", {}, 15000);
    if (!response.ok) return { ok: false, status: response.status, models: [] };
    const body = await response.json();
    return {
      ok: true,
      status: response.status,
      models: (body.data || []).map((m) => m.id),
    };
  } catch (error) {
    return { ok: false, status: 0, models: [], error: error.message };
  }
}

/// One chat completion. Returns { ok, text, usage } and never throws, because
/// a judge that crashes mid-search would cost a whole run.
async function complete(messages, options = {}) {
  const key = KEY();
  if (!key) {
    return {
      ok: false,
      text: null,
      note: "no ZEROG_COMPUTE_KEY; get one at pc.0g.ai and deposit 0G",
    };
  }
  try {
    const response = await withTimeout(ROUTER + "/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer " + key,
      },
      body: JSON.stringify({
        model: options.model || DEFAULT_MODEL,
        messages,
        // A judge must be as close to deterministic as the network allows.
        // Any remaining noise is handled by averaging, not by hoping.
        temperature: options.temperature === undefined ? 0 : options.temperature,
        max_tokens: options.maxTokens || 512,
      }),
    });
    if (!response.ok) {
      const body = (await response.text()).slice(0, 200);
      return { ok: false, text: null, note: "HTTP " + response.status + ": " + body };
    }
    const body = await response.json();
    const choice = body.choices && body.choices[0];
    return {
      ok: true,
      text: choice && choice.message ? choice.message.content : "",
      usage: body.usage || null,
      model: body.model || options.model || DEFAULT_MODEL,
    };
  } catch (error) {
    return { ok: false, text: null, note: error.message.slice(0, 160) };
  }
}

function firstNumber(text) {
  const match = String(text).match(/-?\d+(\.\d+)?/);
  return match ? Number(match[0]) : null;
}

/// Build an evaluate() that scores with a model on 0G Compute.
///
/// `spec.run(config)` produces whatever your system produces for a case.
/// `spec.cases` is the set to score. `spec.rubric` tells the judge what good
/// looks like. The returned function is a drop-in evaluate() for defineTrial.
///
/// `samples` exists because a judge is not perfectly deterministic even at
/// temperature zero. Selection will happily promote a configuration that got
/// a lucky judge once, and the lineage would then record that luck as a
/// finding. Averaging is the honest price of a trustworthy lineage.
function makeJudge(spec) {
  const {
    cases,
    run,
    rubric = "Score how well the answer addresses the question, from 0 to 10.",
    model = DEFAULT_MODEL,
    samples = 1,
  } = spec;

  if (!Array.isArray(cases) || cases.length === 0) {
    throw new Error("makeJudge needs a non-empty cases array");
  }
  if (typeof run !== "function") {
    throw new Error("makeJudge needs run(config, testCase)");
  }

  return async function evaluate(config) {
    let total = 0;
    let scored = 0;
    let failed = 0;
    const transcript = [];

    for (const testCase of cases) {
      const output = await run(config, testCase);
      let sum = 0;
      let got = 0;

      for (let i = 0; i < samples; i++) {
        const result = await complete(
          [
            {
              role: "system",
              content:
                rubric +
                " Reply with a single integer from 0 to 10 and nothing else.",
            },
            {
              role: "user",
              content:
                "Case:\n" +
                JSON.stringify(testCase) +
                "\n\nAnswer:\n" +
                String(output),
            },
          ],
          { model }
        );
        if (!result.ok) {
          failed++;
          continue;
        }
        const value = firstNumber(result.text);
        if (value === null) {
          failed++;
          continue;
        }
        sum += Math.max(0, Math.min(10, value));
        got++;
      }

      if (got > 0) {
        const caseScore = sum / got / 10;
        total += caseScore;
        scored++;
        transcript.push({ case: testCase, score: caseScore, samples: got });
      }
    }

    // A judge that could not be reached must not silently look like a bad
    // configuration, because selection would then breed away from whatever
    // happened to be running when the network was down.
    if (scored === 0) {
      throw new Error(
        "0G Compute judge scored nothing (" + failed + " failures); check ZEROG_COMPUTE_KEY and balance"
      );
    }

    return {
      score: total / scored,
      evidence: {
        judge: model,
        via: ROUTER,
        cases: scored,
        samples,
        failures: failed,
        transcript,
      },
    };
  };
}

module.exports = { models, complete, makeJudge, ROUTER, DEFAULT_MODEL };
