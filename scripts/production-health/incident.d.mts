import type { ProbeResult } from "./probe.mjs";

export interface IncidentIssue {
  readonly number: number;
  readonly title: string;
}

export interface IncidentAction {
  readonly action: "created" | "updated" | "closed" | "none";
  readonly issueNumber: number | null;
}

export type GhRunner = (args: readonly string[]) => Promise<string>;

export function incidentTitle(result: ProbeResult): string;
export function cronIncidentTitle(result: ProbeResult): string;
export function buildIncidentBody(result: ProbeResult, component?: "http" | "cron"): string;
export function buildRecoveryComment(result: ProbeResult, component?: "http" | "cron"): string;
export function syncIncident(result: ProbeResult, gh: GhRunner): Promise<IncidentAction>;
export function syncCronIncident(result: ProbeResult, gh: GhRunner): Promise<IncidentAction>;
export function syncIncidents(
  result: ProbeResult,
  gh: GhRunner,
): Promise<{ http: IncidentAction; cron: IncidentAction }>;
export function redactSensitiveText(value: unknown): string;
