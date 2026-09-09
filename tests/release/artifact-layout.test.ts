import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

type Step = { name?: string; run?: string; with?: { path?: string } };
const workflow = parse(readFileSync(".github/workflows/release.yml", "utf8")) as {
  jobs: Record<string, { steps: Step[] }>;
};
const tarball = "aihq-core-0.6.1.tgz";
const hash = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
function step(job: string, name: string): Step {
  const result = workflow.jobs[job]?.steps.find((value) => value.name === name);
  expect(result, name).toBeDefined();
  return result as Step;
}
function moduleIn(value: Step): string {
  const match = value.run?.match(/<<'NODE'\n([\s\S]*?)\nNODE(?:\n|$)/u);
  expect(match, value.name).not.toBeNull();
  return match?.[1] ?? "";
}
function execute(
  value: Step,
  cwd: string,
  args: string[] = [],
  env: Record<string, string> = {},
): void {
  execFileSync(process.execPath, ["--input-type=module", "-", ...args], {
    cwd,
    input: moduleIn(value),
    env: { ...process.env, TARBALL: tarball, ...env },
    stdio: ["pipe", "pipe", "pipe"],
  });
}
// upload-artifact keeps paths relative to the least common search root. A single
// directory search uses that directory's contents, not its parent directory.
function handoff(root: string, inputs: string, destination: string): void {
  const paths = inputs
    .trim()
    .split(/\r?\n/u)
    .map((p) => resolve(root, p.trim().replace(/\$\{\{[^}]*tarball[^}]*\}\}/gu, tarball)));
  let common = statSync(paths[0] as string).isDirectory()
    ? (paths[0] as string)
    : dirname(paths[0] as string);
  for (const path of paths)
    while (relative(common, path).startsWith("..")) common = dirname(common);
  const copy = (path: string): void => {
    if (statSync(path).isDirectory()) for (const name of readdirSync(path)) copy(join(path, name));
    else {
      const target = join(destination, relative(common, path));
      mkdirSync(dirname(target), { recursive: true });
      cpSync(path, target);
    }
  };
  paths.forEach(copy);
}

describe("release artifact packet layout", () => {
  it("preserves exact bytes through qualification and every publication asset path", () => {
    const root = mkdtempSync(join(tmpdir(), "aih-release-layout-"));
    try {
      mkdirSync(join(root, "release"));
      const manifest = Buffer.from(
        JSON.stringify({
          package: { name: "@aihq/core", version: "0.6.1" },
          tracker: { repository: "samartomar/ai-harness", issueNumber: 1 },
        }),
      );
      const tar = Buffer.from([0, 255, 13, 10, 42]);
      const sums = Buffer.from(`${hash(tar)}  ${tarball}\n`);
      const ci = Buffer.from(JSON.stringify({ runId: 2, requiredChecks: [] }));
      writeFileSync(join(root, "release/enterprise-change.json"), manifest);
      writeFileSync(join(root, tarball), tar);
      writeFileSync(join(root, "SHA256SUMS.txt"), sums);
      writeFileSync(join(root, "protected-main-ci.json"), ci);
      const legacy = join(root, "legacy");
      handoff(
        root,
        `${tarball}\nSHA256SUMS.txt\nprotected-main-ci.json\nrelease/enterprise-change.json`,
        legacy,
      );
      expect(existsSync(join(legacy, "enterprise-change.json"))).toBe(false);
      expect(readFileSync(join(legacy, "release/enterprise-change.json"))).toEqual(manifest);

      const candidateStage = workflow.jobs["verify-and-pack"]?.steps.find(
        (value) => value.name === "Stage candidate packet",
      );
      if (candidateStage) execute(candidateStage, root);
      handoff(
        root,
        step("verify-and-pack", "Upload digest-bound candidate packet").with?.path ?? "",
        join(root, "candidate"),
      );
      expect(readFileSync(join(root, "candidate/enterprise-change.json"))).toEqual(manifest);
      const sbom = Buffer.from('{"spdxVersion":"SPDX-2.3"}\n');
      writeFileSync(join(root, "aih-sbom.spdx.json"), sbom);
      execute(
        step("seal-qualification", "Build and validate qualification receipt"),
        root,
        [hash(manifest), hash(sbom)],
        {
          ARTIFACT_ID: "3",
          ARTIFACT_DIGEST: `sha256:${"a".repeat(64)}`,
          TARBALL_SHA256: hash(tar),
          TAG_OBJECT: "b".repeat(40),
          GITHUB_SHA: "c".repeat(40),
          GITHUB_REF_NAME: "v-core-0.6.1",
          GITHUB_RUN_ID: "4",
          GITHUB_RUN_ATTEMPT: "1",
        },
      );
      const qualification = readFileSync(join(root, "qualification.json"));
      expect(JSON.parse(qualification.toString()).manifests).toEqual({
        enterpriseChangeSha256: hash(manifest),
        sbomSha256: hash(sbom),
      });
      const legacyQualification = join(root, "legacy-qualification");
      handoff(
        root,
        "qualification.json\naih-sbom.spdx.json\ncandidate/enterprise-change.json\ncandidate/protected-main-ci.json\ncandidate/SHA256SUMS.txt",
        legacyQualification,
      );
      expect(existsSync(join(legacyQualification, "enterprise-change.json"))).toBe(false);
      expect(readFileSync(join(legacyQualification, "candidate/enterprise-change.json"))).toEqual(
        manifest,
      );
      execute(step("seal-qualification", "Stage qualification packet"), root);
      handoff(
        root,
        step("seal-qualification", "Upload durable qualification evidence").with?.path ?? "",
        join(root, "authorized"),
      );
      writeFileSync(join(root, "authorization.json"), "owner authorization fixture\n");
      writeFileSync(join(root, "candidate-state-tokens.json"), "state tokens fixture\n");
      handoff(
        root,
        step("authorize-publication", "Upload authorized publication packet").with?.path ?? "",
        join(root, "sealed"),
      );
      handoff(
        root,
        step("verify-and-pack", "Upload digest-bound candidate packet").with?.path ?? "",
        join(root, "sealed/candidate"),
      );
      writeFileSync(join(root, "sealed/SHA256SUMS.txt.sigstore.json"), "signature fixture\n");
      writeFileSync(join(root, "sealed/provenance.intoto.jsonl"), "provenance fixture\n");
      const published = join(root, "published");
      handoff(
        root,
        step("seal-publication-evidence", "Upload recovery evidence before npm effect").with
          ?.path ?? "",
        published,
      );
      const expected: Record<string, Buffer> = {
        [`candidate/${tarball}`]: tar,
        "candidate/SHA256SUMS.txt": sums,
        "authorized/enterprise-change.json": manifest,
        "authorized/aih-sbom.spdx.json": sbom,
        "authorized/qualification.json": qualification,
        "authorized/protected-main-ci.json": ci,
        "SHA256SUMS.txt.sigstore.json": Buffer.from("signature fixture\n"),
        "provenance.intoto.jsonl": Buffer.from("provenance fixture\n"),
        "authorization.json": Buffer.from("owner authorization fixture\n"),
      };
      for (const [path, bytes] of Object.entries(expected))
        expect(readFileSync(join(published, path))).toEqual(bytes);
      const release =
        step("github-release", "Create prerelease mirror from sealed evidence").run ?? "";
      const assets = [...release.matchAll(/sealed\/[^\s"\\]+/gu)].map(([path]) =>
        path.replace("$TARBALL", tarball).slice("sealed/".length),
      );
      expect(assets).toHaveLength(8);
      for (const asset of assets) expect(existsSync(join(published, asset)), asset).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
