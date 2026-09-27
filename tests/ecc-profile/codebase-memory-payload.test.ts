import {
  chmodSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { codebaseMemoryNativeBinaryPath } from "../../src/ecc-profile/codebase-memory-runtime.js";

const fixtureBytes = Buffer.from("0123456789abcdef");
const fixturePin = {
  sha256: "9f9f5111f7b27a781f1f1ddde5ebc2dd2b796bfc7365c9c28b548e564176929f",
  size: fixtureBytes.length,
};

vi.mock("../../src/ecc-profile/codebase-memory-native-pins.js", () => ({
  CODEBASE_MEMORY_NATIVE_PAYLOAD_VERSION: "0.11.0",
  CODEBASE_MEMORY_NATIVE_PAYLOAD_PINS: Object.freeze({
    [`${process.platform}-${process.arch}`]: Object.freeze({
      sha256: "9f9f5111f7b27a781f1f1ddde5ebc2dd2b796bfc7365c9c28b548e564176929f",
      size: 16,
    }),
  }),
}));

import { authenticateCodebaseMemoryNativePayload } from "../../src/ecc-profile/codebase-memory-payload.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture(): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "aih-memory-native-payload-")));
  roots.push(root);
  return root;
}

function payloadPath(runtimeHome: string): string {
  return codebaseMemoryNativeBinaryPath(process.platform, runtimeHome);
}

function writePayload(runtimeHome: string, bytes = fixtureBytes, mode = 0o700): string {
  const path = payloadPath(runtimeHome);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, bytes, { mode });
  if (process.platform !== "win32") chmodSync(path, mode);
  return path;
}

function authenticate(runtimeHome: string) {
  return authenticateCodebaseMemoryNativePayload({
    runtimeHome,
    platform: process.platform,
    arch: process.arch,
  });
}

describe("Codebase Memory native payload authentication", () => {
  it("binds the complete frozen native payload matrix", async () => {
    const actual = await vi.importActual<
      typeof import("../../src/ecc-profile/codebase-memory-native-pins.js")
    >("../../src/ecc-profile/codebase-memory-native-pins.js");
    expect(actual.CODEBASE_MEMORY_NATIVE_PAYLOAD_VERSION).toBe("0.11.0");
    expect(Object.isFrozen(actual.CODEBASE_MEMORY_NATIVE_PAYLOAD_PINS)).toBe(true);
    expect(Object.values(actual.CODEBASE_MEMORY_NATIVE_PAYLOAD_PINS).every(Object.isFrozen)).toBe(
      true,
    );
    expect(actual.CODEBASE_MEMORY_NATIVE_PAYLOAD_PINS).toEqual({
      "darwin-x64": {
        sha256: "69ca71b4b62fe233677851bdf54953e2a6660cf5d687b4d64226b2591b14ed39",
        size: 301_399_520,
      },
      "darwin-arm64": {
        sha256: "a67b7ccead5d2ca852051f8619458ab96af41393257b56fb36e523a110265d48",
        size: 302_755_632,
      },
      "linux-x64": {
        sha256: "ce11c141431aeadd788506c3a7e6942db8fd438dec369d0707a39ec9fd8c6510",
        size: 299_891_744,
      },
      "linux-arm64": {
        sha256: "403d0fab6204e712916701936a3229dd472bad05080c757ea5177318a80fdbfe",
        size: 299_227_216,
      },
      "win32-x64": {
        sha256: "7edcd3807ebcfd85ec1968985964080f2589748da2fc3c7ce9261eebab31ff04",
        size: 301_530_624,
      },
      "win32-arm64": {
        sha256: "5615aa31e3cdbe6155e7096c43d07e62e335fe34d28e489b4cc3ce113e81b4e6",
        size: 301_693_952,
      },
    });
  });

  it("streams and authenticates the exact regular fixture without retaining it in memory", async () => {
    const runtimeHome = fixture();
    const path = writePayload(runtimeHome);
    await expect(authenticate(runtimeHome)).resolves.toEqual({
      path: await realpath(path),
      sha256: fixturePin.sha256,
      size: fixturePin.size,
      version: "0.11.0",
    });
  });

  it("rejects unsupported hosts and a missing expected payload before launch", async () => {
    const runtimeHome = fixture();
    await expect(
      authenticateCodebaseMemoryNativePayload({
        runtimeHome,
        platform: "freebsd" as NodeJS.Platform,
        arch: "x64",
      }),
    ).rejects.toThrow(/not supported/i);
    await expect(authenticate(runtimeHome)).rejects.toThrow(/unavailable/i);
  });

  it("rejects a truncated payload before hashing it", async () => {
    const runtimeHome = fixture();
    writePayload(runtimeHome, fixtureBytes.subarray(0, fixtureBytes.length - 1));
    await expect(authenticate(runtimeHome)).rejects.toThrow(/unexpected size/i);
  });

  it("rejects a same-size payload whose streamed SHA-256 does not match", async () => {
    const runtimeHome = fixture();
    writePayload(runtimeHome, Buffer.from("fedcba9876543210"));
    await expect(authenticate(runtimeHome)).rejects.toThrow(/SHA-256/i);
  });

  it("rejects hard-linked and symbolic-link payload paths", async () => {
    const runtimeHome = fixture();
    const path = writePayload(runtimeHome);
    linkSync(path, join(runtimeHome, "second-link"));
    await expect(authenticate(runtimeHome)).rejects.toThrow(/unambiguous regular file/i);

    rmSync(path);
    writeFileSync(join(runtimeHome, "outside"), fixtureBytes, { mode: 0o700 });
    try {
      symlinkSync(join(runtimeHome, "outside"), path, "file");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EPERM") return;
      throw error;
    }
    await expect(authenticate(runtimeHome)).rejects.toThrow(/symbolic link/i);
  });

  it("rejects linked ancestry rather than following an extracted payload redirect", async () => {
    const runtimeHome = fixture();
    const external = join(runtimeHome, "external");
    mkdirSync(external);
    const linkedDirectory = dirname(dirname(payloadPath(runtimeHome)));
    mkdirSync(dirname(linkedDirectory), { recursive: true });
    try {
      symlinkSync(external, linkedDirectory, process.platform === "win32" ? "junction" : "dir");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EPERM") return;
      throw error;
    }
    await expect(authenticate(runtimeHome)).rejects.toThrow(/payload directory.*real directory/i);
  });

  it("rejects a linked runtime home before deriving the native path", async () => {
    const parent = fixture();
    const realRuntimeHome = join(parent, "real-runtime-home");
    const linkedRuntimeHome = join(parent, "linked-runtime-home");
    mkdirSync(realRuntimeHome);
    try {
      symlinkSync(
        realRuntimeHome,
        linkedRuntimeHome,
        process.platform === "win32" ? "junction" : "dir",
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EPERM") return;
      throw error;
    }
    await expect(authenticate(linkedRuntimeHome)).rejects.toThrow(/runtime home.*real directory/i);
  });

  it.runIf(process.platform !== "win32")("rejects a non-executable Unix payload", async () => {
    const runtimeHome = fixture();
    writePayload(runtimeHome, fixtureBytes, 0o600);
    await expect(authenticate(runtimeHome)).rejects.toThrow(/executable on Unix/i);
  });
});
