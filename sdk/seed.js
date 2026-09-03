"use strict";

const { keccak256, toUtf8Bytes } = require("ethers");

// The seed for a run with no chain attached. It is derived exactly the way
// engine/evolve.js derives one, so a local run of the reference trial
// reproduces the engine's own simulation, and it carries the same
// "simulated:" label for the same reason: a lineage bred without a chain
// must never be mistaken for one a chain witnessed.
//
// The distinction is not bookkeeping. A local seed is chosen by whoever ran
// the loop, so nothing stops them running it a thousand times and publishing
// the flattering one. Only a seed taken from a block hash that did not exist
// when the commitment was made rules that out, and that is the single reason
// the chain half of this SDK exists.
function localSeed(parentRoot, ordinal, salt) {
  return keccak256(
    toUtf8Bytes("simulated:" + parentRoot + ":" + ordinal + ":" + salt)
  );
}

module.exports = { localSeed };
