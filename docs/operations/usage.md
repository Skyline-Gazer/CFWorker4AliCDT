# Operator usage

This guide covers the current HTTP operations surface. Only the scheduled Cron pipeline can start or stop the configured ECS instance.

## 1. Check public liveness

    curl --fail-with-body https://<worker-host>/health

Expected response: HTTP 200 and a small JSON body with status "ok" and service "cfworker4alicdt". This is static liveness only; it does not check configuration, D1, Cron execution, or ECS.

## 2. Open the authenticated console

Open https://<worker-host>/ in a browser and authenticate with HTTP Basic username ADMIN_USER (default admin) and password ADMIN_TOKEN. The static dashboard document is protected. Its fixed CSS and JavaScript bundle assets are public.

The console displays live status and read-only results. Its donor UI contains actions that the Worker does not implement; an available-looking donor control is not evidence that the backend supports it. See [the API guide](api.md#donor-actions).

## 3. Run a live read-only query

Use the Basic-auth username; curl prompts for the password because none is supplied on the command line. Enter ADMIN_TOKEN at curl's hidden password prompt:

    curl --fail-with-body --user "$ADMIN_USER" \
      --request POST https://<worker-host>/api/query

The response describes the current traffic, observed ECS state, threshold decision, and mutation: false. If traffic or ECS state cannot be established, the response reports an error instead of inventing a safe value. This request does not call StartInstance or StopInstance, write history, or send the scheduled webhook.

Compare traffic for the same period against the CDT console when validating a new deployment; values labeled GB use the 1024³ conversion. See [deployment's first-live-run verification](deployment.md#6-first-live-run-verification--performed-before-cron-is-enabled).

## 4. Read D1 history

    curl --fail-with-body --user "$ADMIN_USER" \
      "https://<worker-host>/api/history?limit=50"

Curl prompts for ADMIN_TOKEN without adding it to shell history or the process arguments.

The default is 50 rows and the hard maximum is 200. Results are newest first. D1 records scheduled observations; it is not a control input. Missing D1 or a failed history query can affect history display without creating a control decision.

## 5. Probe Cron telemetry

Use the separate monitor token, never the admin password. Supply it to the shell through a secret manager or hidden prompt, then stream the curl config over stdin. The value is not in shell history or curl's process arguments; do not enable shell tracing.

    curl --fail-with-body --config - <<EOF
    header = "Authorization: Bearer $MONITOR_READ_TOKEN"
    url = "https://<worker-host>/api/monitor/cron"
    EOF

The route returns a sanitized snapshot with cron_health, timestamps, bounded success/failure counts, and a classified failure stage. It does not return raw D1 rows or ECS state. It rejects credentials in query parameters and applies Cache-Control: no-store.

Possible cron_health values are HEALTHY, DEGRADED, UNHEALTHY, and UNKNOWN. A missing D1 binding or failed read yields UNKNOWN; it is not evidence of a healthy Cron. See [monitoring](monitoring.md) for classification and incident handling.

## Donor UI honesty

- Adapted reads include status/refresh, history, logs, safe configuration projection, and optional billing status.
- Manual webhook, email, and Telegram tests require both configuration and their default-off feature gates. When enabled, they send external messages.
- control_instance is an explicit unimplemented 501; it never starts or stops ECS.
- save_config is unavailable; browser configuration writes are not persisted. Change Worker settings out of band.
- Other unsupported donor actions return non-success placeholders with mutation: false.

These replies describe backend behavior, not claims made by the static donor UI. 501 and mutation: false do not mean an external notification test had no messaging side effect; they mean it cannot mutate ECS.
