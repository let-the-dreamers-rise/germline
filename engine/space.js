"use strict";

// The set of genomes mutation can reach, and the reverse map from a root back
// to the configuration it names.
//
// A genome root is the only thing the chain stores, and a root nobody can
// resolve is not a public record -- it is a receipt for a file you have to be
// given. This genome is small enough that the whole space can be enumerated
// in a few milliseconds, so anyone holding a root can recover the exact
// configuration behind it without asking the breeder for anything.
//
// mutate() keeps useRing and ringSides coherent: a ring with no sides is not
// a ring, and sides with no ring are never felt. So those two move together
// here as well, and the space is the reachable one rather than every
// combination validate() would tolerate.

const { GENES, genomeRoot, phenotype } = require("./genome");

let cachedIndex = null;

function ringConfigurations() {
  const rings = [[false, 0]];
  for (let mask = 1; mask <= 15; mask++) rings.push([true, mask]);
  return rings;
}

/// Every genome a lineage can arrive at, in a fixed order.
function enumerate() {
  const out = [];
  for (const useColour of [false, true]) {
    for (const useSize of [false, true]) {
      for (const ring of ringConfigurations()) {
        for (const useMomentum of [false, true]) {
          for (let minSupport = 1; minSupport <= 6; minSupport++) {
            for (const unanimousOnly of [false, true]) {
              for (const backoff of [false, true]) {
                out.push({
                  version: 1,
                  useColour: useColour,
                  useSize: useSize,
                  useRing: ring[0],
                  useMomentum: useMomentum,
                  ringSides: ring[1],
                  minSupport: minSupport,
                  unanimousOnly: unanimousOnly,
                  backoff: backoff,
                });
              }
            }
          }
        }
      }
    }
  }
  return out;
}

function index() {
  if (cachedIndex) return cachedIndex;
  const map = new Map();
  for (const genome of enumerate()) {
    const root = genomeRoot(genome);
    // Two genomes sharing a root would mean the chain cannot tell two
    // organisms apart, so this is worth checking rather than assuming.
    if (map.has(root)) throw new Error("genome root collision at " + root);
    map.set(root, genome);
  }
  cachedIndex = map;
  return map;
}

/// Recover the genome behind a root, or null if the root is not one this
/// gene set can produce.
function genomeForRoot(root) {
  const found = index().get(String(root).toLowerCase());
  return found ? { ...found } : null;
}

/// The compact table the web viewer ships, so a page holding an on-chain root
/// can name the organism without a server. Values follow GENES order.
function rootTable() {
  const byRoot = {};
  for (const [root, genome] of index()) {
    byRoot[root] = [phenotype(genome)].concat(
      GENES.map((gene) => {
        const value = genome[gene.key];
        return typeof value === "boolean" ? (value ? 1 : 0) : value;
      })
    );
  }
  return {
    fields: GENES.map((gene) => gene.key),
    count: index().size,
    byRoot: byRoot,
  };
}

module.exports = { enumerate, genomeForRoot, rootTable };
