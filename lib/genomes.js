"use strict";

// The chain stores a genome root, not a genome. That is the right division of
// labour -- a 32-byte hash is cheap and permanent, and the configuration it
// names is neither -- but it leaves verification with a problem: to re-run a
// mutation you need the parent configuration itself, and asking the company
// that produced the lineage for it would defeat the entire point.
//
// So every configuration this project creates is written here, addressed by
// its own root. The file's bytes are exactly the bytes that root is the hash
// of, which means the mapping needs no index and no trust: keccak256 of the
// file must equal its own name, and get() refuses to hand back a file where
// it does not. A pretty-printed copy would be easier to read and impossible
// to check, so the canonical single-line form is what lands on disk.
//
// This directory belongs in version control. It is the half of the evidence
// the chain cannot hold.

const fs = require("fs");
const path = require("path");
const { keccak256, toUtf8Bytes } = require("ethers");
const { canonical, genomeRoot, validate } = require("../engine/genome");

// Tests and dry runs need a throwaway lineage that does not scribble on the
// real one, which is the only reason this is overridable. A real run never
// sets it.
function dir() {
  return process.env.GERMLINE_GENOMES || path.join(__dirname, "..", "genomes");
}

function normalise(root) {
  if (typeof root !== "string") {
    throw new Error("a genome root must be a hex string, got " + typeof root);
  }
  const lower = root.toLowerCase();
  if (!/^0x[0-9a-f]{64}$/.test(lower)) {
    throw new Error("a genome root must be 32 bytes of hex, got: " + root);
  }
  return lower;
}

function pathFor(root) {
  return path.join(dir(), normalise(root) + ".json");
}

/// Store a configuration under its own root. Returns where it went, so a
/// script can tell the operator what it just wrote.
function put(genome) {
  validate(genome);
  const root = genomeRoot(genome);
  const file = pathFor(root);
  fs.mkdirSync(dir(), { recursive: true });
  // No trailing newline: the file is the pre-image of its name, and a stray
  // byte would break that.
  fs.writeFileSync(file, canonical(genome), "utf8");
  return { root, path: file };
}

function has(root) {
  return fs.existsSync(pathFor(root));
}

/// Fetch the configuration behind a root, refusing anything that does not
/// hash back to the root it is filed under.
function get(root) {
  const wanted = normalise(root);
  const file = pathFor(wanted);
  if (!fs.existsSync(file)) {
    throw new Error(
      "no cached configuration for genome root " +
        wanted +
        "\nExpected it at " +
        file +
        "\nEvery script that creates a configuration writes one; if this " +
        "lineage was bred elsewhere, copy that file here before verifying."
    );
  }
  const raw = fs.readFileSync(file, "utf8");
  const actual = keccak256(toUtf8Bytes(raw));
  if (actual !== wanted) {
    throw new Error(
      "the cached configuration at " +
        file +
        " hashes to " +
        actual +
        ", not to the root it is filed under. The file has been edited; " +
        "delete it and restore the original, because as it stands it " +
        "cannot be the configuration the chain recorded."
    );
  }
  const genome = JSON.parse(raw);
  validate(genome);
  return genome;
}

/// Every root held locally, in no particular order.
function list() {
  const where = dir();
  if (!fs.existsSync(where)) return [];
  return fs
    .readdirSync(where)
    .filter((name) => /^0x[0-9a-f]{64}\.json$/.test(name))
    .map((name) => name.slice(0, name.length - ".json".length));
}

module.exports = { dir, pathFor, put, get, has, list };
