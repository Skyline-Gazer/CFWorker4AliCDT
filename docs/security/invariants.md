# Security invariants

These are the current safety boundaries enforced by code, tests, and deployment configuration.

## Control and failure handling

- Only the scheduled Cron pipeline has StartInstance and StopInstance dependencies. HTTP RouteDeps and read-only QueryDeps contain no ECS mutation seam.
- The fetch handler never invokes the scheduled pipeline. No HTTP path starts, stops, or reboots an instance.
- Traffic that is missing, malformed, negative, non-finite, or returned with an API error is unavailable, not zero. A decision is not made from unknown traffic.
- Transitional or unrecognized ECS states take a fail-safe path without mutation.
- A scheduled run makes at most one ECS mutation. D1 stores an observation after the control path; it is not an input to a control decision.
- POST /api/query is a live read path. It does not mutate ECS, write D1 history, or send the scheduled webhook.

See src/monitor/decision.ts, src/monitor/execute.ts, src/index.ts, and src/web/query.ts.

## Authentication boundaries

- GET /health is the only public application route. It returns static liveness and performs no privileged work.
- The dashboard, history, query, and donor action namespace use HTTP Basic with ADMIN_USER and ADMIN_TOKEN.
- GET /api/monitor/cron uses only the dedicated MONITOR_READ_TOKEN Bearer value. ADMIN_TOKEN and Basic credentials do not authorize it. Query-string credentials are rejected.
- The monitor route reads a bounded D1 projection and does not expose raw errors, traffic, instance identifiers, or ECS details.
- Fixed dashboard CSS and JavaScript bundle assets may be served publicly; the dashboard HTML remains authenticated.

See src/web/router.ts, src/web/auth.ts, and src/index.ts.

## Secrets and output

- Alibaba credentials, admin credentials, webhook credentials, notification credentials, and MONITOR_READ_TOKEN are Worker Secrets, not Wrangler vars.
- Configuration and route errors use binding names or sanitized classifications rather than secret values or raw driver errors.
- Manual donor notification tests are default-off and require their configuration. When enabled they may send a message externally, but they do not add ECS control authority.
- The production-health workflow has no Cloudflare deploy credential. The token-install workflow is a separate owner-gated secret write and does not deploy application code.
- CI has no production credentials and does not deploy.

The Alibaba AccessKey must follow the least-privilege [RAM policy](ram-policy.md). For deployment authorization and secret installation, see [deployment](../operations/deployment.md) and [configuration](../operations/configuration.md).
