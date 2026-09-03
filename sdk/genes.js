"use strict";

// The gene type system.
//
// Germline's first genome was a hardcoded list of ARC world-model switches.
// That was enough for one experiment and useless as a product: every team's
// configuration space is different and none of them look like ours. So the
// list moved out of the library and into the trial. A product declares what
// may vary; canonical form, validation and mutation are all derived from
// that declaration, and nothing in the library needs to know what any of the
// genes mean.
//
// Four types have covered every configuration space we have had to describe:
// a switch, a bounded integer, a fixed set of alternatives, and a set of
// independent flags packed into one integer. The set is kept deliberately
// small because mutation has to stay pure arithmetic over a chain-chosen
// seed. A type whose mutation needed a lookup, a clock or a model call would
// break verifiable heredity for every other type in the same genome.

const TYPES = ["bool", "int", "choice", "mask"];

// The key a trial's version occupies in the canonical form. A gene cannot
// claim it, because the canonical form would then have two meanings for one
// key and the root would stop identifying the configuration.
const RESERVED = "version";

// What a choice may offer. A value that does not survive a JSON round trip
// unchanged cannot appear in a canonical form, and the canonical form is the
// on-chain identity.
function isPrimitive(value) {
  return (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean" ||
    (typeof value === "number" && Number.isFinite(value))
  );
}

function compileGene(key, declaration) {
  if (key === RESERVED) {
    throw new Error("gene " + key + ": that name is reserved for the trial version");
  }
  if (!declaration || typeof declaration !== "object") {
    throw new Error("gene " + key + ": declaration must be an object");
  }
  const type = declaration.type;
  if (!TYPES.includes(type)) {
    throw new Error(
      "gene " +
        key +
        ": unknown type " +
        JSON.stringify(type) +
        " (expected one of " +
        TYPES.join(", ") +
        ")"
    );
  }

  if (type === "bool") return { key, type };

  if (type === "int") {
    const { min, max } = declaration;
    if (!Number.isInteger(min) || !Number.isInteger(max)) {
      throw new Error("gene " + key + ": int needs an integer min and max");
    }
    if (min > max) throw new Error("gene " + key + ": min is above max");
    return { key, type, min, max };
  }

  if (type === "choice") {
    const options = declaration.options;
    if (!Array.isArray(options) || options.length === 0) {
      throw new Error("gene " + key + ": choice needs a non-empty options array");
    }
    for (const option of options) {
      if (!isPrimitive(option)) {
        throw new Error(
          "gene " +
            key +
            ": choice options must be JSON primitives (string, number, boolean or null)"
        );
      }
    }
    const distinct = new Set(options.map((o) => typeof o + ":" + String(o)));
    if (distinct.size !== options.length) {
      // A duplicated option would make "mutate to a different option" a lie:
      // the child would carry a different index and the same configuration,
      // so a generation would be spent producing its own parent.
      throw new Error("gene " + key + ": choice options must be distinct");
    }
    return { key, type, options: options.slice() };
  }

  const bits = declaration.bits;
  if (!Number.isInteger(bits) || bits < 1 || bits > 30) {
    // Above 30 the mask stops fitting in the signed 32-bit space that the
    // bitwise operators below work in, and flipping a bit would corrupt it.
    throw new Error("gene " + key + ": mask needs bits between 1 and 30");
  }
  return { key, type, bits, max: (1 << bits) - 1 };
}

/// Turn a trial's gene declaration into the schema everything else uses.
/// Declaration order is preserved and becomes the canonical key order.
function compileSchema(genes) {
  if (!genes || typeof genes !== "object" || Array.isArray(genes)) {
    throw new Error("genes must be an object mapping names to declarations");
  }
  const keys = Object.keys(genes);
  if (keys.length === 0) throw new Error("a trial needs at least one gene");
  return keys.map((key) => compileGene(key, genes[key]));
}

/// The value a gene takes when the trial names no seed configuration. The
/// quietest option in each case, so an unstated seed is the conservative one.
function defaultValue(gene) {
  if (gene.type === "bool") return false;
  if (gene.type === "int") return gene.min;
  if (gene.type === "choice") return gene.options[0];
  return 0;
}

function validateValue(gene, value, where) {
  const prefix = (where ? where + ": " : "") + "gene " + gene.key;
  if (gene.type === "bool") {
    if (typeof value !== "boolean") throw new Error(prefix + " must be a boolean");
    return true;
  }
  if (gene.type === "int") {
    if (!Number.isInteger(value) || value < gene.min || value > gene.max) {
      throw new Error(
        prefix + " must be an integer in " + gene.min + ".." + gene.max
      );
    }
    return true;
  }
  if (gene.type === "choice") {
    if (gene.options.indexOf(value) < 0) {
      throw new Error(
        prefix + " must be one of " + JSON.stringify(gene.options)
      );
    }
    return true;
  }
  if (!Number.isInteger(value) || value < 0 || value > gene.max) {
    throw new Error(prefix + " must be a " + gene.bits + "-bit mask");
  }
  return true;
}

/// Move one gene. The caller supplies the deterministic stream; how much of
/// it each type consumes is fixed, because two runs of the same lineage have
/// to draw the same numbers in the same order.
function mutateValue(gene, value, random) {
  if (gene.type === "bool") {
    // A switch has one other state, so no randomness is spent choosing it.
    return !value;
  }

  if (gene.type === "mask") {
    // Flip one flag rather than replacing the whole mask, so a neighbourhood
    // can be acquired a flag at a time instead of in one improbable jump.
    const bit = Math.floor(random() * gene.bits);
    return value ^ (1 << bit);
  }

  if (gene.type === "int") {
    const step = random() < 0.5 ? -1 : 1;
    let next = value + step;
    // Bounce off the ends rather than sticking to them. A mutation that
    // returned the parent's value would waste the generation.
    if (next < gene.min) next = gene.min + 1;
    if (next > gene.max) next = gene.max - 1;
    if (next < gene.min || next > gene.max) return value;
    return next;
  }

  // Choice. Draw from the options this gene is not currently on, so the
  // child always differs from the parent in the gene that was selected.
  const options = gene.options;
  const roll = Math.floor(random() * Math.max(options.length - 1, 1));
  if (options.length === 1) return value;
  let index = options.indexOf(value);
  if (index < 0) index = 0;
  return options[roll >= index ? roll + 1 : roll];
}

/// How a gene's value reads in a phenotype line.
function describeValue(gene, value) {
  if (gene.type === "bool") return value ? "on" : "off";
  if (gene.type === "mask") {
    let out = "";
    for (let bit = 0; bit < gene.bits; bit++) out += (value >> bit) & 1 ? "1" : "0";
    return out;
  }
  return String(value);
}

/// How many configurations the declared space holds. Reported rather than
/// searched: the number is usually the argument for searching at all.
function cardinality(schema) {
  let total = 1;
  for (const gene of schema) {
    if (gene.type === "bool") total *= 2;
    else if (gene.type === "int") total *= gene.max - gene.min + 1;
    else if (gene.type === "choice") total *= gene.options.length;
    else total *= Math.pow(2, gene.bits);
  }
  return total;
}

module.exports = {
  TYPES,
  RESERVED,
  compileSchema,
  compileGene,
  defaultValue,
  validateValue,
  mutateValue,
  describeValue,
  cardinality,
};
