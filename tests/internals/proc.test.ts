import { describe, expect, it } from "vitest";
import { defaultRunner, fakeRunner, missingToolRunner } from "../../src/internals/proc.js";

describe("proc runner seam", () => {
  it("fakeRunner returns canned results keyed off argv", async () => {
    const run = fakeRunner((argv) =>
      argv[0] === "nvidia-smi" ? { stdout: "8192, GPU" } : undefined,
    );
    expect(await run(["nvidia-smi"])).toMatchObject({ code: 0, stdout: "8192, GPU" });
    expect(await run(["other"])).toMatchObject({ code: 0, stdout: "" });
  });

  it("missingToolRunner signals spawnError", async () => {
    expect(await missingToolRunner(["x"])).toMatchObject({ spawnError: true, code: 127 });
  });

  it("defaultRunner runs a local process and captures stdout", async () => {
    const res = await defaultRunner([process.execPath, "-e", "process.stdout.write('hi')"]);
    expect(res.code).toBe(0);
    expect(res.stdout).toBe("hi");
  }, 15000);

  it("defaultRunner reports spawnError for a missing executable", async () => {
    const res = await defaultRunner(["definitely-not-a-real-binary-xyz123"]);
    expect(res.spawnError).toBe(true);
  });

  it("defaultRunner preserves timeout evidence", async () => {
    const res = await defaultRunner([process.execPath, "-e", "setTimeout(() => {}, 1000)"], {
      timeoutMs: 5,
    });

    expect(res.spawnError).toBe(true);
    expect(res.code).not.toBe(0);
    expect(res.stderr).toContain("timed out after 5ms");
  }, 15000);

  it("defaultRunner preserves timeout evidence alongside captured stderr", async () => {
    const res = await defaultRunner(
      [
        process.execPath,
        "-e",
        "process.stderr.write('started\\n', () => setTimeout(() => {}, 1000))",
      ],
      { timeoutMs: 500 },
    );

    expect(res.code).not.toBe(0);
    expect(res.stderr).toContain("started");
    expect(res.stderr).toContain("timed out after 500ms");
  }, 15000);

  it("defaultRunner closes stdin when no input is supplied", async () => {
    const res = await defaultRunner(
      [
        process.execPath,
        "-e",
        "process.stdin.on('end', () => process.stdout.write('ended')); process.stdin.resume();",
      ],
      { timeoutMs: 1000 },
    );

    expect(res.code).toBe(0);
    expect(res.stdout).toBe("ended");
  }, 15000);
});
