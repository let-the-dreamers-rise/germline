# Germline on BOT Chain testnet (Bohr)

Run on 30 October 2026, from a clean checkout of the `add-botchain-networks` branch, with the same scripts used on 0G mainnet. Nothing in the contract changed.

## Result

| | |
|---|---|
| Network | BOT Chain Bohr testnet, chain id 968 |
| Contract | [0xA0448Cd63f746a60447cfF1817ec9781C25F7b25](https://scan.bohr.life/address/0xA0448Cd63f746a60447cfF1817ec9781C25F7b25) |
| Deploy transaction | [0x3ff90866…0f67](https://scan.bohr.life/tx/0x3ff908667e432b2875cb19c4ec86035a5276b935241a7c8a67f701b5786a0f67) |
| Population | 8 organisms over 3 generations (1 founder, 7 children) |
| Independent re-verification | 7 of 7 children: heredity, seed and score all VERIFIED, verdict GENUINE |
| Contract changes needed for BOT Chain | None (EVM target `paris`, 11,381 bytes) |
| Script changes needed | One: handle BOT Chain's revert format and its fast blocks (below) |
| Cost | 0.112 tBOT for the whole run, deploy and 14 commitments included |

The contract has the same address on BOT testnet as on 0G mainnet, because the same deployer made it as its first transaction on each chain.

## One full lifecycle, with transactions

1. Found: [seedFounder](https://scan.bohr.life/tx/0x8b34181b0dea38df1a3e9ee33281c100de649cc32539536a23d2ee2ce177e897), then [attestFitness](https://scan.bohr.life/tx/0x7b4156fc8f99b5f069e262a908f1a6f5eac7b0bfd438ecb436f8a8622f5da8c7) at 3,148 bps.
2. Commit: [requestSpawn](https://scan.bohr.life/tx/0xcd6c80981383ea86d6b8777fe86d11156e0aa48648d10db4b9e4344735d05647) from organism 1 in block 28,722,725. At that moment the seed cannot be known, because it depends on that block's hash.
3. Reveal: seed `0xec427a14…e06e` = keccak(parent root, blockhash(28722725), parent id, ordinal). The only child that seed allows was minted as organism 2 by [spawn](https://scan.bohr.life/tx/0x96f3597ed6ab7eacb689aed6351eff55b8a118fca4ab75075af3a93f0b271512) and scored by [attestFitness](https://scan.bohr.life/tx/0xc5b6d1a15d3dd48942ecf4f791c31ac3980cd3197bfa3e164caab1858255241a).
4. Verify: `CHILD_ID=2 npx hardhat run scripts/verify.js --network bohr` re-reads the block hash from the chain, recomputes the seed, re-derives the child genome and re-runs its fitness trial. All four checks match.

Every child's spawn transaction:

| Child | Parent | Request block | Spawn block | Spawn tx |
|---|---|---|---|---|
| 2 | 1 | 28,722,725 | 28,722,728 | [0x96f3597e…1512](https://scan.bohr.life/tx/0x96f3597ed6ab7eacb689aed6351eff55b8a118fca4ab75075af3a93f0b271512) |
| 3 | 1 | 28,722,871 | 28,722,875 | [0xc5edfaed…97df](https://scan.bohr.life/tx/0xc5edfaeda5ab3ab20838dd059d69ad912fc54896e5260cb69740c9d5137697df) |
| 4 | 3 | 28,722,988 | 28,722,991 | [0x629dc5ff…71e2](https://scan.bohr.life/tx/0x629dc5ff97c0c0fed6d8cef9f45b04c324db69865c8ac051d7d57832c92f71e2) |
| 5 | 3 | 28,723,037 | 28,723,040 | [0x27f34756…6ce9](https://scan.bohr.life/tx/0x27f3475686662c2daa91f46d953f3a49cf9a6fc2e2a0f9c373276efe77f16ce9) |
| 6 | 3 | 28,723,123 | 28,723,129 | [0x1735fd80…8a64](https://scan.bohr.life/tx/0x1735fd80e98712578142466c9011881abacd1e8b514889b33d80bb5fc0948a64) |
| 7 | 3 | 28,723,151 | 28,723,154 | [0x800a6f34…2d8b](https://scan.bohr.life/tx/0x800a6f340416cb47c2f93a8efeb8d62f5d263d0c0dbdf64176a221e3bed62d8b) |
| 8 | 3 | 28,723,172 | 28,723,177 | [0x134bebe3…483d](https://scan.bohr.life/tx/0x134bebe3a84ead5be39cb05be8ea3a32475a678042b509fa86c04e0d74c3483d) |

The best child so far is organism 3, +1,368 bps over its parent. Five of its own children scored lower than it did, and they are recorded anyway: the lineage keeps the bad rolls.

## What the run says about randomness on BOT Chain

- **Block producers.** In 600 consecutive blocks (28,722,605 to 28,723,204) there were 7 distinct producers, each making between 80 and 96 blocks, so production rotates evenly. A single producer makes about 1 block in 7.
- **The trust assumption.** The seed is unknowable to the breeder at commit time. The producer of the request block could in principle influence its hash by choosing which transactions to include, so Germline's randomness holds as long as that producer is not colluding with the breeder. With 7 rotating producers, a breeder cannot pick which one seals their block. This is the same assumption Germline makes on 0G, and it is written down in SECURITY.md rather than hidden.
- **Abandoned seeds are public.** A breeder can still walk away from a seed and commit again. Every commitment emits `SpawnRequested`, so walking away shows up on-chain. This run made 14 commitments and 7 children. Of the other 7, 2 seeds produced a genome that already existed (the contract refuses duplicates) and 5 were lost to the script issue below, before it was fixed. Anyone can count these from the contract's event log.
- **Reveal window.** Blocks averaged 0.750 s. The 250-block window to reveal a seed is about 3 minutes 7 seconds on BOT Chain (several minutes on 0G, whose blocks are slower). Every reveal in this run landed 3 to 6 blocks after its commitment, under 5 seconds, so the window is ample for the script, though a human doing it by hand would need to be quick.

## The one thing BOT Chain needed

The first breeding attempts sometimes stopped with `execution reverted: 0x085de625`. Two things combine:

1. BOT Chain's RPC returns a contract's custom error as bare revert data. ethers could not name it, so the script did not recognise `0x085de625` as `TooEarly`, the error the contract uses to say "the seeding block has not been mined yet".
2. With 0.75 s blocks, the script often asked for the seed while the request block was still the latest block. That is the contract working as designed; on 0G the next block had usually arrived by then.

The fix (commits on this branch) teaches `revertName` the contract's error selectors and retries the reveal on `TooEarly`. Retrying is safe because the seed is fixed by then, so a retry can only mint the one child that seed allows. After the fix, 4 further commitments produced 3 children and 1 duplicate genome, with no failures; the script waited through `TooEarly` twice.

## Reproduce

```
git checkout add-botchain-networks && npm install
# fund the deployer from https://faucet.botchain.ai/en/basic
npx hardhat run scripts/preflight.js --network bohr
npx hardhat run scripts/status.js --network bohr      # read-only, uses deployments/bohr.json
CHILD_ID=3 npx hardhat run scripts/verify.js --network bohr
```

`verify.js` and `status.js` need no key and no tokens, so anyone can check this deployment.
