import type { GpuInfo } from "../platform/base.js";

/**
 * Workstation resource-sizing math for local inference, lifted directly from the
 * blueprint's "Resource Sizing and Tuning Formulations" and "Local Quantization
 * Evaluation Matrix". Every constant here mirrors a blueprint parameter so the
 * generated env block is auditable against the spec — see the named constants
 * below for the formula each one belongs to.
 *
 * The functions are pure (no I/O, no runner) so they unit-test exactly and the
 * emitted env block regenerates byte-identically on re-run.
 */

/**
 * Fraction of total RAM the model server may use; the remaining 1 − this is the
 * blueprint's reserved boundary for host OS processes and open IDE workspaces
 * (protects against OOM crashes). M_server = floor(HOST_MEMORY_FRACTION · M_total).
 */
export const HOST_MEMORY_FRACTION = 0.8;

/**
 * Physical cores reserved for system interrupt handling; the thread pool is
 * cores − this. Setting threads above physical cores thrashes on context
 * switching, so the pool never exceeds (cores − RESERVED_CORES).
 */
export const RESERVED_CORES = 2;

/**
 * Context-buffer expansion factor applied per concurrent request to account for
 * KV-cache growth during sequence generation. parallel = M_server / (modelGb · this).
 */
export const KV_CACHE_EXPANSION = 1.2;

/** A row of the blueprint's quantization evaluation matrix. */
export interface Quantization {
  /** Format label as it appears in the matrix (e.g. "Q4_K_M"). */
  readonly name: string;
  /** Bits per weight. */
  readonly bitsPerWeight: number;
  /** Model memory as a fraction of the FP16 base size. */
  readonly memoryFraction: number;
  /** Minimum VRAM (GB) this format targets, per the matrix's sizing column. */
  readonly minVramGb: number;
  /** One-line accuracy/footprint note from the matrix. */
  readonly note: string;
}

/**
 * The quantization matrix, ordered most-precise → most-compressed (matches the
 * blueprint table top-to-bottom). `minVramGb` encodes each row's "Hardware
 * Sizing Target": FP16 server-grade, Q8_0 ≥24GB, Q5_K_M 16GB, Q4_K_M 8–12GB,
 * Q3_K_S 8GB unified.
 */
export const QUANTIZATIONS: readonly Quantization[] = [
  {
    name: "FP16",
    bitsPerWeight: 16,
    memoryFraction: 1.0,
    minVramGb: 48,
    note: "Complete baseline; multi-GPU server-grade hosts",
  },
  {
    name: "Q8_0",
    bitsPerWeight: 8,
    memoryFraction: 0.5,
    minVramGb: 24,
    note: "Near-identical to FP16; workstations with >= 24GB VRAM",
  },
  {
    name: "Q5_K_M",
    bitsPerWeight: 5,
    memoryFraction: 0.33,
    minVramGb: 16,
    note: "Minimal quality loss; mid-tier workstations (16GB VRAM)",
  },
  {
    name: "Q4_K_M",
    bitsPerWeight: 4,
    memoryFraction: 0.25,
    minVramGb: 8,
    note: "High accuracy, recommended default; 8GB to 12GB VRAM",
  },
  {
    name: "Q3_K_S",
    bitsPerWeight: 3,
    memoryFraction: 0.18,
    minVramGb: 0,
    note: "Perceptible quality loss; legacy laptops (8GB unified RAM)",
  },
] as const;

/** The blueprint's recommended balanced default for developer workstations. */
export const DEFAULT_QUANTIZATION = "Q4_K_M";

/** The most-compressed format; the floor when even the smallest tier is in doubt. */
export const FLOOR_QUANTIZATION = "Q3_K_S";

export interface HardwareProfile {
  /** Total physical RAM in GB. */
  totalRamGb: number;
  /** Physical CPU core count. */
  cpuCores: number;
  gpu: GpuInfo;
}

export interface SizingResult {
  /** Max memory (GB) for the model server: floor(0.8 · totalRamGb). */
  serverMemoryGb: number;
  /** Inference thread-pool size: max(1, cpuCores − 2). */
  threads: number;
  /** Max concurrent requests: floor(serverMemoryGb / (modelSizeGb · 1.2)), min 1. */
  parallelRequests: number;
  /** Recommended quantization name given available VRAM. */
  quantization: string;
}

/** M_server = floor(HOST_MEMORY_FRACTION · M_total); reserves the host boundary. */
export function serverMemoryGb(totalRamGb: number): number {
  if (!Number.isFinite(totalRamGb) || totalRamGb <= 0) return 0;
  return Math.floor(totalRamGb * HOST_MEMORY_FRACTION);
}

/** Thread pool = cores − RESERVED_CORES, floored at 1 so tiny hosts still run. */
export function inferenceThreads(cpuCores: number): number {
  if (!Number.isFinite(cpuCores) || cpuCores <= 0) return 1;
  return Math.max(1, cpuCores - RESERVED_CORES);
}

/**
 * parallel = floor(M_server / (modelGb · KV_CACHE_EXPANSION)), never below 1.
 * A non-positive model size cannot be sized against, so it degrades to 1.
 */
export function parallelRequests(serverMemGb: number, modelSizeGb: number): number {
  if (!Number.isFinite(modelSizeGb) || modelSizeGb <= 0) return 1;
  if (!Number.isFinite(serverMemGb) || serverMemGb <= 0) return 1;
  const perRequestGb = modelSizeGb * KV_CACHE_EXPANSION;
  return Math.max(1, Math.floor(serverMemGb / perRequestGb));
}

/**
 * Pick the highest-precision quantization whose `minVramGb` fits within
 * available VRAM (walking the matrix from FP16 down). Q3_K_S has `minVramGb` 0
 * so it is always reachable as the floor; a host with no GPU lands there.
 */
export function recommendQuantization(vramGb: number): string {
  const fits = QUANTIZATIONS.find((q) => vramGb >= q.minVramGb);
  return fits ? fits.name : FLOOR_QUANTIZATION;
}

/** Compute the full sizing result for a profiled host and a target model size. */
export function sizeForHost(profile: HardwareProfile, modelSizeGb: number): SizingResult {
  const mem = serverMemoryGb(profile.totalRamGb);
  return {
    serverMemoryGb: mem,
    threads: inferenceThreads(profile.cpuCores),
    parallelRequests: parallelRequests(mem, modelSizeGb),
    quantization: recommendQuantization(profile.gpu.vramGb),
  };
}
