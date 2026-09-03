"use strict";

// The on-chain plumbing optimise() needs, kept independent of Hardhat.
//
// lib/chain.js already has eventFrom, revertName and sleep, and they take
// nothing but a contract, a receipt, an error or a millisecond count -- none
// of the four functions there that need `hre` (loadDeployment,
// assertChainMatches) are needed here, because a product wires its own
// provider and signer to Germline.sol the way it would to any other
// contract and hands the connected instance to optimise() directly. So this
// file re-exports the three that are already generic and adds the one piece
// of polling logic optimise() and scripts/breed.js both need: waiting out a
// commitment until the block it named is mined.

const { eventFrom, revertName, sleep } = require("../lib/chain");

// mutationSeedFor reverts with TooEarly until the committed block has been
// mined, because until then its hash does not exist -- that is the mechanism
// working, not a failure, so it is polled rather than reported as one.
async function waitForSeed(contract, parentId, options = {}) {
  const tries = options.pollTries === undefined ? 40 : options.pollTries;
  const delay = options.pollMs === undefined ? 2000 : options.pollMs;
  const log = options.log;

  for (let attempt = 1; attempt <= tries; attempt++) {
    try {
      return await contract.mutationSeedFor(parentId);
    } catch (error) {
      const name = revertName(error);
      if (name === "RequestExpired") {
        throw new Error(
          "the commitment for organism " +
            parentId +
            " expired before its block could be read (more than 250 blocks " +
            "passed). Re-run to make a fresh commitment."
        );
      }
      if (name !== "TooEarly") throw error;
      if (log) {
        log(
          "  waiting for the seeding block for organism " +
            parentId +
            " (attempt " +
            attempt +
            " of " +
            tries +
            ")"
        );
      }
      await sleep(delay);
    }
  }
  throw new Error(
    "the seeding block for organism " +
      parentId +
      " was still unmined after " +
      tries +
      " attempts. The commitment stays usable for 250 blocks: try again once " +
      "the network is moving."
  );
}

module.exports = { waitForSeed, eventFrom, revertName, sleep };
