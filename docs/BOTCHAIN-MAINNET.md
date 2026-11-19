# Germline on BOT Chain mainnet

The anchor-only flow is live on BOT Chain mainnet (chain 677). Nothing in the
product or the contract changed for it: the same GermlineAnchor bytecode that
runs on 0G mainnet and on BOT's Bohr testnet.

| | |
|---|---|
| Network | BOT Chain mainnet, chain ID 677, RPC `https://rpc.botchain.ai` |
| Registry (GermlineAnchor) | [`0xA0448Cd63f746a60447cfF1817ec9781C25F7b25`](https://scan.botchain.ai/address/0xA0448Cd63f746a60447cfF1817ec9781C25F7b25) |
| Deploy tx | [`0xa7606129…99ad`](https://scan.botchain.ai/tx/0xa76061297162f41b9f516a7139e9727e19b3bec927fbc8933919b02f205399ad), block 29921453, 2026-11-11 19:32 UTC |
| First anchor tx | [`0x80432ae6…7d4f`](https://scan.botchain.ai/tx/0x80432ae642a3dfa94fad823924b99c664ec20dbc573b27161dccfd5003e37d4f), block 29921485, 94,754 gas |
| Deployer | [`0xA1918A4E578babad074ACf7DCefB152f8FDC8D2E`](https://scan.botchain.ai/address/0xA1918A4E578babad074ACf7DCefB152f8FDC8D2E) |

On BOT Chain mainnet this address holds GermlineAnchor. On 0G mainnet and Bohr
the same address holds the older Germline.sol lineage registry, because each was
the deployer's first contract on its chain. Always pin the chain with the address.

## Try it

- Web app with wallet connection: https://germline.vercel.app/anchor.html
- Verifier: https://germline.vercel.app/verify.html?network=botchain
- CLI: `GERMLINE_NETWORK=botchain npx germline@latest anchor` (see [BOTCHAIN-TRY-IT.md](BOTCHAIN-TRY-IT.md))
