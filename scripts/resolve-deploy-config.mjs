// Resolve a complete, deployable Wrangler config from the committed one.
//
// WHY THIS EXISTS
//
// `wrangler.jsonc` declares the `TRAFFIC_DB` binding with no `database_id`, which
// is correct for the repository: the field is optional in Wrangler's schema, the
// local development and test paths use Wrangler's local D1 emulation, and no
// production identifier should ever be committed.
//
// A **remote** deployment still needs one. The options were:
//
//   a) commit a real `database_id` — rejected: it is production configuration and
//      the project's rule is that no remote resource identifier is committed;
//   b) rewrite `wrangler.jsonc` in place — rejected: a config rewrite in CI is
//      exactly the kind of thing that silently corrupts a config file;
//   c) generate a complete throwaway config — this.
//
// So this script reads the committed config, applies the differences that are
// **deployment-mode specific**, and writes a generated file that is gitignored.
// It never mutates the committed config.
//
// WHY ONE SCRIPT AND TWO MODES
//
// The first real deployment is two separate owner actions, and they differ in
// exactly one dangerous respect: whether scheduled mutation authority exists.
//
//   --mode preflight  Creates the Worker for the first time with Cron explicitly
//                     disabled, so the live read-only verification can happen
//                     BEFORE anything can start or stop an instance.
//   --mode release    Restores the production Cron and applies the owner's
//                     explicit HTTP exposure choice.
//
// Both modes are branches of one function rather than two scripts, because two
// scripts would drift: a fix to the D1 injection or the root-path guard would
// have to be made twice, and the second copy would be the one that is wrong.
//
// WHY THE OUTPUT PATH MATTERS
//
// Wrangler treats the config file's **directory** as the project root, so `main:
// "src/index.ts"` is resolved relative to the config's location. A config written
// to a temp directory, or even to `.wrangler/`, makes Wrangler look for the entry
// point outside the repository and fail with "The entry-point file at
// src/index.ts was not found" — measured, not assumed.
//
// The filenames are distinct from `wrangler.jsonc` so Wrangler never picks one up
// implicitly in place of the committed config. All of them are gitignored.
//
// Nothing here prints a value from the environment: the resolved database id is an
// infrastructure identifier and this output goes to CI logs.

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

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..");
const sourcePath = resolve(repoRoot, "wrangler.jsonc");

/**
 * The authoritative production Cron expression (SPEC §11).
 *
 * It appears here, in the release mode only, so that "which mode enables
 * scheduled mutation" is answered by reading one line of one file.
 */
const PRODUCTION_CRONS = ["*/10 * * * *"];

/** The deployment modes. Anything else is a mistake, not a default. */
const MODES = ["preflight", "release"];

/**
 * Application runtime variables that MUST be present in a generated config.
 *
 * `loadConfig()` rejects a Worker whose environment lacks these, so a deployment
 * that omitted them would succeed and then fail at the first request — the worst
 * moment to discover a missing binding, and one that a dry-run cannot catch.
 * Failing here means the deploy never starts.
 *
 * These are application configuration, not credentials. They are supplied as
 * repository *variables*.
 */
const REQUIRED_APPLICATION_VARS = ["REGION_ID", "ECS_INSTANCE_ID"];

/**
 * Application runtime variables that MAY be overridden per deployment.
 *
 * When a non-empty value is supplied it replaces the committed default; when it is
 * not, the committed `wrangler.jsonc` value is preserved. This keeps the repository
 * config the single place a default is stated.
 *
 * Deliberately NOT validated here beyond presence. Whether a threshold is a
 * positive number or a signature version is `v2`/`v3` is `loadConfig()`'s job;
 * duplicating that logic would create two implementations that can disagree.
 */
const OPTIONAL_APPLICATION_VARS = [
  "TRAFFIC_THRESHOLD_GB",
  "CDT_ENDPOINT",
  "BUSINESS_REGION_ID",
  "SIGNATURE_VERSION",
  "STOPPED_MODE",
];

/**
 * HTTP exposure modes. There is deliberately **no default**: silence about how
 * the dashboard is reachable is the gap this exists to close, so an absent value
 * is a failure rather than a chosen behaviour.
 */
const EXPOSURE_MODES = ["workers_dev", "custom_domain"];

/**
 * A hostname, not a URL and not a route pattern with wildcards.
 *
 * Deliberately strict: a malformed domain would otherwise reach Wrangler and fail
 * there with a message about routes rather than about the value that was wrong.
 * Digits are permitted in labels; the final label must be alphabetic, which
 * rejects a bare decimal-looking string such as `1.2`.
 */
const DOMAIN_PATTERN =
  /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*\.[a-z]{2,}$/i;

function parseArguments(argv) {
  const modeIndex = argv.indexOf("--mode");
  if (modeIndex === -1) {
    fail(`--mode is required. Expected one of: ${MODES.join(", ")}.`);
  }
  const mode = argv[modeIndex + 1];
  if (typeof mode !== "string" || !MODES.includes(mode)) {
    fail(`--mode must be one of: ${MODES.join(", ")}. No default is assumed.`);
  }
  return mode;
}

/** Present means a non-empty, non-whitespace string. */
function present(value) {
  return typeof value === "string" && value.trim() !== "";
}

/** Read and parse the committed config. Never written back. */
function readSourceConfig() {
  const config = parseJsonc(readFileSync(sourcePath, "utf8"));

  if (!Array.isArray(config.d1_databases) || config.d1_databases.length === 0) {
    fail("wrangler.jsonc declares no d1_databases binding to resolve.");
  }
  const binding = config.d1_databases.find((entry) => entry.binding === "TRAFFIC_DB");
  if (binding === undefined) {
    fail("wrangler.jsonc has no TRAFFIC_DB binding to resolve.");
  }
  return { config, binding };
}

/** Inject the D1 identifier, or refuse to produce a config without one. */
function injectDatabaseId(binding) {
  const databaseId = process.env.D1_DATABASE_ID;
  if (!present(databaseId)) {
    fail(
      "D1_DATABASE_ID is required and must be non-empty.\n" +
        "Set it to the UUID of the remote TRAFFIC_DB database, supplied as a\n" +
        "repository variable so it is never committed. No placeholder value is used.",
    );
  }
  binding.database_id = databaseId.trim();
}

/**
 * Inject the application runtime configuration into `vars`.
 *
 * Both modes call this, so a change of deployment mode cannot silently change what
 * the Worker is configured to do. Mode-specific properties (Cron, preview URL,
 * workers.dev vs custom domain, the required-secret declaration) are the only
 * things a mode may alter.
 *
 * Failure messages name bindings only. A value from the environment never reaches
 * CI logs, and no supplied value is ever echoed.
 */
function injectApplicationVars(config) {
  const vars = typeof config.vars === "object" && config.vars !== null ? config.vars : {};

  // Required first, and before any optional work: a config missing a required
  // binding is not worth generating at all.
  for (const name of REQUIRED_APPLICATION_VARS) {
    const value = process.env[name];
    if (!present(value)) {
      fail(
        `${name} is required and must be non-empty.\n` +
          "Supply it as a repository variable. It is application configuration, not a\n" +
          "credential, so it does not belong in GitHub Secrets. Generating a config\n" +
          "without it would deploy successfully and then fail every request that calls\n" +
          "loadConfig(), which is the failure this guard exists to prevent.",
      );
    }
    vars[name] = value.trim();
  }

  // Optional overrides: apply when supplied, otherwise preserve the committed
  // default. `BUSINESS_REGION_ID` has no committed default, so leaving it absent
  // is the correct outcome rather than writing an empty string.
  for (const name of OPTIONAL_APPLICATION_VARS) {
    const value = process.env[name];
    if (present(value)) {
      vars[name] = value.trim();
    }
  }

  config.vars = vars;
}

/**
 * Apply the PRE-FLIGHT differences.
 *
 * Cron is disabled with an **empty array**, not by omitting the field. Cloudflare
 * documents the distinction: an empty `crons` array removes all Cron Triggers,
 * while `undefined` leaves whatever is currently deployed in place. Omitting the
 * field would therefore be a silent "do not change anything", which is not the
 * same operation as "have no Cron Trigger".
 *
 * `secrets.required` is ALSO emptied, and that is not a relaxation of a safety
 * property — it is the only way this deploy can succeed. Wrangler validates
 * `secrets.required` at deploy time, and a Worker that does not exist yet cannot
 * hold secrets:
 *
 *   "This Worker does not exist yet, so secrets cannot be set in advance with
 *    `wrangler secret put`."
 *
 * So a first deploy that declared `secrets.required` would fail outright, and the
 * owner's only alternatives would be to scaffold the Worker some other way or to
 * pass every secret on the command line. Neither is desirable. The check is
 * restored by RELEASE, where the Worker exists. Note that a `--dry-run` does not
 * catch this, because the validation runs on the real upload path.
 */
function applyPreflight(config) {
  config.workers_dev = false;
  config.preview_urls = true;
  delete config.routes;
  delete config.route;
  config.triggers = { crons: [] };
  config.secrets = { required: [] };
}

/**
 * Apply the RELEASE differences.
 *
 * Fails closed on the HTTP exposure decision: an absent or unrecognised value is
 * an error, because the effective alternative is an implicit choice the owner did
 * not make.
 */
function applyRelease(config) {
  const exposureMode = process.env.HTTP_EXPOSURE_MODE;
  const candidates = EXPOSURE_MODES.join(", ");

  if (!present(exposureMode)) {
    fail(
      "HTTP_EXPOSURE_MODE is required for a release and must be non-empty.\n" +
        `Expected one of: ${candidates}. There is no default: how the dashboard\n` +
        "is reachable is an explicit deployment choice, not an inferred one.",
    );
  }
  if (!EXPOSURE_MODES.includes(exposureMode)) {
    fail(`HTTP_EXPOSURE_MODE must be one of: ${candidates}. Received an unrecognised value.`);
  }

  // The authoritative production Cron is restored here, and only here.
  config.triggers = { crons: [...PRODUCTION_CRONS] };

  // The Version URL exists for controlled live verification. Once a stable
  // endpoint is explicit, retaining the temporary preview exposure is not needed.
  config.preview_urls = false;

  if (exposureMode === "workers_dev") {
    config.workers_dev = true;
    delete config.routes;
    delete config.route;
    return;
  }

  const domain = process.env.WORKER_CUSTOM_DOMAIN;
  if (!present(domain)) {
    fail(
      "WORKER_CUSTOM_DOMAIN is required when HTTP_EXPOSURE_MODE=custom_domain\n" +
        "and must be non-empty. Provide the hostname the Worker should answer on.",
    );
  }
  const trimmed = domain.trim();
  if (!DOMAIN_PATTERN.test(trimmed)) {
    fail(
      "WORKER_CUSTOM_DOMAIN must be a bare hostname, for example worker.example.com.\n" +
        "A URL, a wildcard pattern, or a malformed value is rejected rather than\n" +
        "passed to Wrangler, which would report it as a route problem.",
    );
  }

  config.workers_dev = false;
  config.routes = [{ pattern: trimmed, custom_domain: true }];
}

const mode = parseArguments(process.argv.slice(2));

const { config, binding } = readSourceConfig();
injectDatabaseId(binding);
// Application configuration is injected for BOTH modes, from this one boundary,
// so a mode can never silently change what the Worker is configured to do.
injectApplicationVars(config);

if (mode === "preflight") {
  applyPreflight(config);
} else {
  applyRelease(config);
}

const defaultOutput = resolve(
  repoRoot,
  mode === "preflight" ? "wrangler.preflight.jsonc" : "wrangler.deploy.jsonc",
);
const outputPath = process.env.DEPLOY_CONFIG_PATH ?? defaultOutput;

// Verify the config will land beside the entry point it references. This is the
// failure that would otherwise only appear during a real deploy, with a message
// that points at the entry point rather than at the config's location.
if (dirname(outputPath) !== repoRoot) {
  fail(
    "Refusing to write the generated config outside the repository root.\n" +
      "Wrangler resolves 'main' relative to the config's directory, so a config at\n" +
      `${dirname(outputPath)} would look for the entry point there and fail.`,
  );
}

mkdirSync(dirname(outputPath), { recursive: true });
writeFileSync(outputPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");

// The resolved id is deliberately NOT printed. It is an infrastructure
// identifier, and this output goes to CI logs.
process.stdout.write(`Resolved ${mode} deploy config written to ${outputPath}\n`);
