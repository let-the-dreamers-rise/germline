"use strict";

// Canonical form and the roots derived from it.
//
// Keys are emitted in the trial's declared gene order with no whitespace, so
// the same configuration produces the same bytes however the caller happened
// to build the object. That makes the root an identity rather than a
// fingerprint of one particular JSON serialiser, which matters because the
// root is what the chain stores and what a customer re-derives when they
// check a lineage years later.
//
// The declared order of a trial's genes is therefore part of that trial's
// identity. Adding a gene or reordering the existing ones renames every
// organism ever born under it, so a trial that has minted anything should
// bump its version rather than quietly change shape.

const { keccak256, toUtf8Bytes } = require("ethers");

function canonical(schema, config, version) {
  const ordered = { version };
  for (const gene of schema) ordered[gene.key] = config[gene.key];
  return JSON.stringify(ordered);
}

function rootOf(schema, config, version) {
  return keccak256(toUtf8Bytes(canonical(schema, config, version)));
}

// Evidence is written by the product, not by us, so its key order is
// whatever that product's evaluate() happened to emit. Sorting keys at every
// level makes the evidence root reproducible by anyone re-running the same
// evaluation, which is the only reason to record it on chain at all.
// Deep enough for any real config; shallow enough that recursion can't blow
// the stack (a crafted 3,000-level file would otherwise crash every verifier).
const MAX_DEPTH = 256;

function stableStringify(value) {
  return write(value, new Set(), 0);
}

function write(value, seen, depth) {
  if (value === null) return "null";
  if (depth > MAX_DEPTH) throw new TypeError("value is nested deeper than " + MAX_DEPTH + " levels");

  const type = typeof value;
  if (type === "number") {
    if (!Number.isFinite(value)) {
      throw new TypeError("evidence contains a non-finite number, which has no canonical form");
    }
    return JSON.stringify(value);
  }
  if (type === "string" || type === "boolean") return JSON.stringify(value);
  if (type === "bigint") return JSON.stringify(value.toString());
  if (type === "undefined" || type === "function" || type === "symbol") {
    throw new TypeError("evidence contains a " + type + ", which cannot be hashed");
  }

  if (value instanceof Date) return JSON.stringify(value.toISOString());

  if (seen.has(value)) throw new TypeError("evidence contains a cycle");
  seen.add(value);
  let out;
  if (Array.isArray(value)) {
    // Array order is meaningful, so it is left exactly as the product built it.
    out = "[" + value.map((item) => write(item, seen, depth + 1)).join(",") + "]";
  } else {
    const keys = Object.keys(value).sort();
    out =
      "{" +
      keys
        .map((key) => JSON.stringify(key) + ":" + write(value[key], seen, depth + 1))
        .join(",") +
      "}";
  }
  seen.delete(value);
  return out;
}

function evidenceRootOf(payload) {
  return keccak256(toUtf8Bytes(stableStringify(payload)));
}

function hashText(text) {
  return keccak256(toUtf8Bytes(text));
}

function depthOf(value) {
  // Iterative, so measuring a hostile value can't overflow the stack either.
  let max = 0;
  const stack = [[value, 0]];
  while (stack.length) {
    const [v, d] = stack.pop();
    if (d > max) max = d;
    if (max > MAX_DEPTH) return max;
    if (v && typeof v === "object") for (const k of Object.keys(v)) stack.push([v[k], d + 1]);
  }
  return max;
}

module.exports = { MAX_DEPTH, depthOf, canonical, rootOf, stableStringify, evidenceRootOf, hashText };
