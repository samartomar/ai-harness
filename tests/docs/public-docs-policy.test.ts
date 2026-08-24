import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const root = process.cwd();

function read(path: string): string {
  return readFileSync(join(root, path), "utf8");
}

describe("public docs policy", () => {
  it("keeps the agent-ready demo source-scoped and cross-platform", () => {
    const demo = read("examples/agent-ready-demo/README.md");

    expect(demo).toContain(
      "> Public demo data only. No customer data, no private org telemetry, no real user activity,\n> and no production export.",
    );
    expect(demo).toContain("source-checkout-only");
    expect(demo).toContain(`mktemp -d "\${TMPDIR:-/tmp}/aih-demo.XXXXXX"`);
    expect(demo).toContain('"aih-demo-$([guid]::NewGuid())"');
    expect(demo.match(/Get-ChildItem -File -Recurse/gu)).toHaveLength(2);
    expect(demo).toContain('node "$repo_root/dist/cli.js" doctor .');
    expect(demo).toContain('node (Join-Path $repoRoot "dist/cli.js") doctor .');
    expect(
      demo.match(
        /git -c user\.name="AIH Demo" -c user\.email="aih-demo@example\.invalid" commit -m "chore: seed demo"/gu,
      ),
    ).toHaveLength(2);
    expect(demo).toContain("What this demo demonstrates");
    expect(demo).toContain("writes the supported repository-owned setup selected by the plan");
    expect(demo).not.toContain("What this demo proves");
    expect(demo).not.toContain("mkdir -p /tmp/aih-demo");
  });

  it("keeps the documented scrub command aligned with published public docs roots", () => {
    const policy = read("PUBLIC_DOCS_POLICY.md");
    const pkg = JSON.parse(read("package.json")) as { files?: string[] };
    const scrubBlock = /```bash\n([\s\S]*?)\n```/u.exec(policy)?.[1] ?? "";
    const publishedPublicDocs = new Set([
      ...(pkg.files ?? []).filter((entry) => entry === "guides" || entry.startsWith("docs/")),
      "README.md",
      "SECURITY.md",
      "SUPPORT.md",
      "PUBLIC_DOCS_POLICY.md",
    ]);

    for (const entry of publishedPublicDocs) {
      const rootEntry = entry.startsWith("docs/") ? "docs" : entry;
      expect(scrubBlock).toContain(rootEntry);
    }
  });

  it("keeps demo report reference artifacts visibly labeled as demo data", () => {
    const reference = read("docs/specs/local-report-v9/reference-v9.html");

    expect(reference).toContain('<body data-demo="on">');
    expect(reference).toContain('class="demo-banner"');
    expect(reference).toContain("Public demo data only");
    expect(reference).toContain("no real user activity");
    expect(reference).toContain("Demo reference activity");
    expect(reference).not.toContain("Real git activity");
  });
});
