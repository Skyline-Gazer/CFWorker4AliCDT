import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

function readRepoFile(path: string): string {
  return readFileSync(resolve(repoRoot, path), "utf8");
}

function markdownFiles(directory: string): string[] {
  const absolute = resolve(repoRoot, directory);
  return readdirSync(absolute, { withFileTypes: true }).flatMap((entry) => {
    if (entry.isDirectory()) {
      if ([".git", "node_modules"].includes(entry.name)) return [];
      return markdownFiles(resolve(directory, entry.name));
    }
    return entry.isFile() && entry.name.endsWith(".md") ? [resolve(directory, entry.name)] : [];
  });
}

function relativeLinkTargets(markdown: string): string[] {
  return [...markdown.matchAll(/\]\((<[^>]+>|[^)]+)\)/g)]
    .map((match) => match[1]?.trim() ?? "")
    .map((target) =>
      target.startsWith("<") && target.endsWith(">") ? target.slice(1, -1) : target,
    )
    .filter(
      (target) => target !== "" && !/^[a-z][a-z\d+.-]*:/i.test(target) && !target.startsWith("//"),
    )
    .map((target) => target.split(/[?#]/, 1)[0] ?? "")
    .filter((target) => target !== "");
}

describe("documentation governance", () => {
  it("references workflow files that exist in the repository", () => {
    const workflows = [
      "ci.yml",
      "preflight.yml",
      "release.yml",
      "update.yml",
      "production-health.yml",
      "install-monitor-read-token.yml",
    ];
    const docs = [
      "README.md",
      "AGENTS.md",
      ".github/pull_request_template.md",
      "docs/operations/deployment.md",
      "docs/operations/configuration.md",
      "docs/operations/monitoring.md",
    ]
      .map(readRepoFile)
      .join("\n");

    for (const workflow of workflows) {
      expect(existsSync(resolve(repoRoot, ".github/workflows", workflow)), workflow).toBe(true);
      expect(docs, "documented workflow " + workflow).toContain(workflow);
    }
  });

  it("keeps documented runtime binding names present in Worker config or Env code", () => {
    const configDoc = readRepoFile("docs/operations/configuration.md");
    const implementation = [
      readRepoFile("src/config.ts"),
      readRepoFile("src/index.ts"),
      readRepoFile("wrangler.jsonc"),
    ].join("\n");
    const names = [
      "ALIYUN_ACCESS_KEY_ID",
      "ALIYUN_ACCESS_KEY_SECRET",
      "REGION_ID",
      "ECS_INSTANCE_ID",
      "TRAFFIC_THRESHOLD_GB",
      "CDT_ENDPOINT",
      "BUSINESS_REGION_ID",
      "SIGNATURE_VERSION",
      "STOPPED_MODE",
      "ADMIN_USER",
      "ADMIN_TOKEN",
      "MONITOR_READ_TOKEN",
      "WEBHOOK_URL",
      "WEBHOOK_TOKEN",
      "ENABLE_BILLING",
      "ENABLE_MANUAL_WEBHOOK_TEST",
      "ENABLE_MANUAL_TELEGRAM_TEST",
      "ENABLE_MANUAL_SMTP_TEST",
      "SMTP_HOST",
      "SMTP_PORT",
      "SMTP_USER",
      "SMTP_PASS",
      "SMTP_FROM",
      "TELEGRAM_BOT_TOKEN",
      "TELEGRAM_CHAT_ID",
      "TELEGRAM_PROXY_URL",
      "TRAFFIC_DB",
      "ASSETS",
    ];

    for (const name of names) {
      expect(configDoc, "documented binding " + name).toContain(name);
      expect(implementation, "implemented binding " + name).toContain(name);
    }
  });

  it("keeps relative Markdown links in repository guides pointed at existing paths", () => {
    const broken: string[] = [];
    for (const file of markdownFiles(".")) {
      const absoluteFile = resolve(repoRoot, file);
      const markdown = readFileSync(absoluteFile, "utf8");
      for (const target of relativeLinkTargets(markdown)) {
        let decoded: string;
        try {
          decoded = decodeURIComponent(target);
        } catch {
          decoded = target;
        }
        const linkedPath = decoded.startsWith("/")
          ? resolve(repoRoot, decoded.slice(1))
          : resolve(dirname(absoluteFile), decoded);
        if (!existsSync(linkedPath)) broken.push(file + " -> " + target);
      }
    }

    expect(broken).toEqual([]);
  });
});
