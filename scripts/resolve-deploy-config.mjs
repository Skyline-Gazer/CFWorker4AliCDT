// Resolve a Wrangler config with a real D1 `database_id` supplied from the
// environment, so the repository never contains a production identifier.
//
// WHY THIS EXISTS
//
// `wrangler.jsonc` declares the `TRAFFIC_DB` binding with no `database_id`, which
// is correct for the repository: the field is optional in Wrangler's schema, and
// the local development and test paths use Wrangler's local D1 emulation, so no
// real identifier needs to be committed anywhere.
//
// A **remote** deployment still needs one. The options were:
//
//   a) commit a real `database_id` — rejected: it is production configuration and
//      the project's rule is that no remote resource identifier is committed;
//   b) have the deploy workflow rewrite `wrangler.jsonc` in place — rejected: a
//      config rewrite in CI is exactly the kind of thing that silently corrupts a
//      config file;
//   c) generate a complete throwaway config with the id injected — this.
//
// So this script reads the committed config, injects the identifier from
// `D1_DATABASE_ID`, and writes a generated file that is gitignored. It never
// mutates the committed config, and it fails loudly rather than producing a
// config with a missing or placeholder id.
//
// This file is the single source of truth for how the identifier is injected; the
// deploy workflow calls it rather than duplicating the logic.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** Wrangler's JSONC allows comments; strip them and trailing commas to parse. */
function parseJsonc(text) {
  const withoutBlockComments = text.replace(/\/\*[\s\S]*?\*\//g, "");
  const withoutLineComments = withoutBlockComments.replace(/^\s*\/\/.*$/gm, "");
  const withoutTrailingCommas = withoutLineComments.replace(/,(\s*[}\]])/g, "$1");
  return JSON.parse(withoutTrailingCommas);
}

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..");
const sourcePath = resolve(repoRoot, "wrangler.jsonc");
const outputPath = process.env.DEPLOY_CONFIG_PATH ?? resolve(repoRoot, ".wrangler/deploy.jsonc");

const databaseId = process.env.D1_DATABASE_ID;

if (typeof databaseId !== "string" || databaseId.trim() === "") {
  // Fail loudly. A deploy that proceeded without an id would either fail deep
  // inside Wrangler with a less actionable message, or bind the wrong database.
  process.stderr.write(
    "D1_DATABASE_ID is required and must be non-empty.\n" +
      "Set it to the UUID of the remote TRAFFIC_DB database, supplied as a\n" +
      "repository variable so it is never committed. No placeholder value is used.\n",
  );
  process.exit(1);
}

const config = parseJsonc(readFileSync(sourcePath, "utf8"));

if (!Array.isArray(config.d1_databases) || config.d1_databases.length === 0) {
  process.stderr.write("wrangler.jsonc declares no d1_databases binding to resolve.\n");
  process.exit(1);
}

const binding = config.d1_databases.find((entry) => entry.binding === "TRAFFIC_DB");
if (binding === undefined) {
  process.stderr.write("wrangler.jsonc has no TRAFFIC_DB binding to resolve.\n");
  process.exit(1);
}

binding.database_id = databaseId.trim();

mkdirSync(dirname(outputPath), { recursive: true });
writeFileSync(outputPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");

// The resolved id is deliberately NOT printed. It is an infrastructure
// identifier, and this output goes to CI logs.
process.stdout.write(`Resolved deploy config written to ${outputPath}\n`);
