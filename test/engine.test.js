const { expect } = require("chai");
const { ethers } = require("hardhat");
const { FOUNDER, canonical, genomeRoot, validate } = require("../engine/genome");
const { mutate } = require("../engine/mutate");
const { evaluate } = require("../engine/fitness");
const { spawnAllowance, simulate } = require("../engine/evolve");

// Real chain seeds are 32 bytes; derive the test ones the same way so they
// are always exactly that long.
const SEED_A = ethers.keccak256(ethers.toUtf8Bytes("seed-a"));
const SEED_B = ethers.keccak256(ethers.toUtf8Bytes("seed-b"));

describe("engine", function () {
  describe("genome", function () {
    it("canonical form is stable under key order", function () {
      const shuffled = {
        backoff: FOUNDER.backoff,
        version: FOUNDER.version,
        minSupport: FOUNDER.minSupport,
        useRing: FOUNDER.useRing,
        ringSides: FOUNDER.ringSides,
        useColour: FOUNDER.useColour,
        unanimousOnly: FOUNDER.unanimousOnly,
        useSize: FOUNDER.useSize,
        useMomentum: FOUNDER.useMomentum,
      };
      expect(canonical(shuffled)).to.equal(canonical(FOUNDER));
      expect(genomeRoot(shuffled)).to.equal(genomeRoot(FOUNDER));
    });

    it("rejects a malformed genome", function () {
      expect(() => validate({ ...FOUNDER, minSupport: 99 })).to.throw();
      expect(() => validate({ ...FOUNDER, useRing: "yes" })).to.throw();
      expect(() => validate({ ...FOUNDER, ringSides: 16 })).to.throw();
    });
  });

  describe("heredity", function () {
    // This is the property the whole design rests on. If mutation were not a
    // pure function of parent and seed, nobody could check a lineage and the
    // chain would be storing claims rather than facts.
    it("the same parent and seed always give the same child", function () {
      const a = mutate(FOUNDER, SEED_A);
      const b = mutate(FOUNDER, SEED_A);
      expect(genomeRoot(a)).to.equal(genomeRoot(b));
    });

    it("a different seed gives a different child", function () {
      const a = mutate(FOUNDER, SEED_A);
      const b = mutate(FOUNDER, SEED_B);
      expect(genomeRoot(a)).to.not.equal(genomeRoot(b));
    });

    it("a forged child is detectable", function () {
      const honest = mutate(FOUNDER, SEED_A);
      const forged = { ...honest, useMomentum: !honest.useMomentum };
      expect(genomeRoot(forged)).to.not.equal(genomeRoot(honest));
    });

    it("a child differs from its parent", function () {
      const child = mutate(FOUNDER, SEED_A);
      expect(genomeRoot(child)).to.not.equal(genomeRoot(FOUNDER));
    });

    it("refuses a seed too short to have come from a chain", function () {
      expect(() => mutate(FOUNDER, "0xabcd")).to.throw();
    });

    it("keeps the genome coherent after mutation", function () {
      // A hundred descendants down a random walk, every one still valid.
      let genome = FOUNDER;
      let seed = SEED_A;
      for (let i = 0; i < 100; i++) {
        genome = mutate(genome, seed);
        validate(genome);
        if (genome.useRing) expect(genome.ringSides).to.be.greaterThan(0);
        else expect(genome.ringSides).to.equal(0);
        seed = ethers.keccak256(seed);
      }
    });
  });

  describe("fitness", function () {
    it("is reproducible for the same genome", function () {
      const a = evaluate(FOUNDER);
      const b = evaluate(FOUNDER);
      expect(a.fitnessBps).to.equal(b.fitnessBps);
      expect(a.evidenceRoot).to.equal(b.evidenceRoot);
    });

    it("the founder scores the action-only baseline", function () {
      const { fitnessBps, transcript } = evaluate(FOUNDER);
      expect(fitnessBps).to.equal(3148);
      // A predictor using nothing but the action IS the baseline, so its
      // effective accuracy and the baseline it falls back on must agree.
      expect(transcript.result.effectiveAccuracy).to.be.closeTo(
        transcript.result.baselineAccuracy,
        0.001
      );
    });

    it("a genome that reads momentum beats one that does not", function () {
      const deaf = evaluate(FOUNDER).fitnessBps;
      const hearing = evaluate({ ...FOUNDER, useMomentum: true }).fitnessBps;
      expect(hearing).to.be.greaterThan(deaf);
    });

    it("scores stay inside the scale the contract accepts", function () {
      let genome = FOUNDER;
      let seed = SEED_B;
      for (let i = 0; i < 25; i++) {
        const { fitnessBps } = evaluate(genome);
        expect(fitnessBps).to.be.at.least(0);
        expect(fitnessBps).to.be.at.most(10000);
        genome = mutate(genome, seed);
        seed = ethers.keccak256(seed);
      }
    });

    it("carries evidence that names the trial it used", function () {
      const { transcript, trialId } = evaluate(FOUNDER);
      expect(transcript.trial.id).to.equal(trialId);
      expect(transcript.trial.testRows).to.be.greaterThan(1000);
    });
  });

  describe("selection agrees with the contract", function () {
    it("allowance matches Germline.spawnAllowance across the range", async function () {
      const [curator, breeder] = await ethers.getSigners();
      const Germline = await ethers.getContractFactory("Germline");
      const survival = 3148;
      const step = 500;
      const base = 4;
      const germline = await Germline.deploy(survival, step, base);
      await germline.waitForDeployment();

      const scores = [0, 1000, 3147, 3148, 3648, 4765, 9999, 10000];
      for (let i = 0; i < scores.length; i++) {
        const root = ethers.keccak256(ethers.toUtf8Bytes("g" + i));
        await germline.connect(curator).seedFounder(root, breeder.address);
        const id = await germline.population();
        await germline
          .connect(curator)
          .attestFitness(
            id,
            scores[i],
            ethers.ZeroHash.slice(0, 2) + "1".repeat(64),
            ethers.keccak256(ethers.toUtf8Bytes("e" + i))
          );
        const onChain = Number(await germline.spawnAllowance(id));
        const offChain = spawnAllowance(scores[i], survival, step, base);
        expect(onChain, "score " + scores[i]).to.equal(offChain);
      }
    });
  });

  describe("evolution", function () {
    it("climbs away from the founder", function () {
      const run = simulate({ generations: 6 });
      expect(run.best.fitnessBps).to.be.greaterThan(run.founder.fitnessBps);
    });

    it("is reproducible from the same salt", function () {
      const a = simulate({ generations: 4, salt: "x" });
      const b = simulate({ generations: 4, salt: "x" });
      expect(a.best.root).to.equal(b.best.root);
      expect(a.population.length).to.equal(b.population.length);
    });

    it("produces dead ends as well as improvements", function () {
      // If every mutation helped, selection would be doing no work.
      const run = simulate({ generations: 6 });
      const worse = run.history.filter((h) => h.delta < 0);
      expect(worse.length).to.be.greaterThan(0);
    });
  });
});
