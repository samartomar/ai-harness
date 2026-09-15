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

  it("marks bounded output as truncated instead of treating its partial bytes as complete", async () => {
    const res = await defaultRunner(
      [process.execPath, "-e", "process.stdout.write('x'.repeat(1024))"],
      { maxBufferBytes: 64 },
    );

    expect(res.spawnError).toBeUndefined();
    expect(res.truncated).toBe(true);
    expect(res.stderr).toContain("output exceeded 64 bytes");
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
      [process.execPath, "-e", "process.stderr.write('started\\n'); setTimeout(() => {}, 5000)"],
      { timeoutMs: 2000 },
    );

    expect(res.code).not.toBe(0);
    expect(res.stderr).toContain("started");
    expect(res.stderr).toContain("timed out after 2000ms");
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

  it("keeps stdin open and advances an interactive process only after each response", async () => {
    const script = [
      "const readline = require('node:readline');",
      "const input = readline.createInterface({ input: process.stdin });",
      "let id = 0;",
      "input.on('line', (line) => {",
      "  id += 1;",
      "  process.stdout.write(JSON.stringify({ id, line }) + '\\n');",
      "});",
    ].join("\n");
    const response = (id: number) => (stdout: string) => {
      const ready = stdout.split(/\r?\n/u).some((line) => {
        try {
          return (JSON.parse(line) as { id?: unknown }).id === id;
        } catch {
          return false;
        }
      });
      return { state: ready ? ("ready" as const) : ("waiting" as const) };
    };

    const res = await defaultRunner([process.execPath, "-e", script], {
      inputSequence: [
        { input: "initialize\n", inspectStdout: response(1) },
        { input: "tools/list\n", inspectStdout: response(2) },
        { input: "tools/call\n", inspectStdout: response(3) },
      ],
      timeoutMs: 5000,
    });

    expect(res.code).toBe(0);
    expect(
      res.stdout
        .trim()
        .split(/\r?\n/u)
        .map((line) => JSON.parse(line)),
    ).toEqual([
      { id: 1, line: "initialize" },
      { id: 2, line: "tools/list" },
      { id: 3, line: "tools/call" },
    ]);
  }, 15000);

  it.each([1, 2])(
    "stops an interactive child after response %i fails without sending later input",
    async (failedId) => {
      const script = [
        "const readline = require('node:readline');",
        "const input = readline.createInterface({ input: process.stdin });",
        `const failedId = ${String(failedId)};`,
        "input.on('line', (line) => {",
        "  const request = JSON.parse(line);",
        "  const envelope = request.id === failedId",
        "    ? { jsonrpc: '2.0', id: request.id, error: { code: -32000, message: 'rejected' } }",
        "    : { jsonrpc: '2.0', id: request.id, result: { ok: true } };",
        "  process.stdout.write(JSON.stringify(envelope) + '\\n');",
        "});",
      ].join("\n");
      const inspect = (id: number) => (stdout: string) => {
        for (const line of stdout.split(/\r?\n/u)) {
          try {
            const response = JSON.parse(line) as Record<string, unknown>;
            if (response.jsonrpc !== "2.0" || response.id !== id) continue;
            return Object.hasOwn(response, "error")
              ? { state: "failed" as const, detail: `response ${id} failed` }
              : { state: "ready" as const };
          } catch {
            // Wait for a complete line.
          }
        }
        return { state: "waiting" as const };
      };

      const res = await defaultRunner([process.execPath, "-e", script], {
        inputSequence: [1, 2, 3].map((id) => ({
          input: `${JSON.stringify({ id })}\n`,
          inspectStdout: inspect(id),
        })),
        timeoutMs: 5000,
      });

      expect(res.code).toBe(1);
      expect(res.stderr).toBe(`response ${failedId} failed`);
      const received = res.stdout
        .trim()
        .split(/\r?\n/u)
        .filter(Boolean)
        .map((line) => (JSON.parse(line) as { id: number }).id);
      expect(received).toEqual(Array.from({ length: failedId }, (_value, index) => index + 1));
    },
    15000,
  );

  it("settles safely when a child exits before a large stdin payload is written", async () => {
    const res = await defaultRunner([process.execPath, "-e", "process.exit(23)"], {
      input: "x".repeat(8 * 1024 * 1024),
      timeoutMs: 5000,
    });

    expect(res.code).not.toBe(0);
  }, 15000);

  it("aborts a running child through the runner seam", async () => {
    const controller = new AbortController();
    const pending = defaultRunner(
      [process.execPath, "-e", "process.stdin.resume(); setTimeout(() => {}, 5000)"],
      { signal: controller.signal, timeoutMs: 10_000 },
    );
    controller.abort();

    await expect(pending).resolves.toMatchObject({ spawnError: true });
  }, 15000);
});
