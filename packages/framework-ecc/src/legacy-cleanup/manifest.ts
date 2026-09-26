import { createHash } from "node:crypto";
import { join, resolve } from "node:path";
import {
  type Action,
  digest,
  inspectContainedRelativePath,
  readContainedRegularFile,
  readEccInstallManifest,
  remove,
  walkManagedRoot,
  writeText,
} from "@aihq/core/framework-host";

const RECEIPT = ".aih/ecc/install-manifest.json";
const MAX_FILE_BYTES = 64 * 1024 * 1024;

function destinationIdentity(root: string, path: string): string {
  const parts = path.replaceAll("\\", "/").split("/");
  const portable =
    process.platform === "win32" ? parts.map((part) => part.replace(/[. ]+$/g, "")) : parts;
  const identity = resolve(root, ...portable);
  return process.platform === "win32" ? identity.toLowerCase() : identity;
}

function hash(contents: Buffer): string {
  return createHash("sha256").update(contents).digest("hex");
}

/**
 * The v1 manifest is an aih capture of files created by the old Kiro native
 * script. It never claimed the pre-existing contents of other target roots.
 * Keep the reader: a matching path alone, or the script's own install state,
 * is insufficient to authorize deletion.
 */
export function legacyManifestCleanupActions(root: string): Action[] {
  const raw = readContainedRegularFile(root, RECEIPT, { maxBytes: 2 * 1024 * 1024 });
  if (raw.state === "absent") return [];
  if (raw.state !== "present") {
    return [
      digest(
        "Legacy ECC manifest needs manual review",
        `${RECEIPT}: ${raw.reason}; preserve it and its destinations`,
        {},
      ),
    ];
  }
  let manifest: ReturnType<typeof readEccInstallManifest>;
  try {
    manifest = readEccInstallManifest(root);
  } catch (error) {
    return [
      digest(
        "Legacy ECC manifest needs manual review",
        `${RECEIPT}: ${(error as Error).message}; preserve its destinations`,
        {},
      ),
    ];
  }
  if (!manifest.present) return [];
  const actions: Action[] = [];
  const retained: typeof manifest.manifest.installs = [];
  let retiredAbsentClaim = false;
  const notes: string[] = [];
  const managedRoot = join(root, ".kiro");
  // Validate the entire receipt before any claim can authorize a removal.
  const claims = new Map<string, number>();
  for (const install of manifest.manifest.installs) {
    for (const file of install.files) {
      const key = destinationIdentity(install.root, file.path);
      claims.set(key, (claims.get(key) ?? 0) + 1);
    }
  }
  const allOwned = new Set<string>();
  for (const install of manifest.manifest.installs) {
    if (install.target !== "kiro" || resolve(install.root) !== resolve(managedRoot)) {
      retained.push(install);
      notes.push(
        `${install.target}: manifest scope is ambiguous; inspect ${install.root} manually`,
      );
      continue;
    }
    const remaining: typeof install.files = [];
    for (const file of install.files) {
      const key = destinationIdentity(install.root, file.path);
      if ((claims.get(key) ?? 0) > 1) {
        remaining.push(file);
        notes.push(`${file.path}: duplicate ownership claim; preserved for manual review`);
        continue;
      }
      allOwned.add(file.path);
      const current = readContainedRegularFile(managedRoot, file.path, {
        maxBytes: MAX_FILE_BYTES,
      });
      if (current.state === "absent") {
        retiredAbsentClaim = true;
        notes.push(`${file.path}: already absent; retiring its receipt entry`);
        continue;
      }
      if (current.state !== "present") {
        remaining.push(file);
        notes.push(`${file.path}: ${current.reason}; preserved for manual review`);
        continue;
      }
      if (hash(current.contents) !== file.sha256) {
        remaining.push(file);
        notes.push(`${file.path}: modified after install; preserved for manual review`);
        continue;
      }
      const destination = `.kiro/${file.path.replaceAll("\\", "/")}`;
      const safe = inspectContainedRelativePath(root, destination);
      if (safe.state !== "present" || safe.kind !== "file") {
        remaining.push(file);
        notes.push(`${file.path}: destination changed; preserved for manual review`);
        continue;
      }
      actions.push(
        remove(destination, `remove unchanged manifest-owned ECC file ${destination}`, {
          hardDelete: true,
          expect: { sha256: file.sha256 },
        }),
      );
    }
    if (remaining.length > 0) retained.push({ ...install, files: remaining });
  }
  try {
    let unowned = 0;
    for (const path of walkManagedRoot(managedRoot)) {
      if (allOwned.has(path)) continue;
      unowned += 1;
      if (unowned <= 100) notes.push(`${path}: unowned Kiro destination; preserved`);
    }
    if (unowned > 100) notes.push(`${unowned - 100} further unowned Kiro destinations preserved`);
  } catch (error) {
    notes.push(`.kiro: cannot enumerate unowned files: ${(error as Error).message}`);
  }
  if (
    retiredAbsentClaim ||
    retained.length !== manifest.manifest.installs.length ||
    actions.length > 0
  ) {
    if (retained.length === 0) {
      actions.push(
        remove(RECEIPT, "retire completed ECC install manifest", {
          hardDelete: true,
          expect: { sha256: hash(raw.contents) },
        }),
      );
    } else {
      actions.push({
        ...writeText(
          RECEIPT,
          `${JSON.stringify({ ...manifest.manifest, installs: retained }, null, 2)}\n`,
          "retain unresolved ECC manifest claims",
          {
            expect: { sha256: hash(raw.contents) },
          },
        ),
        afterRemovals: true,
      });
    }
  }
  if (notes.length > 0)
    actions.push(digest("Legacy ECC manifest review", notes.join("\n"), { notes }));
  return actions;
}
