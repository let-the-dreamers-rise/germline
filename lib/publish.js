"use strict";

// Genomes and transcripts belong on 0G Storage: the chain carries the root,
// the payload lives where payloads belong. The uploader is a separate module,
// and a storage node can be unreachable at the exact moment a lineage is
// being extended.
//
// Neither may stop reproduction. The root is what makes a record checkable,
// and the root is computed here from bytes we hold, not by the uploader --
// an unpublished payload is an inconvenience, whereas a failed spawn is a
// lost commitment. So publishing is best effort, and every call reports which
// of the two paths it took so the operator is never left guessing whether the
// upload happened.

// The uploader's exact export name is not settled while it is being written,
// so accept any of the plausible ones rather than coupling four scripts to a
// guess.
const CANDIDATES = [
  "publishJson",
  "putJson",
  "uploadJson",
  "publish",
  "upload",
  "put",
  "store",
];

function loadStorage() {
  try {
    return require("./storage");
  } catch (error) {
    // Only an absent storage module is tolerated here. A module that exists
    // but fails to load is a real fault and must not be silently downgraded
    // to "0G Storage unavailable".
    const missing =
      error.code === "MODULE_NOT_FOUND" &&
      String(error.message).includes("'./storage'");
    if (missing) return null;
    throw error;
  }
}

function pick(storage) {
  if (!storage) return null;
  for (const name of CANDIDATES) {
    if (typeof storage[name] === "function") {
      return { name, fn: storage[name].bind(storage) };
    }
  }
  if (typeof storage === "function") return { name: "default", fn: storage };
  return null;
}

// The uploader may hand back a locator in any of several shapes. Take the
// first that looks like one rather than insisting on a contract it has not
// agreed to.
function locatorFrom(result) {
  if (!result) return null;
  if (typeof result === "string") return result;
  return (
    result.uri ||
    result.url ||
    result.rootHash ||
    result.root ||
    result.txHash ||
    null
  );
}

function unpublished(root, note) {
  return { published: false, root, locator: null, note };
}

/// Publish one payload. `bytes` must be the exact serialisation that `root`
/// is the hash of, so that whatever lands in storage can be checked against
/// what the chain recorded.
async function publish(item) {
  const { kind, name, root, bytes } = item;
  if (typeof bytes !== "string") {
    throw new Error("publish needs the exact bytes behind the root, as a string");
  }

  let storage;
  try {
    storage = loadStorage();
  } catch (error) {
    return unpublished(
      root,
      "lib/storage.js failed to load: " + (error.shortMessage || error.message)
    );
  }
  if (!storage) {
    return unpublished(root, "lib/storage.js is not present yet");
  }

  const chosen = pick(storage);
  if (!chosen) {
    return unpublished(
      root,
      "lib/storage.js exports nothing that looks like an uploader (looked for " +
        CANDIDATES.join(", ") +
        ")"
    );
  }

  try {
    const result = await chosen.fn(bytes, { kind, name, root });
    const locator = locatorFrom(result);
    return {
      published: true,
      root,
      locator,
      note: locator ? null : "uploaded, but the uploader returned no locator",
    };
  } catch (error) {
    return unpublished(
      root,
      "upload failed: " + (error.shortMessage || error.message)
    );
  }
}

/// One line an operator can read at a glance, whichever path was taken.
function describe(result) {
  if (result.published) {
    return result.locator ? result.locator : "published (no locator returned)";
  }
  return "not published (" + result.note + "); root recorded on chain regardless";
}

module.exports = { publish, describe, loadStorage };
