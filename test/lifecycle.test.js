"use strict";

// End-to-end exercise of the on-chain lifecycle scripts against an
// in-process chain: found the FOUNDER, breed one honest child, verify it,
// and -- the case that actually matters -- confirm that a forged child is
// caught rather than waved through.
//
// The scripts under test read their contract address from
// deployments/<network>.json and cache genomes under genomes/<root>.json.
// Both locations are overridable (GERMLINE_DEPLOYMENTS, GERMLINE_GENOMES)
// for exactly this reason: a test run must not read or write the real
// project state.

const { expect } = require("chai");
const hre = require("hardhat");
const { ethers } = hre;
const { mine } = require("@nomicfoundation/hardhat-network-helpers");
const fs = require("fs");
const os = require("os");
const path = require("path");

const { FOUNDER, genomeRoot } = require("../engine/genome");
const { evaluate } = require("../engine/fitness");
const { eventFrom } = require("../lib/chain");
const { found } = require("../scripts/found");
const { breed } = require("../scripts/breed");
const { verify } = require("../scripts/verify");

const SURVIVAL = 3148; // the measured action-only baseline; see engine/fitness.js
const STEP = 500;
const BASE = 4;

const noop = () => {};

// breed.js polls mutationSeedFor with a real setTimeout delay until the
// commitment's block is mined. Hardhat Network only advances a block for a
// transaction, so left alone the poll loop would spin until it gave up --
// something has to mine while it waits, the way a live chain ticks forward
// on its own. This runs a background miner alongside the given promise and
// stops it once that promise settles, either way.
async function withBlockPump(promise) {
  let stop = false;
  const pump = (async () => {
    while (!stop) {
      await new Promise((resolve) => setTimeout(resolve, 30));
      if (stop) break;
      try {
        await mine(1);
      } catch (error) {
        // The network can be mid-teardown by the time a trailing tick
        // fires; that is not a failure of the promise being pumped.
      }
    }
  })();
  try {
    return await promise;
  } finally {
    stop = true;
    await pump;
  }
}

describe("lifecycle scripts", function () {
  this.timeout(60000);

  let tmpDir, deploymentsDir, genomesDir, originalEnv;

  beforeEach(async function () {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "germline-lifecycle-"));
    deploymentsDir = path.join(tmpDir, "deployments");
    genomesDir = path.join(tmpDir, "genomes");

    originalEnv = {
      GERMLINE_DEPLOYMENTS: process.env.GERMLINE_DEPLOYMENTS,
      GERMLINE_GENOMES: process.env.GERMLINE_GENOMES,
      GERMLINE_POLL_MS: process.env.GERMLINE_POLL_MS,
      GERMLINE_SEED_TRIES: process.env.GERMLINE_SEED_TRIES,
      CONTRACT: process.env.CONTRACT,
      CHILD_ID: process.env.CHILD_ID,
      PARENT_ID: process.env.PARENT_ID,
    };
    process.env.GERMLINE_DEPLOYMENTS = deploymentsDir;
    process.env.GERMLINE_GENOMES = genomesDir;
    process.env.GERMLINE_POLL_MS = "30";
    process.env.GERMLINE_SEED_TRIES = "80";
    delete process.env.CONTRACT;
    delete process.env.CHILD_ID;
    delete process.env.PARENT_ID;

    const Germline = await ethers.getContractFactory("Germline");
    const germline = await Germline.deploy(SURVIVAL, STEP, BASE);
    await germline.waitForDeployment();
    const address = await germline.getAddress();
    const network = await ethers.provider.getNetwork();
    const [deployer] = await ethers.getSigners();

    fs.mkdirSync(deploymentsDir, { recursive: true });
    fs.writeFileSync(
      path.join(deploymentsDir, hre.network.name + ".json"),
      JSON.stringify(
        {
          network: hre.network.name,
          chainId: Number(network.chainId),
          address,
          deployTx: germline.deploymentTransaction().hash,
          deployer: deployer.address,
          survivalThreshold: SURVIVAL,
          fecundityStep: STEP,
          baseFecundity: BASE,
          deployedAt: new Date().toISOString(),
        },
        null,
        2
      )
    );

    this.germline = germline;
    this.address = address;
  });

  afterEach(function () {
    for (const [key, value] of Object.entries(originalEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("founds the FOUNDER genome at the measured baseline score", async function () {
    const result = await found({ log: noop });

    expect(result.id).to.equal(1);
    expect(result.genomeRoot).to.equal(genomeRoot(FOUNDER));
    expect(result.fitnessBps).to.equal(SURVIVAL);
    expect(result.allowance).to.equal(BASE);

    const onChain = await this.germline.organismOf(1);
    expect(onChain.genomeRoot).to.equal(genomeRoot(FOUNDER));
    const fitness = await this.germline.fitnessOf(1);
    expect(Number(fitness.score)).to.equal(SURVIVAL);
  });

  it("breeds one honest child that verify.js accepts as genuine", async function () {
    const founded = await found({ log: noop });
    expect(founded.id).to.equal(1);

    // About 8.5% of seeds mutate the founder into itself: flipping ringSides
    // while useRing is false is undone by the coherence rule, and breed()
    // correctly refuses to mint a duplicate. That is a real limitation of the
    // frozen mutation function (see engine/mutate.js), not of this test, and
    // the operator's remedy is the same as ours: the commitment is spent, the
    // next block fixes a fresh seed, try again. A stillbirth mints nothing,
    // so the first live child is still #2.
    let bred;
    for (let attempt = 1; ; attempt++) {
      try {
        bred = await withBlockPump(breed({ log: noop }));
        break;
      } catch (error) {
        if (!/stillborn/.test(String(error.message)) || attempt >= 8) throw error;
      }
    }
    expect(bred.parentId).to.equal(1);
    expect(bred.childId).to.equal(2);
    expect(bred.recordedSeed.toLowerCase()).to.equal(bred.seed.toLowerCase());

    const onChain = await this.germline.organismOf(2);
    expect(onChain.parent).to.equal(1n);
    expect(onChain.genomeRoot).to.equal(bred.childRoot);

    const result = await verify({ childId: 2, log: noop });
    expect(result.genuine).to.equal(true);
    expect(result.mismatches).to.deep.equal([]);
    expect(result.heredity.holds).to.equal(true);
    expect(result.fitness.scoreHolds).to.equal(true);
    expect(result.fitness.evidenceHolds).to.equal(true);
  });

  it("rejects a forged child whose genome root does not match its recorded seed", async function () {
    await found({ log: noop });
    const germline = this.germline;

    // Commit and reveal exactly like breed.js does, but hand back a genome
    // that is real and honestly measurable -- just not the one the recorded
    // seed derives. spawn() cannot catch this itself: the seed is the
    // contract's, but the revealed root is the breeder's, and only
    // re-running mutate() off chain catches a mismatch between the two.
    await germline.requestSpawn(1);
    await mine(1); // one block is enough to clear TooEarly

    const forgedGenome = {
      ...FOUNDER,
      useColour: true,
      useSize: true,
      useRing: true,
      ringSides: 15,
      useMomentum: true,
      unanimousOnly: true,
      backoff: true,
    };
    const forgedRoot = genomeRoot(forgedGenome);
    expect(await germline.genomeSeen(forgedRoot)).to.equal(false);

    const spawnTx = await germline.spawn(1, forgedRoot);
    const spawnReceipt = await spawnTx.wait();
    const spawned = eventFrom(germline, spawnReceipt, "Spawned");
    const forgedId = Number(spawned.id);
    expect(forgedId).to.equal(2);

    // Attest the forged genome's own true fitness, so the forgery under
    // test is specifically about descent -- this really is a genome in
    // organism 1's reachable space, honestly scored -- and not a second,
    // separate lie about fitness layered on top.
    const measured = evaluate(forgedGenome);
    await germline.attestFitness(
      forgedId,
      measured.fitnessBps,
      measured.trialId,
      measured.evidenceRoot
    );

    let caught = null;
    try {
      await verify({ childId: forgedId, log: noop });
    } catch (error) {
      caught = error;
    }

    expect(caught).to.not.equal(null);
    expect(caught.result.genuine).to.equal(false);
    expect(caught.result.mismatches).to.include("heredity");
    expect(caught.result.heredity.holds).to.equal(false);
    expect(caught.result.heredity.onChainRoot).to.equal(forgedRoot);
    // The seed itself is exactly what the contract computed -- only the
    // revealed root is forged -- so the seed re-derivation still checks out.
    expect(caught.result.seed.holds).to.equal(true);
    // Likewise the fitness figures are honest, so they must still verify:
    // the forgery this test exercises is heredity, and heredity alone.
    expect(caught.result.fitness.scoreHolds).to.equal(true);
    expect(caught.result.fitness.evidenceHolds).to.equal(true);
  });
});
