/**
 * Cloudflare Worker entry point.
 *
 * Scheduled-only. The HTTP surface is deliberately limited to `GET /health`;
 * there is no route by which an ECS instance can be controlled, and the fetch
 * handler MUST NOT trigger a monitor run (SPEC §8).
 *
 * The monitor pipeline is wired in here from P6 onward. Until then this module
 * exposes the two entry points and nothing else.
 */

export interface Env {
  readonly ALIYUN_ACCESS_KEY_ID: string;
  readonly ALIYUN_ACCESS_KEY_SECRET: string;
  readonly WEBHOOK_URL: string;
  readonly WEBHOOK_TOKEN: string;
  readonly REGION_ID: string;
  readonly ECS_INSTANCE_ID: string;
  readonly TRAFFIC_THRESHOLD_GB?: string;
  readonly CDT_ENDPOINT?: string;
  readonly BUSINESS_REGION_ID?: string;
  readonly SIGNATURE_VERSION?: string;
  readonly STOPPED_MODE?: string;
}

export interface HealthResponse {
  readonly status: "ok";
  readonly service: "cfworker4alicdt";
}

/** Static liveness body. Discloses no configuration value (SPEC §8). */
export const healthResponse: HealthResponse = {
  status: "ok",
  service: "cfworker4alicdt",
};

export default {
  async scheduled(
    _controller: ScheduledController,
    _env: Env,
    _ctx: ExecutionContext,
  ): Promise<void> {
    // Wired in P4.3/P6.1.
  },

  async fetch(request: Request): Promise<Response> {
    const { pathname } = new URL(request.url);
    if (request.method === "GET" && pathname === "/health") {
      return Response.json(healthResponse);
    }
    return new Response("Not Found", { status: 404 });
  },
} satisfies ExportedHandler<Env>;
