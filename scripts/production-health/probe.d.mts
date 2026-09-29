export interface ProbeResult {
  readonly timestamp: string;
  readonly http_status: number | null;
  readonly latency_ms: number | null;
  readonly ok: boolean;
  readonly failure_reason: string | null;
  readonly probe_url: string;
  readonly http_ok?: boolean;
  readonly http_failure_reason?: string | null;
  readonly http_probe_url?: string;
  readonly http_attempts?: number;
  readonly cron_health: "HEALTHY" | "DEGRADED" | "UNHEALTHY" | "UNKNOWN";
  readonly cron_ok?: boolean;
  readonly cron_telemetry_available?: boolean;
  readonly cron_failure_reason?: string | null;
  readonly cron_probe_url?: string;
  readonly cron_probe_attempts?: number;
  readonly cron_observation_ts?: string;
  readonly cron_last_execution_ts?: string | null;
  readonly cron_last_success_ts?: string | null;
  readonly cron_latest_status?: "success" | "error" | "unknown" | null;
  readonly cron_recent_success_count?: number;
  readonly cron_recent_failure_count?: number;
  readonly cron_failure_classification?: string | null;
  readonly cron_telemetry_error?: string;
  readonly attempts: number;
  readonly expected_status: 200;
  readonly expected_body_status: "ok";
  readonly expected_service: "cfworker4alicdt";
  readonly run_url?: string;
}

export interface ProbeResponse {
  readonly status: number;
  json(): Promise<unknown>;
}

export interface ProbeRequestInit {
  readonly method: "GET";
  readonly headers: Readonly<Record<string, string>>;
  readonly signal: AbortSignal;
}

export interface ProbeOptions {
  readonly url?: string;
  readonly runUrl?: string;
  readonly fetchImpl?: (url: string, init: ProbeRequestInit) => Promise<ProbeResponse>;
  readonly now?: () => number;
  readonly delay?: (milliseconds: number) => Promise<void>;
  readonly timeoutMs?: number;
  readonly maxAttempts?: number;
  readonly backoffMs?: number;
}

export function probeHealth(options?: ProbeOptions): Promise<ProbeResult>;

export interface CronProbeOptions extends Omit<ProbeOptions, "runUrl"> {
  readonly token?: string;
}

export function probeCron(options?: CronProbeOptions): Promise<Partial<ProbeResult>>;
