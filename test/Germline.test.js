const { expect } = require("chai");
const { ethers } = require("hardhat");
const { mine } = require("@nomicfoundation/hardhat-network-helpers");

// The engine measures an action-only predictor at 3148 bps on the shipped
// corpus, so that is the bar an organism must clear to be worth breeding.
const SURVIVAL = 3148;
const STEP = 500; // each 5 points of effective accuracy buys another child
const BASE = 4; // offspring a merely-viable organism gets

function root(label) {
  return ethers.keccak256(ethers.toUtf8Bytes(label));
}

async function deploy(base = BASE) {
  const [curator, breeder, stranger] = await ethers.getSigners();
  const Germline = await ethers.getContractFactory("Germline");
  const germline = await Germline.deploy(SURVIVAL, STEP, base);
  await germline.waitForDeployment();
  return { germline, curator, breeder, stranger };
}

// Found an organism and give it a measured score so it may breed.
async function foundFit(germline, curator, steward, score, label = "founder") {
  await germline.connect(curator).seedFounder(root(label), steward.address);
  const id = await germline.population();
  await germline
    .connect(curator)
    .attestFitness(id, score, root("trial"), root("evidence"));
  return id;
}

describe("Germline", function () {
  describe("founding", function () {
    it("mints generation zero with no parent", async function () {
      const { germline, curator, breeder } = await deploy();
      await germline.connect(curator).seedFounder(root("g0"), breeder.address);
      const org = await germline.organismOf(1);
      expect(org.generation).to.equal(0);
      expect(org.parent).to.equal(0);
      expect(org.mutationSeed).to.equal(ethers.ZeroHash);
      expect(await germline.ownerOf(1)).to.equal(breeder.address);
    });

    it("refuses a genome that already exists", async function () {
      const { germline, curator, breeder } = await deploy();
      await germline.connect(curator).seedFounder(root("g0"), breeder.address);
      await expect(
        germline.connect(curator).seedFounder(root("g0"), breeder.address)
      ).to.be.revertedWithCustomError(germline, "GenomeAlreadyUsed");
    });

    it("only the curator may found", async function () {
      const { germline, breeder } = await deploy();
      await expect(
        germline.connect(breeder).seedFounder(root("g0"), breeder.address)
      ).to.be.revertedWithCustomError(germline, "NotCurator");
    });
  });

  describe("selection", function () {
    it("an unmeasured organism is barren", async function () {
      const { germline, curator, breeder } = await deploy();
      await germline.connect(curator).seedFounder(root("g0"), breeder.address);
      expect(await germline.spawnAllowance(1)).to.equal(0);
      await expect(
        germline.connect(breeder).requestSpawn(1)
      ).to.be.revertedWithCustomError(germline, "Barren");
    });

    it("an organism below the survival threshold leaves no descendants", async function () {
      const { germline, curator, breeder } = await deploy();
      await foundFit(germline, curator, breeder, SURVIVAL - 1);
      expect(await germline.spawnAllowance(1)).to.equal(0);
    });

    it("a merely-viable organism still gets several attempts", async function () {
      // One attempt would end most lines on their first bad mutation, and
      // selection would never get to choose between anything.
      const { germline, curator, breeder } = await deploy();
      await foundFit(germline, curator, breeder, SURVIVAL);
      expect(await germline.spawnAllowance(1)).to.equal(BASE);
    });

    it("fitness above the threshold buys further offspring", async function () {
      const { germline, curator, breeder } = await deploy();
      await foundFit(germline, curator, breeder, SURVIVAL + STEP * 3);
      expect(await germline.spawnAllowance(1)).to.equal(BASE + 3);
    });

    it("rejects a score outside the scale", async function () {
      const { germline, curator, breeder } = await deploy();
      await germline.connect(curator).seedFounder(root("g0"), breeder.address);
      await expect(
        germline.connect(curator).attestFitness(1, 10001, root("t"), root("e"))
      ).to.be.revertedWithCustomError(germline, "ScoreOutOfRange");
    });

    it("refuses a score with no evidence behind it", async function () {
      const { germline, curator, breeder } = await deploy();
      await germline.connect(curator).seedFounder(root("g0"), breeder.address);
      await expect(
        germline
          .connect(curator)
          .attestFitness(1, 9000, root("t"), ethers.ZeroHash)
      ).to.be.revertedWithCustomError(germline, "NoSuchOrganism");
    });

    it("only an attestor may score", async function () {
      const { germline, curator, breeder, stranger } = await deploy();
      await germline.connect(curator).seedFounder(root("g0"), breeder.address);
      await expect(
        germline
          .connect(stranger)
          .attestFitness(1, 9000, root("t"), root("e"))
      ).to.be.revertedWithCustomError(germline, "NotAttestor");
    });
  });

  describe("reproduction", function () {
    it("cannot spawn without committing first", async function () {
      const { germline, curator, breeder } = await deploy();
      await foundFit(germline, curator, breeder, SURVIVAL);
      await expect(
        germline.connect(breeder).spawn(1, root("child"))
      ).to.be.revertedWithCustomError(germline, "NoPendingRequest");
    });

    it("cannot spawn in the same block as the commitment", async function () {
      const { germline, curator, breeder } = await deploy();
      await foundFit(germline, curator, breeder, SURVIVAL);
      // Both calls land in one block, so blockhash(requestBlock) is still
      // zero and the seed would be forgeable. The spawn must fail.
      await ethers.provider.send("evm_setAutomine", [false]);
      await germline.connect(breeder).requestSpawn(1);
      const tx = await germline.connect(breeder).spawn(1, root("child"));
      await mine(1);
      await ethers.provider.send("evm_setAutomine", [true]);

      const receipt = await ethers.provider.getTransactionReceipt(tx.hash);
      expect(receipt.status).to.equal(0);
      // And no child was born.
      expect(await germline.population()).to.equal(1);
    });

    it("mints a child once the seeding block is mined", async function () {
      const { germline, curator, breeder } = await deploy();
      await foundFit(germline, curator, breeder, SURVIVAL);
      await germline.connect(breeder).requestSpawn(1);
      await mine(1);
      await germline.connect(breeder).spawn(1, root("child"));

      const child = await germline.organismOf(2);
      expect(child.parent).to.equal(1);
      expect(child.generation).to.equal(1);
      expect(child.genomeRoot).to.equal(root("child"));
      expect(child.mutationSeed).to.not.equal(ethers.ZeroHash);

      const parent = await germline.organismOf(1);
      expect(parent.offspring).to.equal(1);
    });

    it("the seed matches what the contract published before the reveal", async function () {
      const { germline, curator, breeder } = await deploy();
      await foundFit(germline, curator, breeder, SURVIVAL);
      await germline.connect(breeder).requestSpawn(1);
      await mine(1);

      // A breeder can read the seed, derive the child honestly, then reveal.
      const promised = await germline.mutationSeedFor(1);
      await germline.connect(breeder).spawn(1, root("child"));
      const child = await germline.organismOf(2);
      expect(child.mutationSeed).to.equal(promised);
    });

    it("the seed is unknowable while the commitment is fresh", async function () {
      const { germline, curator, breeder } = await deploy();
      await foundFit(germline, curator, breeder, SURVIVAL);
      await germline.connect(breeder).requestSpawn(1);
      await expect(
        germline.mutationSeedFor(1)
      ).to.be.revertedWithCustomError(germline, "TooEarly");
    });

    it("a commitment expires once its block hash falls out of reach", async function () {
      const { germline, curator, breeder } = await deploy();
      await foundFit(germline, curator, breeder, SURVIVAL);
      await germline.connect(breeder).requestSpawn(1);
      await mine(300);
      await expect(
        germline.connect(breeder).spawn(1, root("child"))
      ).to.be.revertedWithCustomError(germline, "RequestExpired");
    });

    it("two children of one parent get different seeds", async function () {
      const { germline, curator, breeder } = await deploy();
      await foundFit(germline, curator, breeder, SURVIVAL + STEP);
      await germline.connect(breeder).requestSpawn(1);
      await mine(1);
      await germline.connect(breeder).spawn(1, root("childA"));
      await germline.connect(breeder).requestSpawn(1);
      await mine(1);
      await germline.connect(breeder).spawn(1, root("childB"));

      const a = await germline.organismOf(2);
      const b = await germline.organismOf(3);
      expect(a.mutationSeed).to.not.equal(b.mutationSeed);
    });

    it("a parent cannot exceed the offspring it has earned", async function () {
      const { germline, curator, breeder } = await deploy(1);
      await foundFit(germline, curator, breeder, SURVIVAL); // allowance 1
      await germline.connect(breeder).requestSpawn(1);
      await mine(1);
      await germline.connect(breeder).spawn(1, root("childA"));
      expect(await germline.remainingOffspring(1)).to.equal(0);
      await expect(
        germline.connect(breeder).requestSpawn(1)
      ).to.be.revertedWithCustomError(germline, "Barren");
    });

    it("a child inherits no fitness and so cannot immediately breed", async function () {
      const { germline, curator, breeder } = await deploy();
      await foundFit(germline, curator, breeder, SURVIVAL);
      await germline.connect(breeder).requestSpawn(1);
      await mine(1);
      await germline.connect(breeder).spawn(1, root("child"));
      expect(await germline.spawnAllowance(2)).to.equal(0);
    });

    it("only the steward may breed from an organism", async function () {
      const { germline, curator, breeder, stranger } = await deploy();
      await foundFit(germline, curator, breeder, SURVIVAL);
      await expect(
        germline.connect(stranger).requestSpawn(1)
      ).to.be.revertedWithCustomError(germline, "NotSteward");
    });

    it("a duplicate genome cannot be born", async function () {
      const { germline, curator, breeder } = await deploy();
      await foundFit(germline, curator, breeder, SURVIVAL + STEP);
      await germline.connect(breeder).requestSpawn(1);
      await mine(1);
      await expect(
        germline.connect(breeder).spawn(1, root("founder"))
      ).to.be.revertedWithCustomError(germline, "GenomeAlreadyUsed");
    });
  });

  describe("lineage", function () {
    it("walks back to the founder", async function () {
      const { germline, curator, breeder } = await deploy();
      await foundFit(germline, curator, breeder, SURVIVAL);
      await germline.connect(breeder).requestSpawn(1);
      await mine(1);
      await germline.connect(breeder).spawn(1, root("c1"));
      await germline
        .connect(curator)
        .attestFitness(2, SURVIVAL, root("trial"), root("e2"));
      await germline.connect(breeder).requestSpawn(2);
      await mine(1);
      await germline.connect(breeder).spawn(2, root("c2"));

      const chain = await germline.lineageOf(3, 10);
      expect(chain.map(Number)).to.deep.equal([3, 2, 1]);
      expect((await germline.organismOf(3)).generation).to.equal(2);
    });

    it("respects the walk limit", async function () {
      const { germline, curator, breeder } = await deploy();
      await foundFit(germline, curator, breeder, SURVIVAL);
      await germline.connect(breeder).requestSpawn(1);
      await mine(1);
      await germline.connect(breeder).spawn(1, root("c1"));
      const chain = await germline.lineageOf(2, 1);
      expect(chain.map(Number)).to.deep.equal([2]);
    });
  });

  describe("agentic id", function () {
    it("the steward may bind an ERC-7857 token", async function () {
      const { germline, curator, breeder } = await deploy();
      await germline.connect(curator).seedFounder(root("g0"), breeder.address);
      await germline.connect(breeder).linkAgenticId(1, 42);
      expect((await germline.organismOf(1)).agenticId).to.equal(42);
    });

    it("a stranger may not", async function () {
      const { germline, curator, breeder, stranger } = await deploy();
      await germline.connect(curator).seedFounder(root("g0"), breeder.address);
      await expect(
        germline.connect(stranger).linkAgenticId(1, 42)
      ).to.be.revertedWithCustomError(germline, "NotSteward");
    });
  });
});
