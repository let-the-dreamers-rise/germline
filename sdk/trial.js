"use strict";

// defineTrial: the whole public surface a product has to learn.
//
// A trial is two declarations. What may vary -- the genes -- and what better
// means -- evaluate(). Everything else in Germline is derived from those
// two, which is the point: a team should be able to describe their
// configuration space and their metric without reading a line of the
// selection loop, the mutation operator or the contract.

const {
  compileSchema,
  defaultValue,
  validateValue,
  describeValue,
  cardinality,
} = require("./genes");
const { canonical, rootOf, evidenceRootOf } = require("./canonical");
const { mutateConfig } = require("./mutate");
const { measure, SCALES } = require("./score");

function normalise(schema, version, config, where) {
  if (!config || typeof config !== "object" || Array.isArray(config)) {
    throw new Error(where + ": a configuration must be an object");
  }
  const known = new Set(schema.map((gene) => gene.key));
  for (const key of Object.keys(config)) {
    if (key === "version") {
      // Carried so that a configuration read back from a canonical form can
      // be handed straight back in, but it belongs to the trial rather than
      // to the configuration, so it is checked and then dropped.
      if (config.version !== version) {
        throw new Error(
          where +
            ": configuration is version " +
            config.version +
            " but the trial is version " +
            version
        );
      }
      continue;
    }
    if (!known.has(key)) {
      // Silently dropping an unknown key would let a typo in a gene name look
      // like a configuration that simply never moved.
      throw new Error(where + ": unknown gene " + key);
    }
  }
  const out = {};
  for (const gene of schema) {
    if (!(gene.key in config)) throw new Error(where + ": missing gene " + gene.key);
    validateValue(gene, config[gene.key], where);
    out[gene.key] = config[gene.key];
  }
  return out;
}

function defaultLabel(schema, config) {
  return schema
    .map((gene) => gene.key + "=" + describeValue(gene, config[gene.key]))
    .join(" ");
}

/// Declare a configuration space and a way to measure it.
function defineTrial(spec) {
  if (!spec || typeof spec !== "object") {
    throw new Error("defineTrial() needs a specification object");
  }
  if (typeof spec.name !== "string" || spec.name.length === 0) {
    throw new Error("defineTrial(): name is required and identifies the trial on chain");
  }
  if (typeof spec.evaluate !== "function") {
    throw new Error(
      "defineTrial(): evaluate must be a function taking a configuration and returning a score"
    );
  }
  if (spec.repair !== undefined && typeof spec.repair !== "function") {
    throw new Error("defineTrial(): repair must be a function");
  }
  if (spec.label !== undefined && typeof spec.label !== "function") {
    throw new Error("defineTrial(): label must be a function");
  }

  const version = spec.version === undefined ? 1 : spec.version;
  if (!Number.isInteger(version) || version < 1) {
    throw new Error("defineTrial(): version must be a positive integer");
  }

  const scoreScale = spec.scoreScale === undefined ? "auto" : spec.scoreScale;
  if (!SCALES.includes(scoreScale)) {
    throw new Error("defineTrial(): scoreScale must be one of " + SCALES.join(", "));
  }

  const schema = compileSchema(spec.genes);

  const trial = {
    name: spec.name,
    version,
    description: spec.description || "",
    scoreScale,
    genes: schema,
    spec,

    /// The bytes a configuration hashes to. Stable under key order, because
    /// the schema decides the order rather than the caller's object.
    canonical(config) {
      return canonical(schema, normalise(schema, version, config, spec.name), version);
    },

    /// The identity the chain stores for a configuration.
    root(config) {
      return rootOf(schema, normalise(schema, version, config, spec.name), version);
    },

    validate(config) {
      normalise(schema, version, config, spec.name);
      return true;
    },

    /// A configuration reduced to exactly this trial's genes.
    normalise(config) {
      return normalise(schema, version, config, spec.name);
    },

    /// Derive a child. Pure and deterministic in (config, seedHex), which is
    /// what lets anyone holding the parent re-run this and confirm the child
    /// the chain recorded is the child that should have been born.
    mutate(config, seedHex) {
      const parent = normalise(schema, version, config, spec.name);
      let child = mutateConfig(schema, parent, seedHex);
      if (spec.repair) {
        const repaired = spec.repair({ ...child });
        if (!repaired || typeof repaired !== "object") {
          throw new Error(spec.name + ": repair() must return a configuration object");
        }
        child = repaired;
      }
      return normalise(schema, version, child, spec.name + " after repair");
    },

    label(config) {
      const normalised = normalise(schema, version, config, spec.name);
      return spec.label ? spec.label(normalised) : defaultLabel(schema, normalised);
    },

    /// Measure a configuration. Never throws on the product's behalf: a
    /// failed evaluation comes back as an unmeasured organism.
    evaluate(config, context) {
      return measure(trial, normalise(schema, version, config, spec.name), context);
    },

    /// How many configurations the declared space holds.
    size() {
      return cardinality(schema);
    },
  };

  trial.seed = spec.seed
    ? normalise(schema, version, spec.seed, spec.name + " seed")
    : Object.fromEntries(schema.map((gene) => [gene.key, defaultValue(gene)]));

  // The trial's own identity, so an attestation names the space and the
  // version it was measured under and not merely the product's name. A trial
  // that carries its own corpus can supply a trialId of its own instead.
  trial.trialId =
    spec.trialId ||
    evidenceRootOf({
      name: spec.name,
      version,
      genes: schema.map((gene) => ({ ...gene })),
    });

  return Object.freeze(trial);
}

module.exports = { defineTrial };
