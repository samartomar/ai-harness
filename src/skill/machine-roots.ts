import { join } from "node:path";
import type { Cli } from "../internals/clis.js";
import { entry, REGISTRY_IDS } from "../internals/cli-registry.js";

export interface MachineSkillRoot {
  cli: Cli;
  abs: string;
}

export function machineSkillRootForCli(home: string, cli: Cli): MachineSkillRoot | undefined {
  const machineSkillDir = entry(cli).machineSkillDir;
  if (machineSkillDir === undefined) return undefined;
  return { cli, abs: join(home, machineSkillDir) };
}

export function machineSkillRoots(home: string): MachineSkillRoot[] {
  return REGISTRY_IDS.flatMap((id) => {
    const root = machineSkillRootForCli(home, id as Cli);
    return root === undefined ? [] : [root];
  });
}

export function supportedMachineSkillCliList(): string {
  return machineSkillRoots("")
    .map((root) => root.cli)
    .join(", ");
}
