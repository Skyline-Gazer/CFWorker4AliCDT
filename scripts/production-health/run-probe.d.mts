import type { ProbeOptions, ProbeResult } from "./probe.mjs";

export interface ProductionHealthProbeOptions {
  readonly httpUrl?: string;
  readonly cronUrl?: string;
  readonly monitorToken?: string;
  readonly runUrl?: string;
  readonly fetchImpl?: ProbeOptions["fetchImpl"];
  readonly now?: ProbeOptions["now"];
  readonly delay?: ProbeOptions["delay"];
  readonly timeoutMs?: number;
  readonly maxAttempts?: number;
  readonly backoffMs?: number;
}

export function probeProductionHealth(options?: ProductionHealthProbeOptions): Promise<ProbeResult>;

export function main(
  env?: Record<string, string | undefined>,
  options?: Pick<ProductionHealthProbeOptions, "fetchImpl" | "now" | "delay">,
): Promise<ProbeResult>;
