#!/usr/bin/env node
import { defaultRunner } from "./proc.js";
import {
  findTrackedArtifactViolations,
  formatTrackedArtifactViolations,
} from "./tracked-artifacts.js";

async function main(): Promise<number> {
  const res = await defaultRunner(["git", "ls-files", "-z"], { cwd: process.cwd() });
  if (res.spawnError || res.code !== 0) {
    const detail = res.stderr.trim() || res.stdout.trim() || `exit ${res.code}`;
    console.error(`tracked artifact guard could not read the Git index: ${detail}`);
    return 2;
  }

  const violations = findTrackedArtifactViolations(res.stdout.split("\0"));
  if (violations.length > 0) {
    console.error(formatTrackedArtifactViolations(violations));
    return 1;
  }

  console.log("Tracked artifact guard passed.");
  return 0;
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exitCode = 2;
  });
