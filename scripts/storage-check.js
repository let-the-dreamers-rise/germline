// Demonstrate the 0G Storage integration rather than claiming it.
//
//   node scripts/storage-check.js
//
// Proves three things in order: the live mainnet gateway answers, a payload
// round-trips through publish and fetchByRoot, and a root nobody has stored
// comes back as a miss rather than as silence.

const { publish, fetchByRoot, gatewayReachable, rootOf, GATEWAY } = require("../lib/storage");

async function main() {
  console.log("gateway: " + GATEWAY);

  const probe = await gatewayReachable();
  console.log(
    "  live:    " +
      (probe.reachable ? "yes" : "no") +
      "  (HTTP " + probe.status + ")  " + probe.body
  );

  const payload = {
    kind: "germline.storage-check",
    note: "round-trip probe, not part of any lineage",
    genes: ["useColour", "useMomentum"],
  };
  const bytes = JSON.stringify(payload);
  const expected = rootOf(bytes);

  const result = await publish(bytes, { kind: "probe", name: "storage-check" });
  console.log("");
  console.log("published:");
  console.log("  root:    " + result.root);
  console.log("  stored:  " + result.stored);
  console.log("  uri:     " + result.uri);
  if (result.note) console.log("  note:    " + result.note);

  if (result.root !== expected) {
    console.error("");
    console.error("root mismatch: the identity is not reproducible from the bytes");
    process.exitCode = 1;
    return;
  }

  const back = await fetchByRoot(result.root);
  const same = JSON.stringify(back) === bytes;
  console.log("");
  console.log("round trip: " + (same ? "identical" : "MISMATCH"));

  const absent = await fetchByRoot("0x" + "1".repeat(64));
  console.log("unknown root returns: " + (absent === null ? "null, as it should" : "something unexpected"));

  if (!same || absent !== null) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
