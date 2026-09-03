"use strict";

// Print the population as it stands on chain.
//
// This is a read-only report: no signer is required, and nothing here can
// alter the lineage it describes. It exists so an operator -- or a judge --
// can see the whole tree in one screen without opening a block explorer and
// reconstructing it by hand.
//
// Run:  npx hardhat run scripts/status.js --network zerog

const hre = require("hardhat");
const census = require("../lib/census");
const { loadDeployment, assertChainMatches, addressLink } = require("../lib/chain");

function pad(value, width) {
  const text = String(value);
  return text.length >= width ? text : text + " ".repeat(width - text.length);
}

// A dead end is not merely "out of turns" -- an organism that spent every
// child it earned is fine, its line goes on through them. A dead end is one
// that never earned a child to begin with: its score never cleared the
// survival threshold, so the contract's Barren rule ends it right there.
function statusOf(row) {
  if (!row.attested) return "unmeasured";
  if (row.allowance === 0) return "dead end";
  if (row.remaining === 0) return "spent";
  return "breeding (" + row.remaining + " left)";
}

async function status(options = {}) {
  const log = options.log || console.log;
  const network = hre.network.name;
  const record = loadDeployment(hre);
  await assertChainMatches(hre, record);

  const germline = await hre.ethers.getContractAt("Germline", record.address);
  const rows = await census.readPopulation(germline);

  log("network:   " + network);
  log("contract:  " + record.address);
  const link = addressLink(network, record.address);
  if (link) log("            " + link);
  log("population: " + rows.length);
  log("");

  if (rows.length === 0) {
    log("no organisms yet.  found the first one:");
    log("  npx hardhat run scripts/found.js --network " + network);
    return { network, address: record.address, rows: [] };
  }

  const header =
    pad("id", 4) +
    pad("gen", 5) +
    pad("parent", 8) +
    pad("phenotype", 34) +
    pad("fitness", 11) +
    pad("offspring", 12) +
    "status";
  log(header);
  log("-".repeat(header.length));

  for (const row of rows) {
    const phenotypeText = row.phenotype || (row.cachedLocally ? "(unnamed)" : "(uncached)");
    const fitnessText = row.attested ? row.score + " bps" : "-";
    const offspringText = row.offspring + "/" + row.allowance;
    log(
      pad(row.id, 4) +
        pad(row.generation, 5) +
        pad(row.parent === 0 ? "-" : row.parent, 8) +
        pad(phenotypeText, 34) +
        pad(fitnessText, 11) +
        pad(offspringText, 12) +
        statusOf(row)
    );
  }

  const deadEnds = rows.filter((r) => r.attested && r.allowance === 0).length;
  const breeding = rows.filter((r) => r.remaining > 0).length;
  const unmeasured = rows.filter((r) => !r.attested).length;
  const best = rows.reduce(
    (a, b) => (b.attested && (!a || b.score > a.score) ? b : a),
    null
  );

  log("");
  log(
    breeding + " breeding, " + deadEnds + " dead end(s), " + unmeasured + " unmeasured"
  );
  if (best) {
    log(
      "fittest:   organism " +
        best.id +
        "  " +
        (best.phenotype || best.genomeRoot) +
        "  " +
        best.score +
        " bps"
    );
  }

  return { network, address: record.address, rows };
}

if (require.main === module) {
  status().catch((error) => {
    console.error(error.message || error);
    process.exitCode = 1;
  });
}

module.exports = { status };
