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
export function buildIncidentBody(result: ProbeResult): string;
export function buildRecoveryComment(result: ProbeResult): string;
export function syncIncident(result: ProbeResult, gh: GhRunner): Promise<IncidentAction>;
export function redactSensitiveText(value: unknown): string;
