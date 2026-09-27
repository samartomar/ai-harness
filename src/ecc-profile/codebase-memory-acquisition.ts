import { createHash, randomBytes } from "node:crypto";
import {
  chmodSync,
  createReadStream,
  existsSync,
  lstatSync,
  mkdirSync,
  renameSync,
  rmSync,
} from "node:fs";
import { open, readFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { retryTransient } from "../internals/fsxn.js";
import type { Runner } from "../internals/proc.js";
import { defaultRunner } from "../internals/proc.js";
import { CODEBASE_MEMORY_NATIVE_PAYLOAD_VERSION } from "./codebase-memory-native-pins.js";
import {
  type AuthenticatedCodebaseMemoryNativePayload,
  authenticateCodebaseMemoryNativePayload,
} from "./codebase-memory-payload.js";
import { codebaseMemoryNativeBinaryPath } from "./codebase-memory-runtime.js";
import {
  CODEBASE_MEMORY_RUNTIME_PIN,
  type CodebaseMemoryPlatform,
} from "./default-mcp-runtime-lock.js";
import { prepareOwnedStateDirectory } from "./native-runtime.js";

const RELEASE_BASE = `https://github.com/DeusData/codebase-memory-mcp/releases/download/v${CODEBASE_MEMORY_NATIVE_PAYLOAD_VERSION}`;
const MAX_MANIFEST_BYTES = 1024 * 1024;
const MAX_ARCHIVE_BYTES = 128 * 1024 * 1024;
const DOWNLOAD_TIMEOUT_MS = 120_000;
const MAX_REDIRECTS = 5;

const UNIX_ARCHIVE_NAMES = [
  "codebase-memory-mcp",
  "LICENSE",
  "install.sh",
  "THIRD_PARTY_NOTICES.md",
] as const;
const WINDOWS_ARCHIVE_NAMES = [
  "codebase-memory-mcp.exe",
  "LICENSE",
  "install.ps1",
  "THIRD_PARTY_NOTICES.md",
] as const;

export interface AcquireCodebaseMemoryNativePayloadInput {
  readonly runtimeHome: string;
  readonly platform: NodeJS.Platform;
  readonly arch: NodeJS.Architecture;
  readonly run?: Runner;
  readonly env?: NodeJS.ProcessEnv;
}

export interface ExtractCodebaseMemoryArchiveInput {
  readonly archivePath: string;
  readonly stagingRuntimeHome: string;
  readonly platform: NodeJS.Platform;
  readonly run: Runner;
  readonly env: NodeJS.ProcessEnv;
}

export interface CodebaseMemoryAcquisitionDeps {
  readonly downloadFile?: (url: string, destination: string, maxBytes: number) => Promise<void>;
  readonly extractArchive?: (input: ExtractCodebaseMemoryArchiveInput) => Promise<void>;
  readonly authenticate?: typeof authenticateCodebaseMemoryNativePayload;
  readonly authenticateManifest?: (
    contents: Buffer,
    archiveName: string,
    expected: { manifestSha256: string; archiveSha256: string },
  ) => string;
  readonly authenticateArchive?: (path: string, expectedSha256: string) => Promise<string>;
}

export interface AcquiredCodebaseMemoryNativePayload
  extends AuthenticatedCodebaseMemoryNativePayload {
  readonly changed: boolean;
  readonly reused: boolean;
  readonly archiveName: string;
}

function archiveTarget(
  platform: NodeJS.Platform,
  arch: NodeJS.Architecture,
): CodebaseMemoryPlatform {
  const target = `${platform}-${arch}`;
  if (!Object.hasOwn(CODEBASE_MEMORY_RUNTIME_PIN.archives, target)) {
    throw new Error("Codebase Memory has no qualified native payload for this platform");
  }
  return target as CodebaseMemoryPlatform;
}

function exactArchiveNames(platform: NodeJS.Platform): readonly string[] {
  return platform === "win32" ? WINDOWS_ARCHIVE_NAMES : UNIX_ARCHIVE_NAMES;
}

export function validateCodebaseMemoryArchiveListing(
  listing: string,
  platform: NodeJS.Platform,
): void {
  if (listing.includes("\0")) throw new Error("archive member listing contains a NUL byte");
  const members = listing.split(/\r?\n/u);
  if (members.at(-1) === "") members.pop();
  const expected = new Set(exactArchiveNames(platform));
  const seen = new Set<string>();
  for (const member of members) {
    if (member.length === 0 || !expected.has(member) || seen.has(member)) {
      throw new Error(
        `archive contains an unexpected or duplicate root member: ${JSON.stringify(member)}`,
      );
    }
    seen.add(member);
  }
  if (seen.size !== expected.size || members.length !== expected.size) {
    throw new Error(`archive must contain exactly these root files: ${[...expected].join(", ")}`);
  }
}

export function parseCodebaseMemoryReleaseManifest(
  contents: Buffer,
  archiveName: string,
  expected: { manifestSha256: string; archiveSha256: string } = {
    manifestSha256: CODEBASE_MEMORY_RUNTIME_PIN.releaseManifestSha256,
    archiveSha256:
      Object.values(CODEBASE_MEMORY_RUNTIME_PIN.archives).find(
        (archive) => archive.name === archiveName,
      )?.sha256 ?? "",
  },
): string {
  if (contents.length > MAX_MANIFEST_BYTES) {
    throw new Error("Codebase Memory release manifest exceeds its byte limit");
  }
  if (createHash("sha256").update(contents).digest("hex") !== expected.manifestSha256) {
    throw new Error("Codebase Memory release manifest failed authentication");
  }
  let found: string | undefined;
  for (const line of contents.toString("utf8").split(/\r?\n/u)) {
    const fields = line.trim().split(/\s+/u);
    if (fields.length < 2) continue;
    const name = fields[1]?.replace(/^\*/u, "");
    if (name !== archiveName) continue;
    const digest = fields[0]?.toLowerCase();
    if (digest === undefined || !/^[a-f0-9]{64}$/u.test(digest)) {
      throw new Error("Codebase Memory release manifest contains an invalid archive digest");
    }
    if (found !== undefined && found !== digest) {
      throw new Error("Codebase Memory release manifest contains conflicting archive digests");
    }
    found = digest;
  }
  if (found === undefined) throw new Error("Codebase Memory release manifest omits the archive");
  if (found !== expected.archiveSha256) {
    throw new Error("Codebase Memory release manifest contradicts the qualified archive pin");
  }
  return found;
}

function qualifiedDownloadUrl(raw: string): URL {
  const url = new URL(raw);
  const allowedHost =
    url.hostname === "github.com" || url.hostname.endsWith(".githubusercontent.com");
  if (
    url.protocol !== "https:" ||
    !allowedHost ||
    url.username.length > 0 ||
    url.password.length > 0 ||
    url.hash.length > 0
  ) {
    throw new Error("Codebase Memory download redirected outside qualified HTTPS hosts");
  }
  return url;
}

async function downloadHop(
  url: URL,
  destination: string,
  maxBytes: number,
): Promise<URL | undefined> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), DOWNLOAD_TIMEOUT_MS);
  try {
    const response = await fetch(url, { redirect: "manual", signal: controller.signal });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get("location");
      if (location === null) throw new Error("Codebase Memory download redirect omitted Location");
      return qualifiedDownloadUrl(new URL(location, url).href);
    }
    if (response.status !== 200 || response.body === null) {
      throw new Error(`Codebase Memory download returned HTTP ${response.status}`);
    }
    const contentLength = response.headers.get("content-length");
    if (contentLength !== null) {
      const length = Number(contentLength);
      if (!Number.isSafeInteger(length) || length < 0 || length > maxBytes) {
        throw new Error("Codebase Memory download exceeds its byte limit");
      }
    }
    const handle = await open(destination, "wx", 0o600);
    let received = 0;
    try {
      for await (const chunk of response.body) {
        const buffer = Buffer.from(chunk);
        received += buffer.length;
        if (received > maxBytes) {
          controller.abort();
          throw new Error("Codebase Memory download exceeds its byte limit");
        }
        await handle.write(buffer);
      }
      await handle.sync();
    } finally {
      await handle.close();
    }
    return undefined;
  } finally {
    clearTimeout(timeout);
  }
}

export async function downloadCodebaseMemoryReleaseFile(
  rawUrl: string,
  destination: string,
  maxBytes: number,
): Promise<void> {
  let url = qualifiedDownloadUrl(rawUrl);
  try {
    for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects += 1) {
      const next = await downloadHop(url, destination, maxBytes);
      if (next === undefined) return;
      if (redirects === MAX_REDIRECTS) {
        throw new Error("Codebase Memory download exceeded its redirect limit");
      }
      url = next;
    }
  } catch (error) {
    try {
      rmSync(destination, { force: true });
    } catch {
      // Preserve the original bounded download failure.
    }
    throw error;
  }
}

async function fileSha256(path: string): Promise<string> {
  const hash = createHash("sha256");
  await new Promise<void>((resolvePromise, reject) => {
    const stream = createReadStream(path);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.once("error", reject);
    stream.once("end", resolvePromise);
  });
  return hash.digest("hex");
}

async function authenticateArchive(path: string, expectedSha256: string): Promise<string> {
  const actual = await fileSha256(path);
  if (actual !== expectedSha256) {
    throw new Error("Codebase Memory release archive failed authentication");
  }
  return actual;
}

function extractionFailure(detail: string): never {
  throw new Error(`Codebase Memory release extraction failed: ${detail.trim() || "unknown error"}`);
}

async function extractOnUnix(input: ExtractCodebaseMemoryArchiveInput): Promise<void> {
  const listed = await input.run(["tar", "-tzf", input.archivePath], {
    env: input.env,
    timeoutMs: 30_000,
    maxBufferBytes: MAX_MANIFEST_BYTES,
  });
  if (listed.code !== 0 || listed.spawnError || listed.truncated) extractionFailure(listed.stderr);
  validateCodebaseMemoryArchiveListing(listed.stdout, input.platform);
  const target = codebaseMemoryNativeBinaryPath(input.platform, input.stagingRuntimeHome);
  mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
  const extracted = await input.run(
    ["tar", "-xzf", input.archivePath, "-C", dirname(target), "codebase-memory-mcp"],
    { env: input.env, timeoutMs: 120_000, maxBufferBytes: MAX_MANIFEST_BYTES },
  );
  if (extracted.code !== 0 || extracted.spawnError || extracted.truncated) {
    extractionFailure(extracted.stderr);
  }
  chmodSync(target, 0o755);
}

async function extractOnWindows(input: ExtractCodebaseMemoryArchiveInput): Promise<void> {
  const target = codebaseMemoryNativeBinaryPath("win32", input.stagingRuntimeHome);
  mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
  const script = [
    "$ErrorActionPreference = 'Stop'",
    "Add-Type -AssemblyName System.IO.Compression.FileSystem",
    "$zip = [System.IO.Compression.ZipFile]::OpenRead($env:AIH_CBM_ARCHIVE)",
    "$required = @('codebase-memory-mcp.exe','LICENSE','install.ps1','THIRD_PARTY_NOTICES.md')",
    "$seen = New-Object 'System.Collections.Generic.HashSet[string]' ([System.StringComparer]::OrdinalIgnoreCase)",
    "try { foreach ($entry in $zip.Entries) { $name = $entry.FullName.Replace('\\','/'); if (-not $required.Contains($name) -or -not $seen.Add($name)) { throw ('unexpected or duplicate archive member: ' + $name) } }; if ($seen.Count -ne $required.Count) { throw 'archive root allowlist is incomplete' }; $entry = @($zip.Entries | Where-Object { $_.FullName -ceq 'codebase-memory-mcp.exe' })[0]; [System.IO.Compression.ZipFileExtensions]::ExtractToFile($entry, $env:AIH_CBM_TARGET, $false) } finally { $zip.Dispose() }",
  ].join("; ");
  const encoded = Buffer.from(script, "utf16le").toString("base64");
  const extracted = await input.run(
    ["powershell.exe", "-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", encoded],
    {
      env: { ...input.env, AIH_CBM_ARCHIVE: input.archivePath, AIH_CBM_TARGET: target },
      timeoutMs: 120_000,
      maxBufferBytes: MAX_MANIFEST_BYTES,
    },
  );
  if (extracted.code !== 0 || extracted.spawnError || extracted.truncated) {
    extractionFailure(extracted.stderr);
  }
}

export async function extractCodebaseMemoryReleaseArchive(
  input: ExtractCodebaseMemoryArchiveInput,
): Promise<void> {
  if (input.platform === "win32") return extractOnWindows(input);
  return extractOnUnix(input);
}

function removeOwnedStaging(runtimeHome: string, staging: string): void {
  const home = resolve(runtimeHome);
  const target = resolve(staging);
  const relation = relative(home, target);
  if (relation.length === 0 || relation.startsWith("..") || isAbsolute(relation)) {
    throw new Error("Codebase Memory staging cleanup escaped the runtime home");
  }
  if (!existsSync(target)) return;
  const stats = lstatSync(target);
  if (stats.isSymbolicLink() || !stats.isDirectory()) {
    throw new Error("Codebase Memory staging cleanup found an unsafe path");
  }
  rmSync(target, { recursive: true, force: false });
}

/** Acquire one exact official archive, authenticate it twice, and publish only its native binary. */
export async function acquireCodebaseMemoryNativePayload(
  input: AcquireCodebaseMemoryNativePayloadInput,
  deps: CodebaseMemoryAcquisitionDeps = {},
): Promise<AcquiredCodebaseMemoryNativePayload> {
  if (!isAbsolute(input.runtimeHome)) {
    throw new Error("Codebase Memory runtime home must be absolute");
  }
  const target = archiveTarget(input.platform, input.arch);
  const archive = CODEBASE_MEMORY_RUNTIME_PIN.archives[target];
  const runtimeHome = prepareOwnedStateDirectory(
    resolve(input.runtimeHome),
    "Codebase Memory payload root",
  );
  const authenticate = deps.authenticate ?? authenticateCodebaseMemoryNativePayload;
  const finalPath = codebaseMemoryNativeBinaryPath(input.platform, runtimeHome);
  if (existsSync(finalPath)) {
    const reused = await authenticate({ runtimeHome, platform: input.platform, arch: input.arch });
    return { ...reused, changed: false, reused: true, archiveName: archive.name };
  }
  const finalDirectory = dirname(finalPath);
  if (existsSync(finalDirectory)) {
    throw new Error("existing Codebase Memory payload directory is incomplete; it was preserved");
  }

  const staging = join(
    runtimeHome,
    `.memory-acquire-${process.pid}-${randomBytes(8).toString("hex")}`,
  );
  mkdirSync(staging, { mode: 0o700 });
  const manifestPath = join(staging, "checksums.txt");
  const archivePath = join(staging, archive.name);
  const stagingRuntimeHome = join(staging, "runtime");
  mkdirSync(stagingRuntimeHome, { mode: 0o700 });
  try {
    const download = deps.downloadFile ?? downloadCodebaseMemoryReleaseFile;
    await download(`${RELEASE_BASE}/checksums.txt`, manifestPath, MAX_MANIFEST_BYTES);
    const manifest = await readFile(manifestPath);
    (deps.authenticateManifest ?? parseCodebaseMemoryReleaseManifest)(manifest, archive.name, {
      manifestSha256: CODEBASE_MEMORY_RUNTIME_PIN.releaseManifestSha256,
      archiveSha256: archive.sha256,
    });
    await download(`${RELEASE_BASE}/${archive.name}`, archivePath, MAX_ARCHIVE_BYTES);
    await (deps.authenticateArchive ?? authenticateArchive)(archivePath, archive.sha256);
    await (deps.extractArchive ?? extractCodebaseMemoryReleaseArchive)({
      archivePath,
      stagingRuntimeHome,
      platform: input.platform,
      run: input.run ?? defaultRunner,
      env: input.env ?? process.env,
    });
    await authenticate({
      runtimeHome: stagingRuntimeHome,
      platform: input.platform,
      arch: input.arch,
    });

    prepareOwnedStateDirectory(dirname(finalDirectory), "Codebase Memory payload version root");
    try {
      retryTransient(() =>
        renameSync(
          dirname(codebaseMemoryNativeBinaryPath(input.platform, stagingRuntimeHome)),
          finalDirectory,
        ),
      );
    } catch (error) {
      if (!existsSync(finalPath)) throw error;
      const winner = await authenticate({
        runtimeHome,
        platform: input.platform,
        arch: input.arch,
      });
      return { ...winner, changed: false, reused: true, archiveName: archive.name };
    }
    const published = await authenticate({
      runtimeHome,
      platform: input.platform,
      arch: input.arch,
    });
    return { ...published, changed: true, reused: false, archiveName: archive.name };
  } finally {
    removeOwnedStaging(runtimeHome, staging);
  }
}
