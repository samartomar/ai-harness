import { createHash } from "node:crypto";
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, extname, join, posix } from "node:path";
import {
  AIH_ECC_PROFILE_TEMPLATE,
  deriveEccProfile,
  type ResolvedEccProfile,
} from "../../src/ecc-profile/index.js";
import type { ProjectionSourceTrust } from "../../src/ecc-profile/render.js";

export const fixtureDirectory = join(import.meta.dirname, "../fixtures/ecc-profile");
export const evidence = JSON.parse(
  await readFile(join(fixtureDirectory, "pinned-source-evidence.json"), "utf8"),
) as unknown;
const receiptBytes = await readFile(join(fixtureDirectory, "review-receipt.json"));
export const receipt = {
  id: "pinned-source-evidence-v1",
  evidencePath: "tests/fixtures/ecc-profile/review-receipt.json",
  sourceCommit: "0c1d7be9a750627fb2a6534c78a998cc46d03f9c",
  evidenceSha256: "b4bc069efc8c5eca51e6426feb9d59cc469f2b49b681118a6fd26f5c8fab461c",
};
export const profile = {
  ...AIH_ECC_PROFILE_TEMPLATE,
  source: { ...AIH_ECC_PROFILE_TEMPLATE.source, reviewReceipt: receipt },
};

const manifestNames = [
  "install-components.json",
  "install-modules.json",
  "install-profiles.json",
] as const;

export function sourceFile(text: string, description: string, body: string): string {
  return [
    "---",
    `name: ${text}`,
    `description: ${description}`,
    "tools: Read, Grep, Glob, Bash, Edit, Write, mcp__context7__query-docs",
    "model: opus",
    "permissionMode: bypassPermissions",
    "hooks:",
    "  Stop: ignored",
    "---",
    "",
    body,
    "",
  ].join("\n");
}

function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

interface ClosureEntry {
  path: string;
  rawSha256: string;
  bytes: number;
  fileType: "regular";
  mode: "100644" | "100755";
}

function closureAggregate(entries: readonly ClosureEntry[]): string {
  return sha256(
    entries
      .map((entry) =>
        [entry.path, entry.rawSha256, entry.bytes, entry.fileType, entry.mode].join("\0"),
      )
      .join("\n"),
  );
}

async function projectedPaths(root: string, resolved: ResolvedEccProfile): Promise<string[]> {
  const paths = [...resolved.roles, ...resolved.workflows].map((entry) => entry.sourcePath);
  const visit = async (relativeDirectory: string): Promise<void> => {
    const entries = await readdir(join(root, ...relativeDirectory.split("/")), {
      withFileTypes: true,
    });
    for (const entry of entries) {
      const path = posix.join(relativeDirectory, entry.name);
      if (entry.isDirectory()) await visit(path);
      else paths.push(path);
    }
  };
  for (const skill of resolved.skills) await visit(skill.sourcePath);
  return [...new Set(paths)].sort();
}

export interface ProjectionRoots {
  sourceRoot: string;
  evidenceRoot: string;
  fixtureReceipt: string;
  resolved: ResolvedEccProfile;
  createTrust(): Promise<ProjectionSourceTrust>;
  cleanup(): Promise<void>;
}

export async function projectionRoots(
  options: {
    skillBodies?: Record<string, string>;
    workflowBodies?: Record<string, string>;
    roleBodies?: Record<string, string>;
  } = {},
): Promise<ProjectionRoots> {
  const sourceRoot = await mkdtemp(join(tmpdir(), "aih-ecc-render-source-"));
  const evidenceRoot = await mkdtemp(join(tmpdir(), "aih-ecc-render-evidence-"));
  const resolved = deriveEccProfile(profile, evidence);

  for (const sourcePath of resolved.consumedSourcePaths) {
    if (sourcePath.startsWith("manifests/")) continue;
    const fullPath = join(sourceRoot, ...sourcePath.split("/"));
    if (extname(sourcePath) || sourcePath === "LICENSE") {
      await mkdir(dirname(fullPath), { recursive: true });
      await writeFile(fullPath, `${sourcePath}\n`);
    } else {
      await mkdir(fullPath, { recursive: true });
    }
  }

  for (const skill of resolved.skills) {
    const skillFile = join(sourceRoot, ...skill.sourcePath.split("/"), "SKILL.md");
    await mkdir(dirname(skillFile), { recursive: true });
    await writeFile(
      skillFile,
      sourceFile(
        skill.id,
        `Use the ${skill.id} capability.`,
        options.skillBodies?.[skill.id] ?? `Apply ${skill.id} when relevant.`,
      ),
    );
  }
  for (const role of resolved.roles) {
    await writeFile(
      join(sourceRoot, ...role.sourcePath.split("/")),
      sourceFile(
        role.id,
        `Review as ${role.id}.`,
        options.roleBodies?.[role.id] ?? `Act as the ${role.id} role.`,
      ),
    );
  }
  for (const workflow of resolved.workflows) {
    await writeFile(
      join(sourceRoot, ...workflow.sourcePath.split("/")),
      sourceFile(
        workflow.id.slice(1),
        `Run the ${workflow.id} workflow.`,
        options.workflowBodies?.[workflow.id] ?? `Execute ${workflow.id} with $ARGUMENTS.`,
      ),
    );
  }
  for (const manifestName of manifestNames) {
    const destination = join(sourceRoot, "manifests", manifestName);
    await mkdir(dirname(destination), { recursive: true });
    await copyFile(join(fixtureDirectory, "manifests", manifestName), destination);
  }

  const fixtureReceipt = join(evidenceRoot, ...receipt.evidencePath.split("/"));
  await mkdir(dirname(fixtureReceipt), { recursive: true });
  await writeFile(fixtureReceipt, receiptBytes);

  return {
    sourceRoot,
    evidenceRoot,
    fixtureReceipt,
    resolved,
    async createTrust() {
      const entries: ClosureEntry[] = [];
      for (const path of await projectedPaths(sourceRoot, resolved)) {
        const absolute = join(sourceRoot, ...path.split("/"));
        const info = await stat(absolute);
        const bytes = await readFile(absolute);
        entries.push({
          path,
          rawSha256: sha256(bytes),
          bytes: bytes.length,
          fileType: "regular",
          mode: (info.mode & 0o111) === 0 ? "100644" : "100755",
        });
      }
      const aggregateSha256 = closureAggregate(entries);
      const closure = {
        receiptVersion: 1,
        id: "hermetic-projected-source-closure-v1",
        repository: "affaan-m/ECC",
        sourceCommit: receipt.sourceCommit,
        fileCount: entries.length,
        totalBytes: entries.reduce((total, entry) => total + entry.bytes, 0),
        aggregateSha256,
        entries,
      };
      const contents = `${JSON.stringify(closure, null, 2)}\n`;
      const evidencePath = "projected-source-closure.json";
      await writeFile(join(evidenceRoot, evidencePath), contents);
      return {
        id: closure.id,
        evidencePath,
        evidenceSha256: sha256(contents),
        sourceCommit: closure.sourceCommit,
        fileCount: closure.fileCount,
        totalBytes: closure.totalBytes,
        aggregateSha256,
      };
    },
    async cleanup() {
      await rm(sourceRoot, { recursive: true, force: true });
      await rm(evidenceRoot, { recursive: true, force: true });
    },
  };
}

export async function setExecutable(path: string, executable: boolean): Promise<void> {
  const info = await lstat(path);
  await chmod(path, executable ? info.mode | 0o111 : info.mode & ~0o111);
}
