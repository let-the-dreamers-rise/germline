"use strict";

// Mutation is a pure function of the parent genome and a seed the chain
// chose. Nothing here may consult the clock, the filesystem, or a random
// source -- if it did, heredity would stop being checkable, which is the one
// property the whole design rests on.
//
// Given a parent genome and the seed recorded on-chain, anybody can run this
// and confirm the child that was actually born is the child that should have
// been.

const { GENES, validate } = require("./genome");

// A small deterministic PRNG. xorshift128 seeded from the 32-byte chain seed;
// good enough to spread mutations evenly and, more importantly, identical on
// every machine that runs it.
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

// How many genes change in one generation. One is the usual case: evolution
// that rewrites half the organism at once is search, not descent.
function mutationCount(random) {
  const roll = random();
  if (roll < 0.7) return 1;
  if (roll < 0.95) return 2;
  return 3;
}

function mutateGene(genome, gene, random) {
  const next = { ...genome };
  if (gene.kind === "bool") {
    next[gene.key] = !genome[gene.key];
  } else if (gene.kind === "mask4") {
    // Flip one side on or off rather than replacing the whole mask, so a
    // neighbourhood can be acquired a side at a time.
    const bit = Math.floor(random() * 4);
    next[gene.key] = genome[gene.key] ^ (1 << bit);
  } else if (gene.kind === "int") {
    const step = random() < 0.5 ? -1 : 1;
    let value = genome[gene.key] + step;
    if (value < gene.min) value = gene.min + 1;
    if (value > gene.max) value = gene.max - 1;
    next[gene.key] = value;
  }
  return next;
}

/// Derive the child genome from a parent and the seed the chain fixed.
function mutate(parentGenome, seedHex) {
  validate(parentGenome);
  const random = rngFrom(seedHex);
  let child = { ...parentGenome };
  const count = mutationCount(random);
  const touched = new Set();

  for (let i = 0; i < count; i++) {
    let index = Math.floor(random() * GENES.length);
    // Do not spend two mutations on the same gene; the second would often
    // undo the first and the generation would be wasted.
    let guard = 0;
    while (touched.has(index) && guard++ < GENES.length) {
      index = (index + 1) % GENES.length;
    }
    touched.add(index);
    child = mutateGene(child, GENES[index], random);
  }

  // A ring with no sides is not a ring, and sides with no ring are not felt.
  // Keep the genome coherent so the phenotype always means what it says.
  if (child.useRing && child.ringSides === 0) child.ringSides = 15;
  if (!child.useRing) child.ringSides = 0;

  validate(child);
  return child;
}

module.exports = { mutate, rngFrom };
