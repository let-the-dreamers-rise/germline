"use strict";

// A genome is a small, fully-specified description of how an agent predicts
// what the world will do next. It is deliberately not a pile of weights: it
// has to be readable, diffable, and cheap enough that a chain can carry its
// hash and a person can see what changed between parent and child.
//
// Each gene switches on a piece of context the predictor is allowed to use,
// or sets how cautious it is about answering at all.

const { keccak256, toUtf8Bytes } = require("ethers");

// Gene definitions. The order here is the canonical order, and it must never
// be rearranged: genome hashes are identities on-chain, and reordering would
// silently rename every organism ever born.
const GENES = [
  { key: "useColour", kind: "bool" },
  { key: "useSize", kind: "bool" },
  { key: "useRing", kind: "bool" },
  { key: "useMomentum", kind: "bool" },
  // Which sides of an object it may feel. Up, down, left, right.
  { key: "ringSides", kind: "mask4" },
  // How many observations a context needs before it is trusted at all.
  { key: "minSupport", kind: "int", min: 1, max: 6 },
  // Answer only from contexts that have never contradicted themselves.
  { key: "unanimousOnly", kind: "bool" },
  // On an unknown context, fall back to a less specific one.
  { key: "backoff", kind: "bool" },
];

const FOUNDER = Object.freeze({
  version: 1,
  useColour: false,
  useSize: false,
  useRing: false,
  useMomentum: false,
  ringSides: 0,
  minSupport: 1,
  unanimousOnly: false,
  backoff: false,
});

// Canonical serialisation. Keys in gene order, no whitespace, so the same
// genome always produces the same bytes and therefore the same root.
function canonical(genome) {
  const ordered = { version: genome.version };
  for (const gene of GENES) ordered[gene.key] = genome[gene.key];
  return JSON.stringify(ordered);
}

function genomeRoot(genome) {
  return keccak256(toUtf8Bytes(canonical(genome)));
}

// A short human-readable name for a genome, so lineages can be discussed
// without quoting 32 bytes of hex at each other.
function phenotype(genome) {
  const parts = [];
  if (genome.useColour) parts.push("colour");
  if (genome.useSize) parts.push("size");
  if (genome.useRing && genome.ringSides > 0) {
    const sides = ["U", "D", "L", "R"].filter(
      (_, i) => (genome.ringSides >> i) & 1
    );
    parts.push("ring:" + sides.join(""));
  }
  if (genome.useMomentum) parts.push("momentum");
  if (parts.length === 0) parts.push("action-only");
  const caution = [];
  if (genome.unanimousOnly) caution.push("unanimous");
  if (genome.backoff) caution.push("backoff");
  if (genome.minSupport > 1) caution.push("n>=" + genome.minSupport);
  return parts.join("+") + (caution.length ? " [" + caution.join(",") + "]" : "");
}

function validate(genome) {
  if (genome.version !== 1) throw new Error("unknown genome version");
  for (const gene of GENES) {
    const value = genome[gene.key];
    if (gene.kind === "bool" && typeof value !== "boolean") {
      throw new Error("gene " + gene.key + " must be a boolean");
    }
    if (gene.kind === "mask4" && !(Number.isInteger(value) && value >= 0 && value <= 15)) {
      throw new Error("gene " + gene.key + " must be a 4-bit mask");
    }
    if (gene.kind === "int") {
      if (!Number.isInteger(value) || value < gene.min || value > gene.max) {
        throw new Error("gene " + gene.key + " out of range");
      }
    }
  }
  return true;
}

module.exports = { GENES, FOUNDER, canonical, genomeRoot, phenotype, validate };
