import { defaultRunner, type Runner } from "../internals/proc.js";
import type { HostAdapter, Platform } from "./base.js";
import { DarwinAdapter } from "./darwin.js";
import { LinuxAdapter } from "./linux.js";
import { WindowsAdapter } from "./windows.js";

/** Resolve the effective platform, honoring the `AIH_PLATFORM` test override. */
export function resolvePlatform(env: NodeJS.ProcessEnv = process.env): Platform {
  const override = env.AIH_PLATFORM;
  if (override === "windows" || override === "darwin" || override === "linux") {
    return override;
  }
  if (process.platform === "win32") return "windows";
  if (process.platform === "darwin") return "darwin";
  return "linux";
}

export interface HostAdapterOptions {
  platform?: Platform;
  run?: Runner;
  env?: NodeJS.ProcessEnv;
}

/** Construct the host adapter for this (or an overridden) platform. */
export function makeHostAdapter(opts: HostAdapterOptions = {}): HostAdapter {
  const env = opts.env ?? process.env;
  const platform = opts.platform ?? resolvePlatform(env);
  const run = opts.run ?? defaultRunner;
  switch (platform) {
    case "windows":
      return new WindowsAdapter(run, env);
    case "darwin":
      return new DarwinAdapter(run, env);
    case "linux":
      return new LinuxAdapter(run, env);
  }
}
