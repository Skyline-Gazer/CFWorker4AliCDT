import type { GhRunner } from "./incident.mjs";
import type { ProbeResult } from "./probe.mjs";

export function runGh(args: readonly string[]): Promise<string>;

export function main(options?: {
  readonly resultPath?: string;
  readonly gh?: GhRunner;
}): Promise<ProbeResult>;
