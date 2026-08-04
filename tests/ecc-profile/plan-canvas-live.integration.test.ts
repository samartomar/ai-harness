import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  createPlanCanvasAdapter,
  createPlanCanvasArtifactSnapshot,
  materializePlanCanvasRuntime,
  PLAN_CANVAS_RUNTIME_PIN,
} from "../../src/ecc-profile/plan-canvas.js";

const sourceRoot = process.env.AIH_PLAN_CANVAS_SOURCE_ROOT;
const roots: string[] = [];

afterAll(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function httpRequest(
  port: number,
  method: string,
  path: string,
  headers: Record<string, string>,
  body?: string,
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, method, path, headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk: Buffer) => chunks.push(chunk));
      res.on("end", () =>
        resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") }),
      );
    });
    req.on("error", reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

describe.skipIf(sourceRoot === undefined)("installed Plan Canvas runtime", () => {
  it("materializes only the complete authenticated source closure", () => {
    const root = mkdtempSync(join(tmpdir(), "aih-plan-canvas-source-"));
    roots.push(root);
    const copiedSource = join(root, "source");
    mkdirSync(copiedSource);
    for (const file of PLAN_CANVAS_RUNTIME_PIN.sourceFiles) {
      const destination = join(copiedSource, ...file.path.split("/"));
      mkdirSync(dirname(destination), { recursive: true });
      writeFileSync(destination, readFileSync(join(sourceRoot ?? "", ...file.path.split("/"))), {
        flag: "wx",
      });
    }
    const runtime = materializePlanCanvasRuntime({
      sourceRoot: copiedSource,
      verifiedIntegrity: PLAN_CANVAS_RUNTIME_PIN.integrity,
      destinationRoot: join(root, "runtime"),
    });
    expect(runtime.closureSha256).toBe(PLAN_CANVAS_RUNTIME_PIN.closureSha256);

    writeFileSync(join(copiedSource, "scripts", "lib", "plan-canvas", "server.js"), "tampered");
    expect(() =>
      materializePlanCanvasRuntime({
        sourceRoot: copiedSource,
        verifiedIntegrity: PLAN_CANVAS_RUNTIME_PIN.integrity,
        destinationRoot: join(root, "other-runtime"),
      }),
    ).toThrow(/hash mismatch|missing/i);
  });

  it("enforces loopback request guards and returns a revision-bound verdict", async () => {
    const root = mkdtempSync(join(tmpdir(), "aih-plan-canvas-live-"));
    roots.push(root);
    const artifacts = join(root, "artifacts");
    const state = join(root, "state");
    mkdirSync(artifacts);
    mkdirSync(state);
    const artifact = join(artifacts, "native.plan.md");
    writeFileSync(
      artifact,
      "# Native Plan Canvas qualification\n\n```mermaid\ngraph TD\n  A --> B\n```\n",
      "utf8",
    );
    const outsideArtifact = join(root, "outside.plan.md");
    writeFileSync(outsideArtifact, "# Must never be reviewable\n", "utf8");
    const runtime = materializePlanCanvasRuntime({
      sourceRoot: sourceRoot ?? "",
      verifiedIntegrity: PLAN_CANVAS_RUNTIME_PIN.integrity,
      destinationRoot: join(root, "runtime"),
    });
    const review = createPlanCanvasArtifactSnapshot({
      artifactRoot: artifacts,
      artifactPath: artifact,
      stateRoot: state,
    });
    const port = 47_000 + Math.floor(Math.random() * 1_000);
    const adapter = createPlanCanvasAdapter({ runtime, stateRoot: state, port });
    try {
      const opened = await adapter.open(review, { launchBrowser: false });
      const url = new URL(String(opened.url));
      const key = url.pathname.split("/").pop();
      expect(key).toMatch(/^[a-f0-9]{12}$/);

      await expect(
        httpRequest(port, "GET", "/health", { Host: "attacker.example" }),
      ).resolves.toMatchObject({ status: 403 });
      await expect(
        httpRequest(port, "GET", "/health", { Host: "127.0.0.1:99999" }),
      ).resolves.toMatchObject({ status: 403 });
      await expect(
        httpRequest(port, "GET", "/health", {
          Host: `127.0.0.1:${port}`,
          Origin: "https://attacker.example",
        }),
      ).resolves.toMatchObject({ status: 403 });
      await expect(
        httpRequest(port, "GET", "/health", { Host: `127.0.0.1:${port}` }),
      ).resolves.toMatchObject({ status: 200 });
      const rendered = await httpRequest(port, "GET", `/artifact/${key}/`, {
        Host: `127.0.0.1:${port}`,
      });
      expect(rendered).toMatchObject({ status: 200 });
      expect(rendered.body).toContain("data:text/javascript");
      expect(rendered.body).not.toContain("cdn.jsdelivr.net");

      const outsideOpen = JSON.stringify({ file: outsideArtifact });
      await expect(
        httpRequest(
          port,
          "POST",
          "/api/sessions",
          {
            Host: `127.0.0.1:${port}`,
            Origin: `http://127.0.0.1:${port}`,
            "Content-Type": "application/json",
            "Content-Length": String(Buffer.byteLength(outsideOpen)),
          },
          outsideOpen,
        ),
      ).resolves.toMatchObject({ status: 403 });

      const feedback = JSON.stringify({
        items: [{ kind: "verdict", verdict: "approve" }],
      });
      await expect(
        httpRequest(
          port,
          "POST",
          `/api/session/${key}/feedback`,
          {
            Host: `127.0.0.1:${port}`,
            Origin: `http://127.0.0.1:${port}`,
            "Content-Type": "application/json",
            "Content-Length": String(Buffer.byteLength(feedback)),
          },
          feedback,
        ),
      ).resolves.toMatchObject({ status: 200 });
      await expect(adapter.awaitFeedback(review)).resolves.toMatchObject({
        status: "feedback",
        revisionSha256: review.revisionSha256,
        items: [{ kind: "verdict", verdict: "approve" }],
      });
      await adapter.end(review);
    } finally {
      await adapter.stop().catch(() => undefined);
    }
  });
});
