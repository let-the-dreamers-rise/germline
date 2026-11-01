// Add a customer to hosted anchoring.
//
// GitHub Actions (no secret for the customer to store):
//   node scripts/hosted-customer.js --id acme --name "Acme Inc" --log-id 0x… --repo acme/agents [--public]
//     looks up the repository's numeric ids with `gh api`, or pass
//     --repository-id <n> --owner-id <n> yourself.
//
// Any other CI: add --token, and it prints a bearer token once, for the
// customer's GERMLINE_HOSTED_TOKEN secret. Only its sha256 is stored.
//
// Prints the row to append to GERMLINE_CUSTOMERS on the hosted service.

const crypto = require("crypto");
const { sha256 } = require("../web/api/_lib/hosted");

const args = process.argv.slice(2);
const flag = (name) => {
  const i = args.indexOf("--" + name);
  return i === -1 ? undefined : args[i + 1];
};
const id = flag("id");
const logId = flag("log-id");
if (!id || !/^[a-z0-9-]{2,40}$/.test(id)) throw new Error("--id must be 2-40 lowercase letters, digits or dashes");
if (!logId || !/^0x[0-9a-fA-F]{64}$/.test(logId)) throw new Error("--log-id must be the value `germline id` prints");

const row = { id, name: flag("name") || id, logId: logId.toLowerCase() };
const repo = flag("repo");
let repositoryId = flag("repository-id") ? Number(flag("repository-id")) : undefined;
let ownerId = flag("owner-id") ? Number(flag("owner-id")) : undefined;
if (repo && repositoryId === undefined) {
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) throw new Error("--repo must be owner/name");
  const { execFileSync } = require("child_process");
  const info = JSON.parse(execFileSync("gh", ["api", "repos/" + repo], { encoding: "utf8" }));
  repositoryId = info.id;
  ownerId = info.owner && info.owner.id;
}
if (repositoryId !== undefined) {
  if (!Number.isSafeInteger(repositoryId) || repositoryId < 1) throw new Error("--repository-id must be a positive integer");
  row.repositoryId = repositoryId;
  if (ownerId) row.repositoryOwnerId = ownerId;
  if (repo) row.repository = repo;
}
let token = null;
if (args.includes("--token")) {
  token = "gl_" + crypto.randomBytes(24).toString("base64url");
  row.tokenHash = sha256(token);
}
if (!row.repositoryId && !row.tokenHash) throw new Error("give --repo (GitHub Actions) or --token (other CI)");
row.since = new Date().toISOString().slice(0, 10);
row.public = args.includes("--public");

if (token) {
  console.log("token (give to the customer once, as GERMLINE_HOSTED_TOKEN; it is not stored anywhere):");
  console.log("  " + token);
  console.log("");
}
console.log("row for GERMLINE_CUSTOMERS:");
console.log("  " + JSON.stringify(row));
