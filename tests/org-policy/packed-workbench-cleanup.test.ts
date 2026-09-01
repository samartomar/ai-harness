import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";

describe("packed Workbench authoring cleanup (#911)", () => {
  it("terminates Happy DOM tasks when authoring fails", () => {
    const fixtureRoot = mkdtempSync(join(tmpdir(), "aih-workbench-cleanup-"));
    const htmlPath = join(fixtureRoot, "workbench.html");
    const outputPath = join(fixtureRoot, "policy.json");
    writeFileSync(htmlPath, "<script>setInterval(() => undefined, 10)</script>\n");

    try {
      const helperUrl = pathToFileURL(
        resolve("tools/lib/author-protected-policy-via-workbench.mjs"),
      ).href;
      const child = spawnSync(process.execPath, ["--input-type=module", "-"], {
        encoding: "utf8",
        input: [
          `import { authorProtectedPolicyViaPackedWorkbench } from ${JSON.stringify(helperUrl)};`,
          `try {`,
          `  await authorProtectedPolicyViaPackedWorkbench({ htmlPath: ${JSON.stringify(htmlPath)}, outputPath: ${JSON.stringify(outputPath)}, authorityFields: {}, decisions: [] });`,
          `  throw new Error("expected authoring refusal");`,
          `} catch (error) {`,
          `  if (!String(error?.message).includes("packed-workbench-enterprise-preset-missing")) throw error;`,
          `}`,
          `process.stdout.write("cleanup-complete");`,
        ].join("\n"),
        timeout: 3_000,
      });

      expect(child.error).toBeUndefined();
      expect(child.status).toBe(0);
      expect(child.stdout).toBe("cleanup-complete");
    } finally {
      rmSync(fixtureRoot, { recursive: true, force: true });
    }
  });
});
