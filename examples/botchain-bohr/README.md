# Anchor-only audit log on BOT Chain testnet (Bohr)

`audit.jsonl` is a sanitized demo log: two config changes to an example support agent, anchored once on BOT Chain's Bohr testnet (chain 968). It holds no real prompts, keys or personal data.

| | |
|---|---|
| Log ID | `0xddf707b6500175ada3646129170aa1562882aca62283b0d8f6919252f122af8c` |
| Anchorer | `0xA1918A4E578babad074ACf7DCefB152f8FDC8D2E` |
| Registry (GermlineAnchor) | [`0xC7a99F46674828aD14592fDaD319212f2ecd446D`](https://scan.bohr.life/address/0xC7a99F46674828aD14592fDaD319212f2ecd446D) |
| Anchor tx | [`0x7e5e430e…ccc2`](https://scan.bohr.life/tx/0x7e5e430e1011c40b922ae1e42b4037cbd777209a6e868428dd7348b22d95ccc2), block 28,871,398, 2 entries |

## Check it from the command line

```
git clone https://github.com/let-the-dreamers-rise/germline && cd germline && npm install
GERMLINE_NETWORK=bohr node bin/germline.js verify \
  --log examples/botchain-bohr/audit.jsonl --chain \
  --log-id 0xddf707b6500175ada3646129170aa1562882aca62283b0d8f6919252f122af8c \
  --anchorer 0xA1918A4E578babad074ACf7DCefB152f8FDC8D2E \
  --registry 0xC7a99F46674828aD14592fDaD319212f2ecd446D
```

Expected: `ok: 3 entries` and `ok registry anchor #0 (2 entries)`, exit code 0. Change any value in the file and the same command fails with `contents do not match its hash`, exit code 1.

`GERMLINE_NETWORK=bohr` points the CLI at the BOT Chain testnet RPC (`botchain` is mainnet, `zerog` is the default). That is all the chain switch takes; `GERMLINE_RPC` names any other EVM RPC.

## Check it in the browser

[Open the browser verifier with this log and its pins filled in](https://germline.vercel.app/verify.html?log=https%3A%2F%2Fraw.githubusercontent.com%2Flet-the-dreamers-rise%2Fgermline%2Fmain%2Fexamples%2Fbotchain-bohr%2Faudit.jsonl&logId=0xddf707b6500175ada3646129170aa1562882aca62283b0d8f6919252f122af8c&anchorer=0xA1918A4E578babad074ACf7DCefB152f8FDC8D2E&registry=0xC7a99F46674828aD14592fDaD319212f2ecd446D&rpc=https%3A%2F%2Frpc.bohr.life). The page fetches the log, recomputes the hash chain and reads the registry over the BOT RPC, all in the browser.

## Dependencies

The anchor-only flow needs an EVM RPC and a funded key, nothing else. 0G Storage is used only with `germline anchor --upload`, and 0G Compute only by the separate `germline review` command. Both are optional and were not used here.
