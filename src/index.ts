/**
 * Cloudflare Worker entry point (SPEC §8, §9, §10).
 *
 * This module is deliberately thin. It owns the two runtime entry points and the
 * wiring between them and the modules that hold the actual behaviour, and nothing
 * else. The donor implementation this project analysed concentrated routing,
 * authentication, orchestration, HTTP clients, and a 600-line inline document in
 * a single entrypoint; that is the one pattern this project explicitly rejects
 * (PLAN §7.3, §8.3).
 *
 * Two guarantees are enforced here rather than left to callers, because here is
 * the only place they can be lost:
 *
 * **A scheduled run cannot reject.** `scheduled()` catches everything. A rejection
 * escapes into the Cron runtime and means the webhook and history row were never
 * attempted — a run that cannot report its failure is worse than one that reports
 * it. The pipeline itself is written not to throw; this is the backstop.
 *
 * **The fetch handler never runs the monitor.** There is no route that triggers a
 * scheduled run. An unauthenticated HTTP path capable of driving the control loop
 * is an explicit anti-requirement recorded from community implementations.
 */

import { loadConfig } from "./config";
import type { Config } from "./config";
import {
  listCdtInternetTraffic,
  describeInstance,
  startInstance,
  stopInstance,
} from "./aliyun/api";
import { runPipeline } from "./monitor/execute";
import type { RunReport } from "./monitor/execute";
import { notify } from "./notify/webhook";
import { recordRun } from "./storage/history";
import { readHistory, clampLimit } from "./storage/read";
import type { HistoryRow } from "./storage/read";
import { route } from "./web/router";
import { renderDashboard } from "./web/dashboard";
import { runReadOnlyQuery } from "./web/query";
import type { AuthConfig } from "./web/auth";
import { redact } from "./redact";

/** Worker bindings. Secrets and plain vars, plus the D1 binding. */
export interface Env {
  readonly ALIYUN_ACCESS_KEY_ID?: string;
  readonly ALIYUN_ACCESS_KEY_SECRET?: string;
  readonly WEBHOOK_URL?: string;
  readonly WEBHOOK_TOKEN?: string;
  readonly REGION_ID?: string;
  readonly ECS_INSTANCE_ID?: string;
  readonly TRAFFIC_THRESHOLD_GB?: string;
  readonly CDT_ENDPOINT?: string;
  readonly BUSINESS_REGION_ID?: string;
  readonly SIGNATURE_VERSION?: string;
  readonly STOPPED_MODE?: string;
  readonly ADMIN_USER?: string;
  readonly ADMIN_TOKEN?: string;
  readonly TRAFFIC_DB?: D1Database;
}

export interface HealthResponse {
  readonly status: "ok";
  readonly service: "cfworker4alicdt";
}

/** Static liveness body. Discloses no configuration value (SPEC §8.1). */
export const healthResponse: HealthResponse = {
  status: "ok",
  service: "cfworker4alicdt",
};

/** Turn a validated `Config` into the API context the pipeline needs. */
function pipelineDeps(config: Config) {
  const context = {
    accessKeyId: config.accessKeyId,
    accessKeySecret: config.accessKeySecret,
    signatureVersion: config.signatureVersion,
  };
  return {
    getTraffic: () =>
      listCdtInternetTraffic({
        ...context,
        endpoint: config.cdtEndpoint,
        businessRegionId: config.businessRegionId,
      }),
    describeInstance: () =>
      describeInstance({
        ...context,
        regionId: config.regionId,
        instanceId: config.ecsInstanceId,
      }),
    startInstance: () =>
      startInstance({ ...context, regionId: config.regionId, instanceId: config.ecsInstanceId }),
    stopInstance: () =>
      stopInstance({
        ...context,
        regionId: config.regionId,
        instanceId: config.ecsInstanceId,
        stoppedMode: config.stoppedMode,
      }),
  };
}

/**
 * Append one history row for a scheduled run.
 *
 * The insert is expressed in terms of the binding rather than the ORM: a
 * parameterised `INSERT`, so no value is ever interpolated into SQL.
 *
 * Deliberately tolerant of a missing binding. `recordRun` treats a throw as a
 * storage failure, so a Worker deployed without `TRAFFIC_DB` records a failed
 * write rather than failing the run — the history is an observation, never a
 * prerequisite for control (SPEC §9.6).
 */
async function insertHistoryRow(
  db: D1Database | undefined,
  row: Readonly<Record<string, unknown>>,
): Promise<void> {
  if (db === undefined) throw new Error("TRAFFIC_DB binding is not configured");
  const entries = Object.entries(row);
  const columns = entries.map(([column]) => column);
  const placeholders = columns.map(() => "?").join(", ");
  const statement = `INSERT INTO traffic_checks (${columns.join(", ")}) VALUES (${placeholders})`;
  await db
    .prepare(statement)
    .bind(...entries.map(([, value]) => value))
    .run();
}

/** Run one scheduled execution end to end. Never throws. */
async function runScheduled(env: Env): Promise<void> {
  const parsed = loadConfig(env);

  if (!parsed.ok) {
    // Configuration failures still report: the owner requires notification on
    // every execution, and a misconfiguration is exactly when silence is least
    // acceptable (SPEC §7.2).
    try {
      await notify(
        { webhookUrl: env.WEBHOOK_URL ?? "", webhookToken: env.WEBHOOK_TOKEN },
        {
          status: "error",
          trafficGB: undefined,
          thresholdGB: 0,
          ecsStatusBefore: undefined,
          ecsStatusAfter: undefined,
          desired: undefined,
          action: undefined,
          stoppedModeRequested: undefined,
          instanceId: env.ECS_INSTANCE_ID ?? "(unset)",
          region: env.REGION_ID ?? "(unset)",
          time: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
          durationMs: 0,
          stage: "config",
          error: parsed.error.message,
        },
      );
    } catch {
      // Reporting a config failure must not itself fail the run.
    }
    return;
  }

  const config = parsed.config;
  const report = await runPipeline(
    {
      ...pipelineDeps(config),
      // The webhook is a reporting side channel the pipeline dispatches itself,
      // so the pipeline owns the transport and the run stays one unit.
      notify: (r) =>
        notify({ webhookUrl: config.webhookUrl, webhookToken: config.webhookToken }, r),
      now: Date.now,
    },
    config,
  );

  // History is written after control has already been applied, so a storage
  // failure can only degrade the record, never the action (SPEC §9.6).
  await recordRun(report, {
    insert: (row) => insertHistoryRow(env.TRAFFIC_DB, { ...row }),
  });
}

export default {
  async scheduled(
    _controller: ScheduledController,
    env: Env,
    _ctx: ExecutionContext,
  ): Promise<void> {
    try {
      await runScheduled(env);
    } catch (cause) {
      // The backstop. A rejection here would escape into the Cron runtime and
      // skip reporting entirely. Redacted because a driver error can echo a
      // bound parameter, and Workers Logs persist (SPEC §7.5, PLAN R9).
      const message = cause instanceof Error ? cause.message : "unknown scheduled failure";
      console.error(`[scheduled] run failed (${redact(message)})`);
    }
  },

  async fetch(request: Request, env: Env, _ctx: ExecutionContext): Promise<Response> {
    const auth: AuthConfig = {
      adminUser: env.ADMIN_USER ?? "admin",
      adminToken: env.ADMIN_TOKEN,
    };

    const result = await route(request, {
      auth,
      dashboard: () => ({ body: renderDashboard({ latest: undefined, history: [] }) }),
      history: async () => readHistoryFor(env, request),
      query: async () => readOnlyQuery(env),
    });

    return new Response(result.body, { status: result.status, headers: result.headers });
  },
} satisfies ExportedHandler<Env>;

/** Bounded history read for `GET /api/history`. */
async function readHistoryFor(env: Env, request: Request): Promise<HistoryRow[]> {
  const limit = clampLimit(new URL(request.url).searchParams.get("limit"));
  return readHistory(
    { limit: String(limit) },
    {
      query: (sql, params) => {
        if (env.TRAFFIC_DB === undefined) {
          throw new Error("TRAFFIC_DB binding is not configured");
        }
        return env.TRAFFIC_DB.prepare(sql)
          .bind(...params)
          .all<HistoryRow>()
          .then((outcome) => outcome.results);
      },
    },
  );
}

/** Read-only live query for `POST /api/query`. */
async function readOnlyQuery(env: Env): Promise<unknown> {
  const parsed = loadConfig(env);
  if (!parsed.ok) {
    // Returned as a value, never thrown: the route maps a failure to a status.
    return { status: "error", stage: "config", error: parsed.error.message };
  }
  const config = parsed.config;
  return runReadOnlyQuery(
    {
      getTraffic: () =>
        listCdtInternetTraffic({
          accessKeyId: config.accessKeyId,
          accessKeySecret: config.accessKeySecret,
          signatureVersion: config.signatureVersion,
          endpoint: config.cdtEndpoint,
          businessRegionId: config.businessRegionId,
        }),
      describeInstance: () =>
        describeInstance({
          accessKeyId: config.accessKeyId,
          accessKeySecret: config.accessKeySecret,
          signatureVersion: config.signatureVersion,
          regionId: config.regionId,
          instanceId: config.ecsInstanceId,
        }),
    },
    { trafficThresholdGB: config.trafficThresholdGB },
  );
}

/** Re-exported so `RunReport` consumers do not reach into the monitor module. */
export type { RunReport };
