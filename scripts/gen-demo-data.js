"use strict";

// Build the dataset the web viewer falls back to before a contract exists.
//
// Every number here is measured rather than invented: the lineage comes from
// engine/evolve.js simulate(), each organism is scored by engine/fitness.js
// against the recorded corpus, and every parent-child edge is re-derived from
// its seed before it is written out. If a child could not be reproduced by
// mutate(parentGenome, seed) this script refuses to emit the file at all --
// a viewer that showed an unverifiable lineage would be undermining the exact
// property the project claims.
//
//     node scripts/gen-demo-data.js

const fs = require("fs");
const path = require("path");

const { GENES, FOUNDER, canonical, genomeRoot } = require("../engine/genome");
const { mutate } = require("../engine/mutate");
const { evaluate } = require("../engine/fitness");
const { simulate, spawnAllowance, simulatedSeed } = require("../engine/evolve");
const { rootTable } = require("../engine/space");

// Matches the constructor arguments in scripts/deploy.js. Selection in the
// viewer has to obey the rules the contract obeys, or the page is describing
// a different system from the one on chain.
const SURVIVAL_THRESHOLD = 3148;
const FECUNDITY_STEP = 500;
const BASE_FECUNDITY = 4;

// Six breeding rounds. Enough for the population to reach the measured peak
// and to throw off dead ends worth looking at, few enough that the whole
// lineage stays legible on one screen, which is the only reason this exists.
const ROUNDS = 6;
const SALT = "germline";

// What each gene actually switches on. This is prose for a reader rather than
// behaviour, so it lives here instead of in engine/genome.js; the keys are
// taken from GENES so a renamed gene fails loudly here rather than quietly
// showing a viewer a stale description.
const GENE_SUMMARY = {
  useColour: "Let the predictor see what colour the object is.",
  useSize: "Let it see how large the object is.",
  useRing: "Let it feel what sits immediately around the object.",
  useMomentum: "Let it see which way the object was already moving.",
  ringSides:
    "Which sides of that neighbourhood it may feel, as a four-bit mask over up, down, left and right.",
  minSupport:
    "How many times a context must have been seen before the predictor will answer from it.",
  unanimousOnly:
    "Answer only from contexts that have never once contradicted themselves.",
  backoff:
    "On a context never seen before, drop to a less specific one instead of abstaining.",
};

function geneCatalogue() {
  return GENES.map(function (gene) {
    const summary = GENE_SUMMARY[gene.key];
    if (!summary) {
      throw new Error(
        "gene " + gene.key + " has no summary; add one to GENE_SUMMARY"
      );
    }
    const entry = { key: gene.key, kind: gene.kind, summary: summary };
    if (gene.kind === "int") entry.range = [gene.min, gene.max];
    return entry;
  });
}

// Recover the seed a child was actually born under. simulate() does not
// report it, and reconstructing its loop here would only be a second guess at
// the same thing, so instead we search the small space of seeds it could have
// used and keep the one that reproduces the child exactly. Finding it is the
// verification.
function seedThatDerives(parent, child, rounds, salt) {
  for (let round = 1; round <= rounds; round++) {
    for (let ordinal = 0; ordinal < 16; ordinal++) {
      const seed = simulatedSeed(parent.root, ordinal, salt + round);
      if (genomeRoot(mutate(parent.genome, seed)) === child.root) {
        return { seed: seed, ordinal: ordinal, round: round };
      }
    }
  }
  throw new Error(
    "organism " +
      child.id +
      " could not be re-derived from organism " +
      parent.id +
      "; the lineage is not verifiable and will not be published"
  );
}

// Which genes the mutation actually touched. This is what a reader wants to
// see, and it is the one thing a diff of two 32-byte roots cannot show them.
function changedGenes(parentGenome, childGenome) {
  return GENES.filter(function (gene) {
    return parentGenome[gene.key] !== childGenome[gene.key];
  }).map(function (gene) {
    return {
      key: gene.key,
      from: parentGenome[gene.key],
      to: childGenome[gene.key],
    };
  });
}

function build() {
  const run = simulate({
    generations: ROUNDS,
    survivalThreshold: SURVIVAL_THRESHOLD,
    fecundityStep: FECUNDITY_STEP,
    baseFecundity: BASE_FECUNDITY,
    salt: SALT,
  });

  const byId = new Map(run.population.map((o) => [o.id, o]));
  const organisms = [];
  let trial = null;

  for (const o of run.population) {
    const scored = evaluate(o.genome);
    // The simulation and a fresh evaluation must agree. If they ever did not,
    // one of the two numbers on the page would be fiction.
    if (scored.fitnessBps !== o.fitnessBps) {
      throw new Error(
        "organism " + o.id + " does not reproduce its own score on re-evaluation"
      );
    }
    if (!trial) trial = scored.transcript.trial;

    const allowance = spawnAllowance(
      o.fitnessBps,
      SURVIVAL_THRESHOLD,
      FECUNDITY_STEP,
      BASE_FECUNDITY
    );

    const record = {
      id: o.id,
      parent: o.parent,
      generation: o.generation,
      phenotype: o.phenotype,
      genome: JSON.parse(canonical(o.genome)),
      genomeRoot: o.root,
      fitnessBps: o.fitnessBps,
      coverage: scored.transcript.result.coverage,
      accuracyWhenAnswering: scored.transcript.result.accuracyWhenAnswering,
      effectiveAccuracy: scored.transcript.result.effectiveAccuracy,
      evidenceRoot: scored.evidenceRoot,
      trialId: scored.trialId,
      offspring: o.offspring,
      allowance: allowance,
      deadEnd: allowance === 0,
      mutationSeed: null,
      seedOrdinal: null,
      changed: [],
    };

    if (o.parent !== 0) {
      const parent = byId.get(o.parent);
      if (!parent) throw new Error("organism " + o.id + " has a missing parent");
      const derived = seedThatDerives(parent, o, ROUNDS, SALT);
      record.mutationSeed = derived.seed;
      record.seedOrdinal = derived.ordinal;
      record.changed = changedGenes(parent.genome, o.genome);
    }

    organisms.push(record);
  }

  const best = organisms.reduce((a, b) => (b.fitnessBps > a.fitnessBps ? b : a));
  const founder = organisms.find((o) => o.parent === 0);

  return {
    generator: "scripts/gen-demo-data.js",
    generatedAt: new Date().toISOString(),
    // Stated plainly, because the viewer renders this when there is no
    // contract to read and it must never be mistaken for a chain.
    provenance:
      "Simulated lineage. Fitness is measured by engine/fitness.js against the " +
      "recorded corpus, and every child here was re-derived from its parent and " +
      "seed before publication. The seeds are simulated rather than block " +
      "hashes: nothing in this file has been on a chain.",
    selection: {
      survivalThreshold: SURVIVAL_THRESHOLD,
      fecundityStep: FECUNDITY_STEP,
      baseFecundity: BASE_FECUNDITY,
      rounds: ROUNDS,
      salt: SALT,
    },
    trial: trial,
    genes: geneCatalogue(),
    founderRoot: genomeRoot(FOUNDER),
    summary: {
      population: organisms.length,
      generations: Math.max.apply(null, organisms.map((o) => o.generation)),
      founderFitnessBps: founder.fitnessBps,
      bestId: best.id,
      bestFitnessBps: best.fitnessBps,
      bestPhenotype: best.phenotype,
      deadEnds: organisms.filter((o) => o.deadEnd).length,
      stillborn: run.history.filter((h) => h.outcome === "stillborn").length,
    },
    organisms: organisms,
  };
}

function main() {
  const dir = path.join(__dirname, "..", "web");
  fs.mkdirSync(dir, { recursive: true });

  const data = build();
  const json = JSON.stringify(data, null, 2) + "\n";
  fs.writeFileSync(path.join(dir, "demo-data.json"), json);

  // The JSON is the artifact. This twin exists only because a page opened
  // straight off the filesystem is forbidden to fetch() a sibling file, and
  // the demo has to survive being opened with a double click. Both are
  // written in one pass from one object, so they cannot disagree.
  fs.writeFileSync(
    path.join(dir, "demo-data.js"),
    "// Generated by scripts/gen-demo-data.js. Do not edit; edit the generator.\n" +
      "window.GERMLINE_DEMO = " +
      json.trimEnd() +
      ";\n"
  );

  const space = rootTable();
  fs.writeFileSync(
    path.join(dir, "genome-space.js"),
    "// Generated by scripts/gen-demo-data.js. Do not edit; edit the generator.\n" +
      "// Every genome mutate() can reach, keyed by genome root, so an on-chain\n" +
      "// root resolves to a readable configuration without trusting an index.\n" +
      "window.GERMLINE_GENOME_SPACE = " +
      JSON.stringify(space) +
      ";\n"
  );

  console.log(
    "web/demo-data.json     " +
      data.organisms.length +
      " organisms across " +
      data.summary.generations +
      " generations"
  );
  console.log("web/demo-data.js       same payload, loadable from file://");
  console.log("web/genome-space.js    " + space.count + " genomes enumerated");
  console.log(
    "founder " +
      data.summary.founderFitnessBps +
      " bps -> best " +
      data.summary.bestFitnessBps +
      " bps (" +
      data.summary.bestPhenotype +
      ")"
  );
}

main();
