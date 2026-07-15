import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import process from "node:process";
import { runInNewContext } from "node:vm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { PlanContext } from "../../src/internals/plan.js";
import { fakeRunner } from "../../src/internals/proc.js";
import { makeHostAdapter } from "../../src/platform/detect.js";
import {
  assertTrustTreeSafe,
  isFirstPartySource,
  localFileHash,
  resolveTrustSource,
  safeSourceRelative,
  scrubDockerClientEnv,
  scrubFetchEnv,
  trustFetchExec,
} from "../../src/trust/fetch.js";

let dir: string;
const nodeRequire = createRequire(import.meta.url);

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "aih-trust-fetch-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function ctx(env: NodeJS.ProcessEnv = {}): PlanContext {
  const run = fakeRunner(() => undefined);
  return {
    root: dir,
    contextDir: "ai-coding",
    apply: false,
    verify: true,
    json: false,
    run,
    host: makeHostAdapter({ platform: "linux", run, env }),
    env,
    options: {},
  };
}

function githubFetchScript(): string {
  const source = resolveTrustSource("Owner/Repo", { root: dir, pin: "a".repeat(40) });
  if (source.kind !== "github") throw new Error("expected GitHub source");
  try {
    return trustFetchExec(source, ctx()).argv[2] ?? "";
  } finally {
    rmSync(source.quarantineRoot, { recursive: true, force: true });
  }
}

async function runFetchScriptHelpers<T>(
  body: string,
  env: NodeJS.ProcessEnv = {},
  requireOverrides: Record<string, unknown> = {},
): Promise<T> {
  const script = githubFetchScript();
  const helpers = script.slice(0, script.indexOf("(async () => {"));
  const stderr: string[] = [];
  const sandbox = {
    Buffer,
    URL,
    clearTimeout,
    console,
    process: {
      argv: ["node", "{}"],
      env: { ...env },
      exit: (code: number) => {
        throw new Error(`script exited ${code}: ${stderr.join("")}`);
      },
      nextTick: process.nextTick.bind(process),
      stderr: {
        write: (text: string) => {
          stderr.push(text);
          return text.length;
        },
      },
    },
    require: (name: string) =>
      requireOverrides[name] ??
      (name === "node:tls"
        ? {
            connect: ({ socket }: { socket: { emit: (event: string) => boolean } }) => {
              process.nextTick(() => socket.emit("secureConnect"));
              return socket;
            },
          }
        : nodeRequire(name)),
    setTimeout,
  } as Record<string, unknown>;
  runInNewContext(`${helpers}\nglobalThis.__result = (async () => {\n${body}\n})();`, sandbox);
  return (await sandbox.__result) as T;
}

function tarHeader(name: string, type: string, linkName = "", size = 0): Buffer {
  const header = Buffer.alloc(512);
  const write = (value: string, offset: number, length: number): void => {
    if (Buffer.byteLength(value) > length) throw new Error(`tar field too long: ${value}`);
    header.write(value, offset, length, "utf8");
  };
  write(name, 0, 100);
  write("0000644\0", 100, 8);
  write("0000000\0", 108, 8);
  write("0000000\0", 116, 8);
  write(`${size.toString(8).padStart(11, "0")}\0`, 124, 12);
  write("00000000000\0", 136, 12);
  write("        ", 148, 8);
  write(type, 156, 1);
  write(linkName, 157, 100);
  write("ustar\0", 257, 6);
  let checksum = 0;
  for (const byte of header) checksum += byte;
  write(`${checksum.toString(8).padStart(6, "0")}\0 `, 148, 8);
  return header;
}

function tarWithSymlinkEntry(): Buffer {
  return Buffer.concat([
    tarHeader("repo-aaaaaaaa/skills/clean/LICENSE", "2", "skills/sibling/LICENSE"),
    Buffer.alloc(1024),
  ]);
}

describe("trust fetch source resolution", () => {
  it("resolves a local source, validates containment, and hashes promoted files", () => {
    const skillDir = join(dir, "skills", "clean");
    mkdirSync(skillDir, { recursive: true });
    const skillPath = join(skillDir, "SKILL.md");
    writeFileSync(skillPath, "# Clean\n", "utf8");

    const source = resolveTrustSource("skills/clean", { root: dir });

    expect(source).toMatchObject({ kind: "local", id: "clean" });
    if (source.kind !== "local") throw new Error("expected local source");
    expect(assertTrustTreeSafe(source.root)).toBe(source.root);
    expect(safeSourceRelative(source.root, join(source.root, "SKILL.md"))).toBe("SKILL.md");
    expect(localFileHash(skillPath)).toMatch(/^[a-f0-9]{64}$/);
  });

  it("recognizes first-party sources when root and source use different realpath aliases", () => {
    const realRepo = join(dir, "real-repo");
    const aliasRepo = join(dir, "alias-repo");
    const skillDir = join(realRepo, "packs", "clean");
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(join(skillDir, "SKILL.md"), "# Clean\n", "utf8");
    try {
      symlinkSync(realRepo, aliasRepo, process.platform === "win32" ? "junction" : "dir");
    } catch {
      return;
    }

    const source = resolveTrustSource("packs/clean", { root: aliasRepo });

    if (source.kind !== "local") throw new Error("expected local source");
    expect(source.root).toBe(realpathSync(skillDir));
    expect(realpathSync(aliasRepo)).toBe(realpathSync(realRepo));
    expect(isFirstPartySource(aliasRepo, source)).toBe(true);
  });

  it("resolves owner/repo sources and builds a quarantined, scrubbed fetch exec", () => {
    const pin = "a".repeat(40);
    const source = resolveTrustSource("Owner/Repo", { root: dir, pin });
    expect(source).toMatchObject({
      kind: "github",
      id: "owner-repo",
      owner: "Owner",
      repo: "Repo",
      ref: pin,
      pin,
    });
    if (source.kind !== "github") throw new Error("expected GitHub source");

    const action = trustFetchExec(
      source,
      ctx({
        PATH: "safe-bin",
        GITHUB_TOKEN: "secret",
        HTTPS_PROXY: "http://proxy.example:8443",
        HTTP_PROXY: "http://proxy.example:8080",
        NO_PROXY: "github.com",
        OPENAI_API_KEY: "secret",
        NODE_EXTRA_CA_CERTS: "corp.pem",
      }),
    );

    expect(action.argv[0]).toBe(process.execPath);
    expect(action.cwd).toBe(source.quarantineRoot);
    expect(action.timeoutMs).toBe(120_000);
    expect(action.env).toMatchObject({
      PATH: "safe-bin",
      HTTPS_PROXY: "http://proxy.example:8443",
      HTTP_PROXY: "http://proxy.example:8080",
      NO_PROXY: "github.com",
      NODE_EXTRA_CA_CERTS: "corp.pem",
    });
    expect(action.env).not.toHaveProperty("GITHUB_TOKEN");
    expect(action.env).not.toHaveProperty("OPENAI_API_KEY");
    rmSync(source.quarantineRoot, { recursive: true, force: true });
  });

  it("creates fresh owner-only GitHub quarantine roots from mkdtemp", () => {
    const first = resolveTrustSource("Owner/Repo", { root: dir, ref: "main" });
    const second = resolveTrustSource("Owner/Repo", { root: dir, ref: "main" });
    try {
      if (first.kind !== "github" || second.kind !== "github") {
        throw new Error("expected GitHub source");
      }

      expect(first.quarantineRoot).not.toBe(second.quarantineRoot);
      expect(first.quarantineRoot).toContain("aih-quarantine-");
      expect(first.treePath).toBe(join(first.quarantineRoot, "tree"));
      expect(first.metadataPath).toBe(join(first.quarantineRoot, "metadata.json"));
      if (process.platform !== "win32") {
        expect(lstatSync(first.quarantineRoot).mode & 0o077).toBe(0);
      }
    } finally {
      if (first.kind === "github") rmSync(first.quarantineRoot, { recursive: true, force: true });
      if (second.kind === "github") rmSync(second.quarantineRoot, { recursive: true, force: true });
    }
  });

  it("refuses quarantined tar symlink entries instead of materializing target bytes", () => {
    const source = resolveTrustSource("Owner/Repo", { root: dir, pin: "a".repeat(40) });
    if (source.kind !== "github") throw new Error("expected GitHub source");
    try {
      const script = trustFetchExec(source, ctx()).argv[2] ?? "";

      expect(script).toContain('type === "2"');
      expect(script).toContain("refusing tar symlink entry");
      expect(script).not.toContain("writeFileOwner(link.target, fs.readFileSync(resolved))");
    } finally {
      rmSync(source.quarantineRoot, { recursive: true, force: true });
    }
  });

  it("fails closed when executing the quarantined tar extractor on a symlink entry", async () => {
    const outRoot = join(dir, "tree");
    await expect(
      runFetchScriptHelpers<void>(
        [
          `const tarball = Buffer.from(${JSON.stringify(tarWithSymlinkEntry().toString("base64"))}, "base64");`,
          `extractTar(tarball, ${JSON.stringify(outRoot)});`,
        ].join("\n"),
      ),
    ).rejects.toThrow(
      /script exited 1: refusing tar symlink entry: repo-aaaaaaaa\/skills\/clean\/LICENSE -> skills\/sibling\/LICENSE/,
    );
    expect(existsSync(outRoot)).toBe(false);
  });

  it("honors NO_PROXY in the quarantined fetch helper", async () => {
    const result = await runFetchScriptHelpers<{
      bypassGithub: boolean;
      bypassSubdomain: boolean;
      proxiedHost: string;
    }>(
      [
        'process.env.HTTPS_PROXY = "http://proxy.example:8080";',
        'process.env.NO_PROXY = "api.github.com,.corp.example:443";',
        "const github = proxyFor(new URL('https://api.github.com/repos/owner/repo'));",
        "const corp = proxyFor(new URL('https://tools.corp.example/status'));",
        "const codeload = proxyFor(new URL('https://codeload.github.com/owner/repo'));",
        "return {",
        "  bypassGithub: github === undefined,",
        "  bypassSubdomain: corp === undefined,",
        "  proxiedHost: codeload && codeload.hostname,",
        "};",
      ].join("\n"),
    );

    expect(result).toEqual({
      bypassGithub: true,
      bypassSubdomain: true,
      proxiedHost: "proxy.example",
    });
  });

  it("uses HTTP CONNECT for proxied GitHub HTTPS fetches", async () => {
    const proxy = createServer();
    const sockets = new Set<{ destroy: () => void }>();
    let connectPath = "";
    let proxyAuth = "";
    proxy.on("connect", (req, socket) => {
      sockets.add(socket);
      socket.once("close", () => sockets.delete(socket));
      connectPath = req.url ?? "";
      proxyAuth = String(req.headers["proxy-authorization"] ?? "");
      socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
    });
    await new Promise<void>((resolve) => proxy.listen(0, "127.0.0.1", resolve));
    const port = (proxy.address() as AddressInfo).port;
    try {
      const result = await runFetchScriptHelpers<{ connected: boolean }>(
        [
          `process.env.HTTPS_PROXY = "http://user:pass@127.0.0.1:${port}";`,
          "const target = new URL('https://codeload.github.com/owner/repo');",
          "const socket = await connectThroughProxy(target, proxyFor(target));",
          "socket.destroy();",
          "return { connected: true };",
        ].join("\n"),
      );

      expect(result.connected).toBe(true);
      expect(connectPath).toBe("codeload.github.com:443");
      expect(proxyAuth).toMatch(/^Basic /);
    } finally {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => proxy.close(() => resolve()));
    }
  });

  it("rejects a redirect outside the trusted GitHub fetch endpoints before connecting", async () => {
    await expect(
      runFetchScriptHelpers<string>(
        [
          "return await new Promise((resolve) => {",
          "  collectResponse('https://api.github.com/repos/owner/repo', {",
          "    statusCode: 302,",
          "    headers: { location: 'https://redirect.example/collect' },",
          "    resume: () => undefined,",
          "  }, () => resolve('redirect accepted'), (err) => resolve(err.message));",
          "});",
        ].join("\n"),
        {},
        {
          "node:https": {
            request: (target: URL) => {
              throw new Error(`network attempt to ${target}`);
            },
          },
        },
      ),
    ).rejects.toThrow(/refusing redirect outside trusted GitHub endpoints/);
  });

  it("permits only bounded HTTPS redirects on canonical GitHub fetch hosts", async () => {
    const allowed = await runFetchScriptHelpers<string>(
      "return trustedRedirectTarget('/owner/repo/tar.gz/sha', 'https://codeload.github.com/start', 0).toString();",
    );
    expect(allowed).toBe("https://codeload.github.com/owner/repo/tar.gz/sha");

    for (const location of [
      "http://api.github.com/repos/owner/repo",
      "https://api.github.com:8443/repos/owner/repo",
      "https://user@api.github.com/repos/owner/repo",
    ]) {
      await expect(
        runFetchScriptHelpers<void>(
          `trustedRedirectTarget(${JSON.stringify(location)}, 'https://api.github.com/start', 0);`,
        ),
      ).rejects.toThrow(/refusing redirect outside trusted GitHub endpoints/);
    }

    await expect(
      runFetchScriptHelpers<void>(
        "trustedRedirectTarget('/next', 'https://api.github.com/start', 3);",
      ),
    ).rejects.toThrow(/refusing redirect chain longer than 3 hops/);
  });

  it("rejects --pin values that are not full commit SHAs", () => {
    expect(() => resolveTrustSource("Owner/Repo", { root: dir, pin: "main" })).toThrow(
      /40-character Git commit SHA/i,
    );
    expect(() => resolveTrustSource("Owner/Repo", { root: dir, pin: "A".repeat(40) })).toThrow(
      /lowercase 40-character Git commit SHA/i,
    );
  });

  it("rejects refs that could be interpreted as git options", () => {
    expect(() =>
      resolveTrustSource("Owner/Repo", { root: dir, ref: "--upload-pack=evil" }),
    ).toThrow(/--ref must be a safe Git ref/i);
  });

  it("limits DBus access and XDG_RUNTIME_DIR to Docker clients while preserving non-secret cache paths", () => {
    const env = {
      PATH: "bin",
      HOME: "/home/me",
      DBUS_SESSION_BUS_ADDRESS: "unix:path=/run/flatpak/bus",
      XDG_CACHE_HOME: "/home/me/.cache",
      XDG_RUNTIME_DIR: "/run/user/1000",
      HTTPS_PROXY: "http://proxy.example:8443",
      HTTP_PROXY: "http://proxy.example:8080",
      NO_PROXY: "localhost,.corp.example",
      AWS_SECRET_ACCESS_KEY: "secret",
      RANDOM_VAR: "drop-me",
      SSL_CERT_FILE: "corp.pem",
      UV_CACHE_DIR: "/cache/uv",
    };
    const scrubbed = {
      PATH: "bin",
      HOME: "/home/me",
      XDG_CACHE_HOME: "/home/me/.cache",
      HTTPS_PROXY: "http://proxy.example:8443",
      HTTP_PROXY: "http://proxy.example:8080",
      NO_PROXY: "localhost,.corp.example",
      SSL_CERT_FILE: "corp.pem",
      UV_CACHE_DIR: "/cache/uv",
    };

    expect(scrubFetchEnv(env)).toEqual(scrubbed);
    expect(scrubFetchEnv(env)).not.toHaveProperty("XDG_RUNTIME_DIR");
    expect(scrubDockerClientEnv(env)).toEqual({
      ...scrubbed,
      DBUS_SESSION_BUS_ADDRESS: "unix:path=/run/flatpak/bus",
      XDG_RUNTIME_DIR: "/run/user/1000",
    });
  });

  it("allows in-tree symlinks but rejects links that resolve outside the trust source", () => {
    const skillDir = join(dir, "skills", "linked");
    const outside = mkdtempSync(join(tmpdir(), "aih-trust-outside-"));
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(join(skillDir, "CLAUDE.md"), "# Linked\n", "utf8");
    writeFileSync(join(outside, "SECRET.md"), "# Outside\n", "utf8");

    try {
      symlinkSync("CLAUDE.md", join(skillDir, "AGENTS.md"));
      expect(() => assertTrustTreeSafe(join(dir, "skills"))).not.toThrow();

      symlinkSync(join(outside, "SECRET.md"), join(skillDir, "ESCAPE.md"));
      expect(() => assertTrustTreeSafe(join(dir, "skills"))).toThrow(
        /outside|escape|trust source/i,
      );
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "EPERM") return;
      throw err;
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it("accepts a symlinked local source root after resolving it to the real tree", () => {
    const realRoot = join(dir, "real-source");
    const linkedRoot = join(dir, "linked-source");
    mkdirSync(realRoot, { recursive: true });
    writeFileSync(join(realRoot, "SKILL.md"), "# Root link\n", "utf8");
    try {
      symlinkSync(realRoot, linkedRoot, "dir");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "EPERM") return;
      throw err;
    }

    expect(assertTrustTreeSafe(linkedRoot)).toBe(realpathSync(realRoot));
  });

  it("rejects empty, unsupported, and escaping source-relative paths", () => {
    expect(() => resolveTrustSource(" ", { root: dir })).toThrow(/requires a source/);
    expect(() => resolveTrustSource("not a source!", { root: dir })).toThrow(/unsupported/);
    expect(() => safeSourceRelative(dir, join(dirname(dir), "outside.txt"))).toThrow(/escape/);
  });
});
