"use strict";

// Mutation is a pure function of the parent configuration and the seed the
// chain chose. Nothing here may read the clock, the filesystem or a random
// source: if it did, a child could no longer be re-derived from its parent,
// and heredity would go back to being a claim someone makes rather than a
// fact anyone can check.
//
// The generator below is deliberately a copy of the one in engine/mutate.js
// rather than an import. The two must produce identical streams -- the ARC
// trial in sdk/trials/arc.js is the same organism whichever path derives it,
// and test/sdk.test.js walks a hundred generations through both to prove it.
// Copying fifteen fixed lines and testing the equality is a smaller
// commitment than having the general layer depend on the first instance of
// itself.

const { mutateValue } = require("./genes");

// xorshift128 seeded from the 32-byte chain seed. Good enough to spread
// mutations evenly and, more importantly, identical on every machine.
function rngFrom(seedHex) {
  const clean = seedHex.startsWith("0x") ? seedHex.slice(2) : seedHex;
  if (clean.length < 32) throw new Error("seed too short to be a chain seed");
  let x = parseInt(clean.slice(0, 8), 16) >>> 0;
  let y = parseInt(clean.slice(8, 16), 16) >>> 0;
  let z = parseInt(clean.slice(16, 24), 16) >>> 0;
  let w = parseInt(clean.slice(24, 32), 16) >>> 0;
  if ((x | y | z | w) === 0) x = 0x9e3779b9;
  return function next() {
    const t = x ^ (x << 11);
    x = y;
    y = z;
    z = w;
    w = (w ^ (w >>> 19) ^ (t ^ (t >>> 8))) >>> 0;
    return w / 0x100000000;
  };
}

// How many genes change in one generation. One is the usual case: a step
// that rewrites half the configuration is search, not descent, and a lineage
// of those tells you nothing about which change did the work.
function mutationCount(random) {
  const roll = random();
  if (roll < 0.7) return 1;
  if (roll < 0.95) return 2;
  return 3;
}

/// Derive a child configuration from a parent and a seed. Structural rules
/// that span genes are not applied here; the trial's repair() does that,
/// because only the trial knows which combinations mean anything.
function mutateConfig(schema, parentConfig, seedHex) {
  const random = rngFrom(seedHex);
  const child = { ...parentConfig };
  const count = mutationCount(random);
  const touched = new Set();

  for (let i = 0; i < count; i++) {
    let index = Math.floor(random() * schema.length);
    // Do not spend two mutations on the same gene; the second would often
    // undo the first and the generation would be wasted.
    let guard = 0;
    while (touched.has(index) && guard++ < schema.length) {
      index = (index + 1) % schema.length;
    }
    touched.add(index);
    const gene = schema[index];
    child[gene.key] = mutateValue(gene, child[gene.key], random);
  }

  return child;
}

module.exports = { mutateConfig, mutationCount, rngFrom };
