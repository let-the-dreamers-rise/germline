"use strict";

// 0G Storage, built against what the network actually exposes rather than
// what would be convenient.
//
// WHAT WAS ESTABLISHED, by probing the live mainnet indexer at
// https://indexer-storage-turbo.0g.ai on 2026-09-03:
//
//   GET  /file?root=0x000...   ->  200  {"code":101,"message":"File not found"}
//   POST /api/v1/upload        ->  404  page not found
//   GET  /                     ->  404  page not found
//
// So the download gateway is real and live: it answers a well-formed query
// for a root it does not hold with a proper 101, not an error. Reading from
// 0G Storage is therefore a genuine HTTP integration and is implemented here.
//
// There is no HTTP upload endpoint. The 404 above is the one a search result
// claimed would work, which is exactly why it was probed rather than trusted.
// The 0G docs are consistent with this: uploading submits data to the Flow
// contract on chain, builds a merkle tree over it, and distributes it to
// storage nodes chosen by the indexer. That is a protocol, not a POST, and
// the official 0g-storage-client is what implements it.
//
// We do not reimplement it. Hand-rolling a merkle-and-submit protocol against
// undocumented shapes would produce something that looks like an integration
// and silently is not. Instead, upload goes through official code, in order:
//
//   1. @0gfoundation/0g-storage-ts-sdk, the maintained TypeScript SDK, if it
//      is installed. In-process, no temp file, no binary on PATH.
//   2. the 0g-storage-client binary, if it is on PATH.
//   3. a local content-addressed store, reported as such.
//
// Every call says which of the three happened.
//
// Two older npm packages are deliberately not used. @0glabs/0g-ts-sdk is
// published as deprecated ("Package no longer supported") and installing it
// removed 386 packages from this project and broke the toolchain.
// @0gfoundation/0g-ts-sdk is deprecated in favour of the storage SDK above.
// The storage SDK pins ethers 6.13.1 as a peer, so it stays an optional peer
// rather than a hard dependency: a team that only wants local audit logs
// should not have to resolve that.
//
// WHY THE FALLBACK IS SAFE. An object's identity is the keccak256 of its
// canonical JSON, computed locally from bytes we hold. The chain records that
// root. So verification never depends on storage being reachable: an
// unpublished payload is an inconvenience, while a failed spawn would be a
// lost commitment. Availability and integrity are separate properties here,
// and only integrity is load-bearing.

const fs = require("fs");
const path = require("path");
const { execFile } = require("child_process");
const { keccak256, toUtf8Bytes } = require("ethers");

const GATEWAY = process.env.ZEROG_INDEXER || "https://indexer-storage-turbo.0g.ai";
const CHAIN_RPC = process.env.ZEROG_RPC || "https://evmrpc.0g.ai";
const CLIENT = process.env.ZEROG_STORAGE_CLIENT || "0g-storage-client";
// The local store lives in the working directory, not inside the package:
// once Germline is installed from npm, __dirname is inside node_modules, and
// an audit trail that disappears on the next `npm ci` is not an audit trail.
const LOCAL_DIR =
  process.env.GERMLINE_STORAGE_DIR || path.join(process.cwd(), ".germline", "storage");
const SDK_PACKAGE = "@0gfoundation/0g-storage-ts-sdk";
const TIMEOUT_MS = 15000;

function rootOf(bytes) {
  return keccak256(toUtf8Bytes(bytes));
}

function localPath(root) {
  return path.join(LOCAL_DIR, root + ".json");
}

function writeLocal(root, bytes) {
  fs.mkdirSync(LOCAL_DIR, { recursive: true });
  fs.writeFileSync(localPath(root), bytes, "utf8");
  return localPath(root);
}

function readLocal(root) {
  try {
    return fs.readFileSync(localPath(root), "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

function loadSdk() {
  try {
    return require(SDK_PACKAGE);
  } catch (error) {
    // Only an absent SDK falls through to the next path. One that is present
    // but broken is a real fault, reported rather than downgraded.
    if (error.code === "MODULE_NOT_FOUND" && String(error.message).includes(SDK_PACKAGE)) {
      return null;
    }
    throw error;
  }
}

/// The 0G Storage root of some bytes, computed locally by the official SDK.
///
/// This is the locator 0G will assign once the bytes are uploaded, known
/// before any transaction is sent. It lets a record carry where its payload
/// will live even when the upload happens later, or never. Null when the SDK
/// is not installed.
async function storageRootOf(bytes) {
  const sdk = loadSdk();
  if (!sdk) return null;
  const file = new sdk.MemData(Buffer.from(bytes, "utf8"));
  const [tree, error] = await file.merkleTree();
  if (error || !tree) return null;
  return tree.rootHash();
}

// Upload in process through the maintained SDK. The submission is an
// on-chain transaction to the Flow contract, paid by DEPLOYER_KEY.
async function uploadViaSdk(sdk, bytes) {
  const key = process.env.DEPLOYER_KEY;
  if (!key) {
    return { ok: false, note: "no DEPLOYER_KEY, and upload is an on-chain submission" };
  }
  try {
    const { JsonRpcProvider, Wallet } = require("ethers");
    const signer = new Wallet(key, new JsonRpcProvider(CHAIN_RPC));
    const indexer = new sdk.Indexer(GATEWAY);
    const file = new sdk.MemData(Buffer.from(bytes, "utf8"));
    const [result, error] = await indexer.upload(file, CHAIN_RPC, signer);
    if (error) {
      return { ok: false, note: "0G Storage SDK upload failed: " + String(error.message || error).slice(0, 160) };
    }
    // Small payloads come back as a single upload; anything the SDK chose to
    // split comes back as arrays. A Germline record is never large enough to
    // split, but read both shapes rather than assume.
    const reported = result.rootHash || (result.rootHashes && result.rootHashes[0]) || null;
    const txHash = result.txHash || (result.txHashes && result.txHashes[0]) || null;
    return { ok: true, reported, txHash, via: "sdk" };
  } catch (error) {
    return { ok: false, note: "0G Storage SDK upload failed: " + String(error.shortMessage || error.message).slice(0, 160) };
  }
}

// Upload through the official client, which is the documented mechanism. It
// needs a funded key because the submission is an on-chain transaction, so it
// stays opt-in rather than being attempted silently on every spawn.
function uploadViaClient(file) {
  return new Promise((resolve) => {
    const key = process.env.DEPLOYER_KEY;
    if (!key) {
      resolve({ ok: false, note: "no DEPLOYER_KEY, and upload is an on-chain submission" });
      return;
    }
    const args = [
      "upload",
      "--url", CHAIN_RPC,
      "--indexer", GATEWAY,
      "--key", key,
      "--file", file,
    ];
    execFile(CLIENT, args, { timeout: 120000 }, (error, stdout, stderr) => {
      if (error) {
        const missing = error.code === "ENOENT";
        resolve({
          ok: false,
          note: missing
            ? "0g-storage-client is not installed; see docs/STORAGE.md"
            : "0g-storage-client failed: " +
              String(stderr || error.message).trim().split("\n")[0].slice(0, 160),
        });
        return;
      }
      // The client prints the root hash it computed; surface it so a mismatch
      // with our own root is visible rather than assumed away.
      const found = String(stdout).match(/0x[0-9a-fA-F]{64}/);
      resolve({ ok: true, reported: found ? found[0] : null, txHash: null, via: "client" });
    });
  });
}

/// Publish one payload. Returns which path it took, never throws.
///
/// Called as publish(bytes, meta) so that lib/publish.js finds it, and the
/// bytes must be the exact serialisation the root is the hash of.
async function publish(bytes, meta = {}) {
  if (typeof bytes !== "string") {
    throw new Error("publish needs the exact bytes behind the root, as a string");
  }
  const root = meta.root || rootOf(bytes);
  const file = writeLocal(root, bytes);

  if (process.env.ZEROG_STORAGE_UPLOAD !== "1") {
    return {
      root,
      uri: "file://" + file,
      stored: "local",
      note: "set ZEROG_STORAGE_UPLOAD=1 to submit to 0G Storage via the official client",
    };
  }

  const sdk = loadSdk();
  const attempt = sdk ? await uploadViaSdk(sdk, bytes) : await uploadViaClient(file);
  if (!attempt.ok) {
    return { root, uri: "file://" + file, stored: "local", note: attempt.note };
  }
  if (attempt.reported && attempt.reported.toLowerCase() !== root.toLowerCase()) {
    // 0G computes its own merkle root over the file, which is a different
    // construction from our keccak of the canonical JSON. Both are recorded:
    // ours is the identity the chain carries, theirs is the storage locator.
    return {
      root,
      uri: GATEWAY + "/file?root=" + attempt.reported,
      storageRoot: attempt.reported,
      txHash: attempt.txHash,
      via: attempt.via,
      stored: "0g",
      note: "0G merkle root differs from the canonical keccak root, as expected",
    };
  }
  return {
    root,
    uri: GATEWAY + "/file?root=" + root,
    txHash: attempt.txHash,
    via: attempt.via,
    stored: "0g",
    note: null,
  };
}

/// Read a payload back. Local first, because a local hit is authoritative and
/// free; then the live 0G gateway.
async function fetchByRoot(root) {
  const local = readLocal(root);
  if (local !== null) return JSON.parse(local);

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    const response = await fetch(GATEWAY + "/file?root=" + root, {
      signal: controller.signal,
    });
    clearTimeout(timer);
    if (!response.ok) return null;
    const text = await response.text();
    // The gateway answers a miss with a 200 and a code 101 envelope rather
    // than a 404, so the status alone does not tell us whether we got a file.
    try {
      const parsed = JSON.parse(text);
      if (parsed && parsed.code === 101) return null;
      return parsed;
    } catch (error) {
      return null;
    }
  } catch (error) {
    return null;
  }
}

/// Whether the live gateway is reachable. Used by scripts/storage-check.js so
/// the integration can be demonstrated rather than asserted.
async function gatewayReachable() {
  const absent = "0x" + "0".repeat(64);
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    const response = await fetch(GATEWAY + "/file?root=" + absent, {
      signal: controller.signal,
    });
    clearTimeout(timer);
    const body = await response.text();
    return { reachable: response.ok, status: response.status, body: body.slice(0, 120) };
  } catch (error) {
    return { reachable: false, status: 0, body: error.message.slice(0, 120) };
  }
}

module.exports = {
  publish,
  fetchByRoot,
  gatewayReachable,
  rootOf,
  storageRootOf,
  sdkInstalled: () => loadSdk() !== null,
  GATEWAY,
  LOCAL_DIR,
};
