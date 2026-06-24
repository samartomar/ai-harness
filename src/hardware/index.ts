import {
  type CommandSpec,
  doc,
  envBlock,
  type PlanContext,
  plan,
  probe,
} from "../internals/plan.js";
import { sizeForHost } from "./sizing.js";
import { HARDWARE_SCOPE, inferenceEnv, profileDoc } from "./templates.js";

/**
 * `hardware` — profile the local workstation and emit tuned local-inference
 * settings. The capability is local-only: it reads CPU/RAM/GPU through the host
 * adapter (which shells to PowerShell/sysctl/nvidia-smi, never the network) and
 * writes an idempotent OLLAMA_* block into the shell profile. No remote system is
 * contacted or mutated, so the boundary holds: this is `write` + `doc` + `probe`.
 *
 * Thin adapter: the sizing math lives in ./sizing.ts and the env/doc bodies in
 * ./templates.ts; this file only wires the host probe → sizing → actions.
 */

const DEFAULT_MODEL_SIZE_GB = 5;

/** Parse the `--model-size-gb` option (a CLI string) into a positive number. */
function modelSizeGb(options: Record<string, unknown>): number {
  const raw = options.modelSizeGb;
  const n = typeof raw === "number" ? raw : Number.parseFloat(String(raw ?? ""));
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_MODEL_SIZE_GB;
}

async function buildPlan(ctx: PlanContext) {
  const [cpuCores, totalRamGb, gpu] = await Promise.all([
    ctx.host.cpuPhysicalCores(),
    ctx.host.totalRamGb(),
    ctx.host.gpu(),
  ]);
  const profile = { totalRamGb, cpuCores, gpu };
  const modelGb = modelSizeGb(ctx.options);
  const sizing = sizeForHost(profile, modelGb);

  const profilePath = ctx.host.shellProfilePaths()[0] ?? "";

  const summary = profileDoc(
    {
      totalRamGb,
      cpuCores,
      gpuName: gpu.name ?? gpu.vendor,
      vramGb: gpu.vramGb,
      backend: gpu.backend,
    },
    sizing,
    modelGb,
  );

  return plan(
    "hardware",
    envBlock(
      profilePath,
      HARDWARE_SCOPE,
      ctx.host.envShell(),
      inferenceEnv(sizing),
      `Write tuned OLLAMA_* env block (parallel=${sizing.parallelRequests}, quant=${sizing.quantization}) to the shell profile`,
    ),
    doc(
      "Workstation profile and derived inference budget",
      summary,
      `${ctx.contextDir}/hardware-profile.txt`,
    ),
    probe("inference sizing is internally consistent", () => {
      const recomputed = sizeForHost(profile, modelGb);
      const ok =
        recomputed.threads >= 1 &&
        recomputed.parallelRequests >= 1 &&
        recomputed.serverMemoryGb >= 0 &&
        recomputed.serverMemoryGb <= totalRamGb;
      return ok
        ? {
            name: "hardware sizing",
            verdict: "pass" as const,
            detail: `mem=${recomputed.serverMemoryGb}GB threads=${recomputed.threads} parallel=${recomputed.parallelRequests} quant=${recomputed.quantization}`,
          }
        : {
            name: "hardware sizing",
            verdict: "fail" as const,
            detail: "sizing produced an out-of-range value",
          };
    }),
  );
}

export const command: CommandSpec = {
  name: "hardware",
  summary: "Profile CPU/RAM/GPU and emit tuned local-inference settings (Ollama/llama.cpp)",
  options: [
    {
      flags: "--model-size-gb <n>",
      description: "model weight size in GB used for parallel-request sizing",
      default: "5",
    },
    {
      flags: "--engine <engine>",
      description: "target inference engine: ollama|llamacpp",
      default: "ollama",
    },
  ],
  plan: buildPlan,
};
