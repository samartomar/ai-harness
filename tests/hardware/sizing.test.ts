import { describe, expect, it } from "vitest";
import {
  DEFAULT_QUANTIZATION,
  HOST_MEMORY_FRACTION,
  inferenceThreads,
  KV_CACHE_EXPANSION,
  parallelRequests,
  QUANTIZATIONS,
  RESERVED_CORES,
  recommendQuantization,
  serverMemoryGb,
  sizeForHost,
} from "../../src/hardware/sizing.js";
import type { GpuInfo } from "../../src/platform/base.js";

const NO_GPU: GpuInfo = { vendor: "none", backend: "cpu", vramGb: 0 };

describe("blueprint sizing constants", () => {
  it("matches the blueprint formula parameters", () => {
    // Reserve ~20% of RAM for the host -> 0.8 fraction for the server.
    expect(HOST_MEMORY_FRACTION).toBe(0.8);
    // "reserving two physical cores for system interrupt handling".
    expect(RESERVED_CORES).toBe(2);
    // Context-buffer expansion factor for KV-cache growth.
    expect(KV_CACHE_EXPANSION).toBe(1.2);
    expect(DEFAULT_QUANTIZATION).toBe("Q4_K_M");
  });
});

describe("serverMemoryGb — M_server = floor(0.8 * M_total)", () => {
  it("reserves the host boundary and floors the result", () => {
    expect(serverMemoryGb(32)).toBe(25); // floor(25.6)
    expect(serverMemoryGb(16)).toBe(12); // floor(12.8)
    expect(serverMemoryGb(64)).toBe(51); // floor(51.2)
  });

  it("degrades to 0 for non-positive or non-finite RAM", () => {
    expect(serverMemoryGb(0)).toBe(0);
    expect(serverMemoryGb(-8)).toBe(0);
    expect(serverMemoryGb(Number.NaN)).toBe(0);
  });
});

describe("inferenceThreads — threads = cores - 2, floored at 1", () => {
  it("reserves two cores on multi-core hosts", () => {
    expect(inferenceThreads(8)).toBe(6);
    expect(inferenceThreads(16)).toBe(14);
    expect(inferenceThreads(4)).toBe(2);
  });

  it("never drops below 1 on small hosts", () => {
    expect(inferenceThreads(2)).toBe(1);
    expect(inferenceThreads(1)).toBe(1);
    expect(inferenceThreads(0)).toBe(1);
  });
});

describe("parallelRequests — floor(M_server / (modelGb * 1.2)), min 1", () => {
  it("scales concurrency by the per-request KV footprint", () => {
    // 25GB server, 5GB model -> 25 / (5*1.2)=25/6 -> floor 4.
    expect(parallelRequests(25, 5)).toBe(4);
    // 51GB server, 5GB model -> 51 / 6 -> floor 8.
    expect(parallelRequests(51, 5)).toBe(8);
    // 12GB server, 7GB model -> 12 / 8.4 -> floor 1.
    expect(parallelRequests(12, 7)).toBe(1);
  });

  it("never drops below 1 even when memory is tight", () => {
    expect(parallelRequests(2, 13)).toBe(1);
  });

  it("degrades to 1 for a non-positive model size or memory", () => {
    expect(parallelRequests(32, 0)).toBe(1);
    expect(parallelRequests(32, -1)).toBe(1);
    expect(parallelRequests(0, 5)).toBe(1);
  });
});

describe("recommendQuantization — highest precision that fits VRAM", () => {
  it("maps the blueprint matrix VRAM tiers to formats", () => {
    expect(recommendQuantization(48)).toBe("FP16");
    expect(recommendQuantization(24)).toBe("Q8_0");
    expect(recommendQuantization(16)).toBe("Q5_K_M");
    expect(recommendQuantization(12)).toBe("Q4_K_M");
    expect(recommendQuantization(8)).toBe("Q4_K_M");
  });

  it("falls to Q3_K_S when there is little or no VRAM (no GPU host)", () => {
    expect(recommendQuantization(0)).toBe("Q3_K_S");
    expect(recommendQuantization(4)).toBe("Q3_K_S");
  });

  it("recommends the balanced default on a typical 8-12GB workstation GPU", () => {
    expect(recommendQuantization(10)).toBe(DEFAULT_QUANTIZATION);
  });
});

describe("quantization matrix integrity", () => {
  it("is ordered most-precise to most-compressed with descending VRAM targets", () => {
    for (let i = 1; i < QUANTIZATIONS.length; i++) {
      const prev = QUANTIZATIONS[i - 1];
      const cur = QUANTIZATIONS[i];
      if (!prev || !cur) throw new Error("matrix gap");
      expect(prev.bitsPerWeight).toBeGreaterThan(cur.bitsPerWeight);
      expect(prev.minVramGb).toBeGreaterThanOrEqual(cur.minVramGb);
    }
  });

  it("includes every blueprint format with its bit width", () => {
    const byName = new Map(QUANTIZATIONS.map((q) => [q.name, q.bitsPerWeight]));
    expect(byName.get("FP16")).toBe(16);
    expect(byName.get("Q8_0")).toBe(8);
    expect(byName.get("Q5_K_M")).toBe(5);
    expect(byName.get("Q4_K_M")).toBe(4);
    expect(byName.get("Q3_K_S")).toBe(3);
  });
});

describe("sizeForHost — end-to-end on representative hosts", () => {
  it("sizes a 32GB / 8-core / 12GB-GPU developer workstation", () => {
    const r = sizeForHost(
      { totalRamGb: 32, cpuCores: 8, gpu: { vendor: "nvidia", backend: "cuda", vramGb: 12 } },
      5,
    );
    expect(r).toEqual({
      serverMemoryGb: 25,
      threads: 6,
      parallelRequests: 4,
      quantization: "Q4_K_M",
    });
  });

  it("sizes a no-GPU laptop down to CPU + Q3_K_S", () => {
    const r = sizeForHost({ totalRamGb: 16, cpuCores: 4, gpu: NO_GPU }, 5);
    expect(r.quantization).toBe("Q3_K_S");
    expect(r.threads).toBe(2);
    expect(r.serverMemoryGb).toBe(12);
    expect(r.parallelRequests).toBe(2); // 12 / (5*1.2)=2
  });
});
