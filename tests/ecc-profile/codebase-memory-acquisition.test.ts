import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  acquireCodebaseMemoryNativePayload,
  downloadCodebaseMemoryReleaseFile,
  extractCodebaseMemoryReleaseArchive,
  parseCodebaseMemoryReleaseManifest,
  validateCodebaseMemoryArchiveListing,
} from "../../src/ecc-profile/codebase-memory-acquisition.js";
import { codebaseMemoryNativeBinaryPath } from "../../src/ecc-profile/codebase-memory-runtime.js";
import { CODEBASE_MEMORY_RUNTIME_PIN } from "../../src/ecc-profile/default-mcp-runtime-lock.js";
import { fakeRunner } from "../../src/internals/proc.js";

const roots: string[] = [];

afterEach(() => {
  vi.unstubAllGlobals();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixtureRoot(): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "aih-memory-acquire-")));
  roots.push(root);
  return root;
}

function payloadIdentity(platform: NodeJS.Platform, runtimeHome: string) {
  return {
    path: codebaseMemoryNativeBinaryPath(platform, runtimeHome),
    sha256: "f".repeat(64),
    size: 21,
    version: "0.11.0",
  };
}

function manifestExpectation(contents: string, archiveSha256: string) {
  return {
    manifestSha256: createHash("sha256").update(contents).digest("hex"),
    archiveSha256,
  };
}

function acquisitionStagingEntries(runtimeHome: string): string[] {
  return readdirSync(runtimeHome).filter((entry) => entry.startsWith(".memory-acquire-"));
}

describe("Codebase Memory native acquisition", () => {
  it("requires the frozen release manifest identity and one matching archive record", () => {
    const archive = CODEBASE_MEMORY_RUNTIME_PIN.archives["win32-x64"];
    const manifest = `${archive.sha256}  ${archive.name}\n`;
    const expectedManifestHash = createHash("sha256").update(manifest).digest("hex");

    expect(
      parseCodebaseMemoryReleaseManifest(Buffer.from(manifest), archive.name, {
        manifestSha256: expectedManifestHash,
        archiveSha256: archive.sha256,
      }),
    ).toBe(archive.sha256);
    expect(() =>
      parseCodebaseMemoryReleaseManifest(Buffer.from(`${manifest}0`.repeat(64)), archive.name, {
        manifestSha256: expectedManifestHash,
        archiveSha256: archive.sha256,
      }),
    ).toThrow("manifest failed authentication");
  });

  it("fails closed on malformed, conflicting, omitted, and stale manifest archive records", () => {
    const archive = CODEBASE_MEMORY_RUNTIME_PIN.archives["win32-x64"];
    const assertManifestError = (contents: string, message: string) => {
      expect(() =>
        parseCodebaseMemoryReleaseManifest(
          Buffer.from(contents),
          archive.name,
          manifestExpectation(contents, archive.sha256),
        ),
      ).toThrow(message);
    };

    assertManifestError(`not-a-digest  ${archive.name}\n`, "invalid archive digest");
    assertManifestError(
      `${archive.sha256}  ${archive.name}\n${"0".repeat(64)}  ${archive.name}\n`,
      "conflicting archive digests",
    );
    assertManifestError(`${"0".repeat(64)}  another-archive.zip\n`, "omits the archive");
    assertManifestError(
      `${"0".repeat(64)}  ${archive.name}\n`,
      "contradicts the qualified archive pin",
    );
  });

  it("fails closed when the default pinned manifest lookup has no qualified archive", () => {
    expect(() =>
      parseCodebaseMemoryReleaseManifest(Buffer.from("untrusted manifest"), "unknown-archive.zip"),
    ).toThrow("manifest failed authentication");
  });

  it("rejects a release manifest before hashing when it exceeds the bounded size", () => {
    expect(() =>
      parseCodebaseMemoryReleaseManifest(Buffer.alloc(1024 * 1024 + 1), "unused-archive.zip", {
        manifestSha256: "0".repeat(64),
        archiveSha256: "0".repeat(64),
      }),
    ).toThrow("release manifest exceeds its byte limit");
  });

  it("accepts only the exact release root allowlist", () => {
    expect(() =>
      validateCodebaseMemoryArchiveListing(
        "codebase-memory-mcp.exe\nLICENSE\ninstall.ps1\nTHIRD_PARTY_NOTICES.md\n",
        "win32",
      ),
    ).not.toThrow();
    expect(() =>
      validateCodebaseMemoryArchiveListing(
        "codebase-memory-mcp.exe\nLICENSE\ninstall.ps1\n../escape\n",
        "win32",
      ),
    ).toThrow("unexpected or duplicate root member");
  });

  it("rejects NUL members, duplicate members, and incomplete archive root listings", () => {
    expect(() =>
      validateCodebaseMemoryArchiveListing(
        "codebase-memory-mcp.exe\0\nLICENSE\ninstall.ps1\nTHIRD_PARTY_NOTICES.md\n",
        "win32",
      ),
    ).toThrow("NUL byte");
    expect(() =>
      validateCodebaseMemoryArchiveListing(
        "codebase-memory-mcp.exe\nLICENSE\nLICENSE\nTHIRD_PARTY_NOTICES.md\n",
        "win32",
      ),
    ).toThrow("unexpected or duplicate root member");
    expect(() =>
      validateCodebaseMemoryArchiveListing("codebase-memory-mcp\nLICENSE\n", "linux"),
    ).toThrow("must contain exactly these root files");
  });

  it("follows a qualified HTTPS redirect and writes a bounded download offline", async () => {
    const root = fixtureRoot();
    const destination = join(root, "release.bin");
    const requested: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: URL) => {
        requested.push(input.href);
        if (requested.length === 1) {
          return new Response(null, {
            status: 302,
            headers: { location: "https://objects.githubusercontent.com/fixture/release.bin" },
          });
        }
        return new Response("payload", { status: 200, headers: { "content-length": "7" } });
      }),
    );

    await downloadCodebaseMemoryReleaseFile(
      "https://github.com/DeusData/codebase-memory-mcp/releases/download/v0.11.0/release.bin",
      destination,
      16,
    );

    expect(requested).toEqual([
      "https://github.com/DeusData/codebase-memory-mcp/releases/download/v0.11.0/release.bin",
      "https://objects.githubusercontent.com/fixture/release.bin",
    ]);
    expect(readFileSync(destination, "utf8")).toBe("payload");
  });

  it("rejects an unqualified redirect and removes an over-limit partial download", async () => {
    const root = fixtureRoot();
    const redirectDestination = join(root, "redirect.bin");
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(null, {
            status: 302,
            headers: { location: "https://example.invalid/untrusted.bin" },
          }),
      ),
    );

    await expect(
      downloadCodebaseMemoryReleaseFile(
        "https://github.com/fixture/release.bin",
        redirectDestination,
        16,
      ),
    ).rejects.toThrow("outside qualified HTTPS hosts");
    expect(existsSync(redirectDestination)).toBe(false);

    const partialDestination = join(root, "partial.bin");
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            new ReadableStream({
              start(controller) {
                controller.enqueue(new Uint8Array([1, 2, 3, 4]));
                controller.close();
              },
            }),
            { status: 200 },
          ),
      ),
    );

    await expect(
      downloadCodebaseMemoryReleaseFile(
        "https://github.com/fixture/release.bin",
        partialDestination,
        3,
      ),
    ).rejects.toThrow("exceeds its byte limit");
    expect(existsSync(partialDestination)).toBe(false);
  });

  it("rejects missing redirect locations, HTTP failures, and absent response bodies", async () => {
    const root = fixtureRoot();
    const destination = (name: string) => join(root, name);

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(null, { status: 302 })),
    );
    await expect(
      downloadCodebaseMemoryReleaseFile(
        "https://github.com/fixture/release.bin",
        destination("missing-location.bin"),
        16,
      ),
    ).rejects.toThrow("redirect omitted Location");

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(null, { status: 503 })),
    );
    await expect(
      downloadCodebaseMemoryReleaseFile(
        "https://github.com/fixture/release.bin",
        destination("http-failure.bin"),
        16,
      ),
    ).rejects.toThrow("returned HTTP 503");

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(null, { status: 200 })),
    );
    await expect(
      downloadCodebaseMemoryReleaseFile(
        "https://github.com/fixture/release.bin",
        destination("missing-body.bin"),
        16,
      ),
    ).rejects.toThrow("returned HTTP 200");
  });

  it("enforces declared byte and redirect-chain limits before writing a download", async () => {
    const root = fixtureRoot();
    const declaredLimitDestination = join(root, "declared-limit.bin");
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () => new Response("payload", { status: 200, headers: { "content-length": "7" } }),
      ),
    );
    await expect(
      downloadCodebaseMemoryReleaseFile(
        "https://github.com/fixture/release.bin",
        declaredLimitDestination,
        3,
      ),
    ).rejects.toThrow("exceeds its byte limit");
    expect(existsSync(declaredLimitDestination)).toBe(false);

    let redirects = 0;
    const redirectLimitDestination = join(root, "redirect-limit.bin");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        redirects += 1;
        return new Response(null, {
          status: 302,
          headers: { location: `https://github.com/fixture/redirect-${redirects}` },
        });
      }),
    );
    await expect(
      downloadCodebaseMemoryReleaseFile(
        "https://github.com/fixture/release.bin",
        redirectLimitDestination,
        16,
      ),
    ).rejects.toThrow("exceeded its redirect limit");
    expect(redirects).toBe(6);
    expect(existsSync(redirectLimitDestination)).toBe(false);
  });

  it("lists before extracting the exact Unix archive payload", async () => {
    const root = fixtureRoot();
    const archivePath = join(root, "payload.tar.gz");
    const stagingRuntimeHome = join(root, "staging");
    const target = codebaseMemoryNativeBinaryPath("linux", stagingRuntimeHome);
    const calls: string[][] = [];
    const run = fakeRunner((argv) => {
      calls.push(argv);
      if (argv[1] === "-tzf") {
        return {
          stdout: "codebase-memory-mcp\nLICENSE\ninstall.sh\nTHIRD_PARTY_NOTICES.md\n",
        };
      }
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, "native payload");
      return undefined;
    });

    await extractCodebaseMemoryReleaseArchive({
      archivePath,
      stagingRuntimeHome,
      platform: "linux",
      run,
      env: { PATH: "fixture-path" },
    });

    expect(calls).toEqual([
      ["tar", "-tzf", archivePath],
      ["tar", "-xzf", archivePath, "-C", dirname(target), "codebase-memory-mcp"],
    ]);
    expect(readFileSync(target, "utf8")).toBe("native payload");
  });

  it("fails closed on a failed Unix listing and renders the constrained Windows extractor", async () => {
    const root = fixtureRoot();
    const archivePath = join(root, "payload.zip");
    const stagingRuntimeHome = join(root, "staging");

    await expect(
      extractCodebaseMemoryReleaseArchive({
        archivePath,
        stagingRuntimeHome,
        platform: "linux",
        run: fakeRunner(() => ({ code: 1, stderr: "tar listing rejected" })),
        env: {},
      }),
    ).rejects.toThrow("release extraction failed: tar listing rejected");

    const calls: Array<{ argv: string[]; env: NodeJS.ProcessEnv | undefined }> = [];
    await extractCodebaseMemoryReleaseArchive({
      archivePath,
      stagingRuntimeHome,
      platform: "win32",
      run: fakeRunner((argv, options) => {
        calls.push({ argv, env: options?.env });
        return undefined;
      }),
      env: { PATH: "fixture-path" },
    });

    const call = calls[0];
    if (call === undefined) throw new Error("Windows extractor was not invoked");
    expect(call.argv.slice(0, 4)).toEqual([
      "powershell.exe",
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
    ]);
    expect(call.env).toMatchObject({
      PATH: "fixture-path",
      AIH_CBM_ARCHIVE: archivePath,
      AIH_CBM_TARGET: codebaseMemoryNativeBinaryPath("win32", stagingRuntimeHome),
    });
    const encodedScript = call.argv.at(-1);
    expect(encodedScript).toBeDefined();
    const script = Buffer.from(encodedScript ?? "", "base64").toString("utf16le");
    expect(script).toContain("archive root allowlist is incomplete");
    expect(script).toContain("codebase-memory-mcp.exe");
  });

  it("downloads the official manifest and archive, extracts to quarantine, then authenticates", async () => {
    const runtimeHome = realpathSync(mkdtempSync(join(tmpdir(), "aih-memory-acquire-")));
    roots.push(runtimeHome);
    const archive = CODEBASE_MEMORY_RUNTIME_PIN.archives["win32-x64"];
    const downloaded: string[] = [];
    const downloadFile = vi.fn(async (url: string, destination: string) => {
      downloaded.push(url);
      writeFileSync(
        destination,
        url.endsWith("checksums.txt") ? "fixture manifest" : "fixture archive",
        { flag: "wx" },
      );
    });
    const extractArchive = vi.fn(async ({ stagingRuntimeHome }) => {
      const binary = codebaseMemoryNativeBinaryPath("win32", stagingRuntimeHome);
      await import("node:fs/promises").then((fs) => fs.mkdir(dirname(binary), { recursive: true }));
      writeFileSync(binary, "authenticated payload");
    });
    const authenticate = vi.fn(async ({ runtimeHome: candidate }) => ({
      path: codebaseMemoryNativeBinaryPath("win32", candidate),
      sha256: createHash("sha256").update("authenticated payload").digest("hex"),
      size: Buffer.byteLength("authenticated payload"),
      version: "0.11.0",
    }));

    const result = await acquireCodebaseMemoryNativePayload(
      { runtimeHome, platform: "win32", arch: "x64" },
      {
        downloadFile,
        extractArchive,
        authenticate,
        authenticateManifest: () => archive.sha256,
        authenticateArchive: async () => archive.sha256,
      },
    );

    expect(downloaded).toEqual([
      "https://github.com/DeusData/codebase-memory-mcp/releases/download/v0.11.0/checksums.txt",
      `https://github.com/DeusData/codebase-memory-mcp/releases/download/v0.11.0/${archive.name}`,
    ]);
    expect(extractArchive).toHaveBeenCalledOnce();
    expect(authenticate).toHaveBeenCalledTimes(2);
    expect(result).toMatchObject({ changed: true, reused: false, version: "0.11.0" });
    expect(basename(result.path)).toBe("codebase-memory-mcp.exe");
    expect(readFileSync(result.path, "utf8")).toBe("authenticated payload");
    expect(existsSync(`${result.path}.py`)).toBe(false);
  });

  it("reuses an authenticated cached payload without downloading or extracting", async () => {
    const runtimeHome = fixtureRoot();
    const finalPath = codebaseMemoryNativeBinaryPath("win32", runtimeHome);
    mkdirSync(dirname(finalPath), { recursive: true });
    writeFileSync(finalPath, "cached payload");
    const authenticate = vi.fn(async ({ runtimeHome: candidate }: { runtimeHome: string }) =>
      payloadIdentity("win32", candidate),
    );
    const downloadFile = vi.fn();
    const extractArchive = vi.fn();

    const result = await acquireCodebaseMemoryNativePayload(
      { runtimeHome, platform: "win32", arch: "x64" },
      { authenticate, downloadFile, extractArchive },
    );

    expect(result).toMatchObject({
      changed: false,
      reused: true,
      archiveName: "codebase-memory-mcp-windows-amd64.zip",
    });
    expect(authenticate).toHaveBeenCalledOnce();
    expect(downloadFile).not.toHaveBeenCalled();
    expect(extractArchive).not.toHaveBeenCalled();
  });

  it("rejects invalid acquisition roots and preserves incomplete existing payload directories", async () => {
    await expect(
      acquireCodebaseMemoryNativePayload({
        runtimeHome: "relative-runtime-home",
        platform: "win32",
        arch: "x64",
      }),
    ).rejects.toThrow("runtime home must be absolute");

    const unsupportedRoot = fixtureRoot();
    await expect(
      acquireCodebaseMemoryNativePayload({
        runtimeHome: unsupportedRoot,
        platform: "freebsd" as NodeJS.Platform,
        arch: "x64",
      }),
    ).rejects.toThrow("no qualified native payload");

    const runtimeHome = fixtureRoot();
    const finalDirectory = dirname(codebaseMemoryNativeBinaryPath("win32", runtimeHome));
    mkdirSync(finalDirectory, { recursive: true });
    await expect(
      acquireCodebaseMemoryNativePayload({ runtimeHome, platform: "win32", arch: "x64" }),
    ).rejects.toThrow("payload directory is incomplete; it was preserved");
    expect(existsSync(finalDirectory)).toBe(true);
  });

  it("rejects a downloaded archive that fails the frozen archive digest and removes staging", async () => {
    const runtimeHome = fixtureRoot();
    const archive = CODEBASE_MEMORY_RUNTIME_PIN.archives["win32-x64"];
    const downloadFile = vi.fn(async (_url: string, destination: string) => {
      writeFileSync(destination, "tampered archive", { flag: "wx" });
    });

    await expect(
      acquireCodebaseMemoryNativePayload(
        { runtimeHome, platform: "win32", arch: "x64" },
        { downloadFile, authenticateManifest: () => archive.sha256 },
      ),
    ).rejects.toThrow("release archive failed authentication");

    expect(downloadFile).toHaveBeenCalledTimes(2);
    expect(acquisitionStagingEntries(runtimeHome)).toEqual([]);
  });

  it("reuses a concurrent winner when publish loses the version-directory race", async () => {
    const runtimeHome = fixtureRoot();
    const finalPath = codebaseMemoryNativeBinaryPath("win32", runtimeHome);
    const archive = CODEBASE_MEMORY_RUNTIME_PIN.archives["win32-x64"];
    const authenticate = vi.fn(async ({ runtimeHome: candidate }: { runtimeHome: string }) =>
      payloadIdentity("win32", candidate),
    );
    const extractArchive = vi.fn(async ({ stagingRuntimeHome }: { stagingRuntimeHome: string }) => {
      const stagedPath = codebaseMemoryNativeBinaryPath("win32", stagingRuntimeHome);
      mkdirSync(dirname(stagedPath), { recursive: true });
      writeFileSync(stagedPath, "staged payload");
      mkdirSync(dirname(finalPath), { recursive: true });
      writeFileSync(finalPath, "winner payload");
    });

    const result = await acquireCodebaseMemoryNativePayload(
      { runtimeHome, platform: "win32", arch: "x64" },
      {
        downloadFile: async (_url, destination) =>
          writeFileSync(destination, "fixture", { flag: "wx" }),
        authenticateManifest: () => archive.sha256,
        authenticateArchive: async () => archive.sha256,
        extractArchive,
        authenticate,
      },
    );

    expect(result).toMatchObject({ changed: false, reused: true, path: finalPath });
    expect(extractArchive).toHaveBeenCalledOnce();
    expect(authenticate).toHaveBeenCalledTimes(2);
    expect(acquisitionStagingEntries(runtimeHome)).toEqual([]);
  });
});
