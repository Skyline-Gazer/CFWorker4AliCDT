export interface ProbeResult {
  readonly timestamp: string;
  readonly http_status: number | null;
  readonly latency_ms: number | null;
  readonly ok: boolean;
  readonly failure_reason: string | null;
  readonly probe_url: string;
  readonly cron_health: "UNKNOWN";
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
