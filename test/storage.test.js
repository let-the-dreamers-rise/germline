const { expect } = require("chai");
const fs = require("fs");
const os = require("os");
const path = require("path");

// The storage module without a network: where it writes, what it reports,
// and that the 0G root is computed by the official SDK when it is present.

describe("storage", function () {
  let storage;
  before(function () {
    process.env.GERMLINE_STORAGE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "germline-store-"));
    delete require.cache[require.resolve("../lib/storage")];
    storage = require("../lib/storage");
  });
  after(function () {
    delete process.env.GERMLINE_STORAGE_DIR;
    delete require.cache[require.resolve("../lib/storage")];
  });

  it("writes the local store outside the package directory", function () {
    expect(storage.LOCAL_DIR).to.equal(process.env.GERMLINE_STORAGE_DIR);
  });

  it("publishes locally and says so when upload is not enabled", async function () {
    const bytes = JSON.stringify({ probe: 1 });
    const result = await storage.publish(bytes);
    expect(result.stored).to.equal("local");
    expect(result.root).to.equal(storage.rootOf(bytes));
    expect(await storage.fetchByRoot(result.root)).to.deep.equal({ probe: 1 });
  });

  it("computes the 0G storage root with the official SDK when installed", async function () {
    const root = await storage.storageRootOf('{"a":1}');
    if (!storage.sdkInstalled()) {
      expect(root).to.equal(null);
      this.skip();
    }
    // Pinned from @0gfoundation/0g-storage-ts-sdk 1.2.13's MemData.merkleTree().
    expect(root).to.equal("0xc3461d53f33475744d557b5a22c73cd3c7e73fd1511e34fb08e96872c3e6ed08");
  });
});
