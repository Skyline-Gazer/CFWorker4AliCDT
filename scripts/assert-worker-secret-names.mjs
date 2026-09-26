import { readFileSync } from "node:fs";

const REQUIRED_SECRET_NAMES = ["ALIYUN_ACCESS_KEY_ID", "ALIYUN_ACCESS_KEY_SECRET", "ADMIN_TOKEN"];

const LIST_CONTAINERS = ["secrets", "result", "results", "data", "items"];

/** Read only `name` fields from the common Wrangler list shapes. */
function collectNames(value, names = new Set()) {
  if (Array.isArray(value)) {
    for (const entry of value) {
      if (entry !== null && typeof entry === "object" && !Array.isArray(entry)) {
        if (typeof entry.name === "string") names.add(entry.name);
        collectNamesFromContainers(entry, names);
      }
    }
    return names;
  }

  if (value !== null && typeof value === "object") {
    if (typeof value.name === "string") names.add(value.name);
    collectNamesFromContainers(value, names);
  }

  return names;
}

function collectNamesFromContainers(value, names) {
  for (const key of LIST_CONTAINERS) {
    if (Object.hasOwn(value, key)) collectNames(value[key], names);
  }
}

function reportMissing(missingNames, reason) {
  if (reason) console.error(`::error::${reason}`);

  for (const name of missingNames) {
    console.error(`::error::Required Worker Secret name is missing: ${name}`);
  }

  console.error("Set each missing name as a Worker Secret with: wrangler secret put <NAME>.");
  console.error(
    "Never put ALIYUN_ACCESS_KEY_ID, ALIYUN_ACCESS_KEY_SECRET, or ADMIN_TOKEN in Wrangler vars, GitHub Variables, or Cloudflare Dashboard plaintext vars.",
  );
  console.error(
    "PRE-FLIGHT, RELEASE, and UPDATE deploy generated vars configs; Dashboard plaintext vars absent from the generated config are removed on deploy.",
  );
  console.error(
    "If ALIYUN_ACCESS_KEY_ID was ever present in Actions logs, rotate the Alibaba AccessKey.",
  );
}

let parsed;
try {
  parsed = JSON.parse(readFileSync(0, "utf8"));
} catch {
  reportMissing(
    REQUIRED_SECRET_NAMES,
    "wrangler secret list output could not be parsed as JSON; use --format json and verify again after the Worker exists.",
  );
  process.exit(1);
}

const foundNames = collectNames(parsed);
const missingNames = REQUIRED_SECRET_NAMES.filter((name) => !foundNames.has(name));

if (missingNames.length > 0) {
  reportMissing(missingNames);
  process.exit(1);
}

console.log(`Required Worker Secret names are present: ${REQUIRED_SECRET_NAMES.join(", ")}.`);
