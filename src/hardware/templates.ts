import type { EnvVar } from "../internals/envfile.js";
import { lines } from "../internals/render.js";
import type { SizingResult } from "./sizing.js";

/**
 * The local-inference env block from the blueprint's "Local Inference Engine
 * Configuration Profiles". The four static keys are emitted verbatim; the one
 * computed key (`OLLAMA_NUM_PARALLEL`) carries the sizing engine's parallel
 * count — Ollama's documented variable for that exact metric.
 *
 * Order is fixed so the managed block regenerates byte-identically on re-run.
 */

/** Static keys whose values come straight from the blueprint (not host-derived). */
export const STATIC_OLLAMA_ENV: readonly EnvVar[] = [
  { key: "OLLAMA_FLASH_ATTENTION", value: "1" },
  { key: "OLLAMA_KV_CACHE_TYPE", value: "q8_0" },
  { key: "OLLAMA_CONTEXT_LENGTH", value: "8192" },
  { key: "OLLAMA_KEEP_ALIVE", value: "-1" },
] as const;

/** The scope name used for the aih-managed env region in the shell profile. */
export const HARDWARE_SCOPE = "hardware";

/**
 * Build the ordered env vars for the inference engine: the four static blueprint
 * keys followed by the computed `OLLAMA_NUM_PARALLEL`. `llamacpp` shares the same
 * tuning surface, so the block is identical regardless of engine today; the
 * parameter is kept for forward compatibility and intent.
 */
export function inferenceEnv(sizing: SizingResult): EnvVar[] {
  return [
    ...STATIC_OLLAMA_ENV,
    { key: "OLLAMA_NUM_PARALLEL", value: String(sizing.parallelRequests) },
  ];
}

/**
 * Human-readable summary of the profiled host and the derived budget. Emitted as
 * a `doc` action: the memory ceiling and thread pool are per-request runtime
 * options in Ollama (not server env vars), so they are surfaced as guidance
 * rather than invented environment keys.
 */
export function profileDoc(
  profile: {
    totalRamGb: number;
    cpuCores: number;
    gpuName: string;
    vramGb: number;
    backend: string;
  },
  sizing: SizingResult,
  modelSizeGb: number,
): string {
  return lines(
    "Workstation hardware profile and local-inference budget",
    "=======================================================",
    "",
    `CPU physical cores : ${profile.cpuCores}`,
    `Total RAM          : ${profile.totalRamGb} GB`,
    `GPU                : ${profile.gpuName} (${profile.backend}, ${profile.vramGb} GB VRAM)`,
    "",
    "Derived budget (from the blueprint sizing formulas):",
    `  Model-server memory ceiling : ${sizing.serverMemoryGb} GB  (floor(0.8 x ${profile.totalRamGb}))`,
    `  Inference thread pool        : ${sizing.threads}  (cores - 2)`,
    `  Max parallel requests        : ${sizing.parallelRequests}  (server-mem / (${modelSizeGb}GB x 1.2))`,
    `  Recommended quantization     : ${sizing.quantization}`,
    "",
    "The OLLAMA_* env block is written to your shell profile. Memory ceiling and",
    "thread pool are passed per request (num_thread / context), not as server env.",
  );
}
