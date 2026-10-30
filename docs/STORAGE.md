# 0G Storage

What is implemented, what is not, and how each was established. Written to be
checked rather than believed.

## What was probed, and what came back

Against the live mainnet indexer `https://indexer-storage-turbo.0g.ai`, on
2026-09-03. Reproduce with `node scripts/storage-check.js`.

| request | response |
|---|---|
| `GET /file?root=0x000…000` | `200` `{"code":101,"message":"File not found","data":null}` |
| `POST /api/v1/upload` | `404 page not found` |
| `GET /api/v1/upload` | `404 page not found` |
| `GET /` | `404 page not found` |
| `GET /nodes` | `404 page not found` |

Two conclusions follow, and they point in opposite directions.

**The download gateway is real.** A well-formed query for a root the network
does not hold returns a proper `101` envelope rather than an error page. That
is a live service answering correctly, so reading from 0G Storage is a genuine
HTTP integration and is implemented in `lib/storage.js`.

**There is no HTTP upload endpoint.** `POST /api/v1/upload` is the path a web
search confidently reported would work. It 404s. That is the whole reason it
was probed rather than trusted, and it is worth stating plainly because an
integration written against it would have looked complete and silently done
nothing.

## Why upload is not a POST

The 0G documentation is consistent with the probe. Uploading submits the data
to the Flow contract on chain, builds a merkle tree over the file, and
distributes it to storage nodes selected by the indexer according to their
shard configuration. It is a protocol involving a funded transaction, not a
form post, and `0g-storage-client` is the official implementation of it.

So Germline does not reimplement it. Hand-rolling a merkle-and-submit protocol
against undocumented message shapes, in a few hours, would produce something
that resembles an integration and is not one. That is a worse outcome than an
honest gap, because nobody would find out until it mattered.

The npm package `@0glabs/0g-ts-sdk` is also deliberately unused. It is
published as deprecated -- "Package no longer supported" -- and installing it
removed 386 packages from this project and broke the toolchain outright.

## What `lib/storage.js` actually does

```
publish(bytes, meta) -> { root, uri, stored: '0g' | 'local', note }
fetchByRoot(root)    -> object | null
gatewayReachable()   -> { reachable, status, body }
```

**Reading** goes local first, because a local hit is authoritative and free,
then to the live gateway at `GET /file?root=`. One subtlety worth knowing: the
gateway answers a miss with `200` and a `code: 101` envelope rather than a
`404`, so status alone does not tell you whether a file came back. The code
checks the envelope.

**Writing** always writes the local content-addressed store, and additionally
submits through `0g-storage-client` when `ZEROG_STORAGE_UPLOAD=1` and a funded
`DEPLOYER_KEY` is present. Upload stays opt-in precisely because it spends
gas, and silently spending a user's tokens on every spawn would be rude.

Every call reports which path it took. There is no mode in which the operator
has to guess whether the upload happened.

## Why the fallback does not weaken the claim

This is the part that matters, and it is a design property rather than an
excuse.

An object's identity is `keccak256` of its canonical JSON, computed locally
from bytes we already hold. That root is what the chain records, and it is
what `scripts/verify.js` re-derives. Verification therefore never depends on
any storage network being reachable.

Availability and integrity are separate properties, and only integrity is
load-bearing here. An unpublished payload is an inconvenience -- someone else
cannot fetch it. A failed spawn would be a lost commitment. So publishing is
best-effort by design, and `lib/publish.js` will never let a storage outage
break reproduction.

Note that 0G computes its own merkle root over a file, which is a different
construction from our keccak over canonical JSON. When both exist, both are
recorded: ours is the identity the chain carries, theirs is the storage
locator.

## Uploading for real

Upload tries, in order:

1. **`@0gfoundation/0g-storage-ts-sdk`**, the maintained TypeScript SDK, in
   process: `new MemData(bytes)` then `Indexer.upload(file, rpc, signer)`. No
   temp file, no binary. It pins `ethers` 6.13.1 as a peer, so install it with
   `npm install @0gfoundation/0g-storage-ts-sdk --legacy-peer-deps`; it works
   with the ethers 6.17 this project uses. It is an optional peer rather than
   a dependency so a team that only wants local audit logs never meets that.
2. **`0g-storage-client`** on PATH, as before.
3. **Local**, at `.germline/storage/` in the working directory (override with
   `GERMLINE_STORAGE_DIR`). It used to sit inside the package directory,
   which is inside `node_modules` once installed from npm.

```bash
# audit trail: publish the log and anchor its head
DEPLOYER_KEY=0x... npx germline anchor --upload

# lineage scripts
export ZEROG_STORAGE_UPLOAD=1
npx hardhat run scripts/found.js --network zerog
```

With the SDK installed, `storageRootOf(bytes)` computes the 0G merkle root
locally before anything is sent, so a record can carry its storage locator
even if the upload happens later. `test/storage.test.js` pins that root
against the SDK's own output.

Without either uploader, the same commands run and report what happened,
storing locally. Nothing breaks either way, which is the point.

## Honest summary

- 0G Storage **read**: implemented against the live mainnet gateway, verified.
- 0G Storage **write**: in process through the maintained TS SDK, or the
  official client binary. Opt-in. Root computation is tested; a real mainnet
  upload still needs a funded key and has not been run. Falls back to local,
  loudly.
- 0G **Chain**: fully integrated. This is where the load-bearing state lives.
