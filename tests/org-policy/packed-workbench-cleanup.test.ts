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
          `  if (!String(error?.message).includes("packed-workbench-supported-cli-missing-for-protected-target")) throw error;`,
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

  it("sanctions every protected target before enterprise authoring", () => {
    const fixtureRoot = mkdtempSync(join(tmpdir(), "aih-workbench-multitarget-"));
    const htmlPath = join(fixtureRoot, "workbench.html");
    const outputPath = join(fixtureRoot, "policy.json");
    writeFileSync(
      htmlPath,
      [
        '<input id="protected-targets">',
        '<select id="posture"><option value="vibe">Vibe</option><option value="enterprise">Enterprise</option></select>',
        '<button data-sanctioned-cli="claude" aria-pressed="false">claude</button>',
        '<button data-sanctioned-cli="codex" aria-pressed="false">codex</button>',
        '<form id="protected-form"></form>',
        '<button id="download-protected-bundle">download</button>',
        '<textarea id="protected-bundle-preview" readonly></textarea>',
        '<div id="announcement"></div>',
        `<script>
          document.addEventListener("click", (event) => {
            const control = event.target.closest("[data-sanctioned-cli]");
            if (control) control.setAttribute("aria-pressed", "true");
          });
          document.getElementById("protected-form").addEventListener("submit", () => {
            window.__aihPolicyWorkbenchPending = Promise.resolve();
          });
          document.getElementById("download-protected-bundle").addEventListener("click", () => {
            const targets = [...document.querySelectorAll("[data-sanctioned-cli]")]
              .filter((control) => control.getAttribute("aria-pressed") === "true")
              .map((control) => control.getAttribute("data-sanctioned-cli"));
            if (targets.length !== 2) {
              window.__aihPolicyWorkbenchPending = Promise.reject(new Error("missing sanctioned target"));
              return;
            }
            const preview = document.getElementById("protected-bundle-preview");
            preview.value = JSON.stringify({ targets });
            const anchor = document.createElement("a");
            anchor.download = "aih-policy-bundle.json";
            anchor.href = URL.createObjectURL(new Blob([preview.value]));
            anchor.click();
            window.__aihPolicyWorkbenchPending = Promise.resolve();
          });
        </script>`,
      ].join("\n"),
    );

    try {
      const helperUrl = pathToFileURL(
        resolve("tools/lib/author-protected-policy-via-workbench.mjs"),
      ).href;
      const child = spawnSync(process.execPath, ["--input-type=module", "-"], {
        encoding: "utf8",
        input: [
          `import { authorProtectedPolicyViaPackedWorkbench } from ${JSON.stringify(helperUrl)};`,
          `const bundle = await authorProtectedPolicyViaPackedWorkbench({`,
          `  htmlPath: ${JSON.stringify(htmlPath)},`,
          `  outputPath: ${JSON.stringify(outputPath)},`,
          `  authorityFields: { "protected-targets": "claude" },`,
          `  decisions: [{ "protected-targets": "codex" }],`,
          `});`,
          `if (JSON.stringify(bundle.targets) !== JSON.stringify(["claude", "codex"])) throw new Error("targets not sanctioned");`,
          `process.stdout.write("all-targets-sanctioned");`,
        ].join("\n"),
        timeout: 3_000,
      });

      expect(child.error).toBeUndefined();
      expect(child.status).toBe(0);
      expect(child.stdout).toBe("all-targets-sanctioned");
    } finally {
      rmSync(fixtureRoot, { recursive: true, force: true });
    }
  });
});
