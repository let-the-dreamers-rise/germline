# Hosted anchoring

This is the paid tier. Germline anchors your log from its own key and pays the
gas, so your CI never holds a crypto wallet. Your auditor pins Germline's
public address, which you don't control. That means even you can't re-anchor
a rewritten history under it.

## What changes for the customer

On GitHub Actions there's no secret to store:

1. We add your repository to the service, bound to your log's id (the value
   `germline id` prints).
2. Set the repository variable `GERMLINE_HOSTED_URL` to the service URL we
   send you, and remove `GERMLINE_ANCHOR_KEY` if you had one.

The workflow `germline init` writes already passes the URL to the action and
grants `id-token: write`. Each run asks GitHub for a short-lived OIDC token
naming your repository, and the service checks it. For other CI systems we
issue a bearer token instead, which you store as `GERMLINE_HOSTED_TOKEN`.
Locally, the command is `germline anchor --hosted`.

Only three values ever reach us: the log id, the entry count and the head
hash. All three are public on chain once anchored. Your prompts, settings and
commit messages never leave your repository.

## What the auditor gets

A pins page at `pins.html?logId=0x…` on the service, published by us at the
start of the audit period. It lists the log id, our anchorer address, the
registry and the date hosting began, and it links to the browser verifier
with those pins filled in. Because the pins come from us and are on chain
from the first anchor, a log rebuilt the week before the audit, under a new id
or a new key, fails the check.

## What the service refuses

| request | answer |
|---|---|
| missing, short or unknown token | 401 |
| a GitHub OIDC token that isn't signed by GitHub, was issued for another audience, has expired or is over 10 minutes old, or comes from a `pull_request` run | 401 |
| a GitHub OIDC token from another repository, including one with the same name but a different numeric id (renamed or re-registered) | 401 |
| a token used for a log id it is not bound to | 403 |
| an entry count not above the last anchor | 409 (also enforced by the registry) |
| another anchor for the same log within 5 minutes | 429 with `Retry-After` |
| malformed log id, head, count or body | 400 |

The client checks the receipt before recording it. The log id, head and count
must match what it sent. With an RPC available, which is the CLI's default,
it also reads the anchor back from the registry. A service that answers
"anchored" without anchoring is caught at that point, and nothing is written
to the log.

Revoking a token stops it at once. The log's anchor history and its pins
stay exactly as they were.

These checks are covered by `test/hosted.test.js`, which runs the customer's
CLI against the service handler on a real EVM.

## Running the service

The service is two Vercel functions in `web/api/`. The project's root
directory is already `web`, so they deploy with the site.

Environment variables, set in the Vercel project:

| name | value |
|---|---|
| `GERMLINE_HOSTED_KEY` | the hosted anchorer's private key. Use a key used for nothing else, and fund it with a few 0G. |
| `GERMLINE_REGISTRY` | the GermlineAnchor address on 0G mainnet (from `deployments/zerog-anchor.json`) |
| `GERMLINE_CUSTOMERS` | JSON array of customer rows, see below |
| `ZEROG_RPC` | optional, defaults to `https://evmrpc.0g.ai` |
| `GERMLINE_MIN_INTERVAL` | optional, seconds between anchors per log, default 300 |
| `GERMLINE_HOSTED_AUDIENCE` | optional, the OIDC audience runs must request, default `germline-hosted` |

To add a customer on GitHub Actions:

```bash
node scripts/hosted-customer.js --id acme --name "Acme Inc" --log-id 0x… --repo acme/agents --public
```

It looks up the repository's numeric id and owner id with `gh api`, and
prints the row to append to `GERMLINE_CUSTOMERS`. For other CI, add
`--token`. The script then prints a bearer token once, for the customer, and
only its sha256 goes in the environment.
Redeploy for the change to take effect. `--public` lists the log on the pins
page.

## Limits, said plainly

- Customers live in an environment variable. That is fine for the first ten
  or so customers; after that they move to a database.
- `--upload` to 0G Storage isn't available in hosted mode yet. Storage writes
  need the log's content, and the hosted service is designed never to see it.
- Billing isn't wired up. Invoices are sent by hand.
- The hosted key is one key. If it leaks, someone can anchor garbage heads
  for any customer's log id under our address. Verification then fails until
  we rotate the key and publish new pins. Keep it only in the Vercel
  environment and watch its balance.
