import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync } from "node:fs";
import { join } from "node:path";
import {
  assertSafeRelativePosixPathV1,
  assertStrictJsonValueV1,
} from "../contract/strict-json-v1.js";

const marker = "__aihSourceFileV1";
const digest = (bytes: Buffer) => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;

function readDescriptorBackedCompilerFileV1(
  path: string,
  expected: Readonly<{ bytes: number; sha256: string }>,
): Buffer {
  let descriptor: number | undefined;
  try {
    descriptor = openSync(
      path,
      constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0),
    );
    const opened = fstatSync(descriptor);
    const named = lstatSync(path);
    if (
      !opened.isFile() ||
      named.isSymbolicLink() ||
      !named.isFile() ||
      opened.ino !== named.ino ||
      opened.dev !== named.dev ||
      opened.size !== named.size
    )
      throw new TypeError("Compiler source changed during open");
    if (opened.size !== expected.bytes) throw new TypeError("Compiler source exceeds bounds");
    const buffer = Buffer.alloc(opened.size + 1);
    let length = 0;
    while (length < buffer.length) {
      const count = readSync(descriptor, buffer, length, buffer.length - length, null);
      if (count === 0) break;
      length += count;
    }
    const after = fstatSync(descriptor);
    const bytes = buffer.subarray(0, length);
    if (length !== opened.size || after.size !== opened.size || after.mtimeMs !== opened.mtimeMs)
      throw new TypeError("Compiler source changed during read");
    if (digest(bytes) !== expected.sha256) throw new TypeError("Compiler source identity mismatch");
    return Buffer.from(bytes);
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}
/** Reconstructible package metadata; source bytes stay in the exact upstream archive. */
export function sourceCompilerTemplateV1(input: unknown): unknown {
  assertStrictJsonValueV1(input, "Source compiler input");
  let nodes = 0;
  function visit(value: unknown, depth: number): unknown {
    if (++nodes > 100_000 || depth > 64) throw new TypeError("Compiler template exceeds bounds");
    if (Array.isArray(value)) return value.map((item) => visit(item, depth + 1));
    if (value === null || typeof value !== "object") return value;
    const object = value as Record<string, unknown>;
    if (Object.hasOwn(object, marker)) throw new TypeError("Reserved compiler template marker");
    const result: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(object)) {
      if (
        key === "bytesBase64" &&
        typeof item === "string" &&
        typeof object.path === "string" &&
        typeof object.sha256 === "string"
      ) {
        const bytes = Buffer.from(item, "base64");
        if (bytes.toString("base64") !== item || digest(bytes) !== object.sha256)
          throw new TypeError("Compiler file identity mismatch");
        result[key] = {
          [marker]: {
            path: assertSafeRelativePosixPathV1(object.path, "compiler file"),
            sha256: object.sha256,
            bytes: bytes.length,
          },
        };
      } else result[key] = visit(item, depth + 1);
    }
    return result;
  }
  return visit(input, 0);
}

/** Connected release preparation only. No network, analyzer, or source execution. */
export function restoreSourceCompilerTemplateV1(template: unknown, sourceRoot: string): unknown {
  assertStrictJsonValueV1(template, "Source compiler template");
  let nodes = 0,
    total = 0;
  if (!lstatSync(sourceRoot).isDirectory() || lstatSync(sourceRoot).isSymbolicLink())
    throw new TypeError("Unsafe source root");
  function visit(value: unknown, depth: number): unknown {
    if (++nodes > 100_000 || depth > 64) throw new TypeError("Compiler template exceeds bounds");
    if (Array.isArray(value)) return value.map((item) => visit(item, depth + 1));
    if (value === null || typeof value !== "object") return value;
    const object = value as Record<string, unknown>;
    if (Object.hasOwn(object, marker)) {
      const file = object[marker] as Record<string, unknown>;
      if (
        Object.keys(object).length !== 1 ||
        !file ||
        typeof file !== "object" ||
        Object.keys(file).sort().join() !== "bytes,path,sha256" ||
        typeof file.path !== "string" ||
        typeof file.sha256 !== "string" ||
        !/^sha256:[a-f0-9]{64}$/.test(file.sha256) ||
        !Number.isSafeInteger(file.bytes) ||
        (file.bytes as number) < 0 ||
        (file.bytes as number) > 16 * 1024 * 1024
      )
        throw new TypeError("Invalid compiler source reference");
      const relative = assertSafeRelativePosixPathV1(file.path, "compiler source reference");
      let current = sourceRoot;
      for (const part of relative.split("/")) {
        current = join(current, part);
        if (lstatSync(current).isSymbolicLink())
          throw new TypeError("Linked compiler source reference");
      }
      const bytes = readDescriptorBackedCompilerFileV1(current, {
        bytes: file.bytes as number,
        sha256: file.sha256,
      });
      total += bytes.length;
      if (total > 64 * 1024 * 1024) throw new TypeError("Compiler source exceeds bounds");
      return bytes.toString("base64");
    }
    return Object.fromEntries(
      Object.entries(object).map(([key, item]) => [key, visit(item, depth + 1)]),
    );
  }
  return visit(template, 0);
}
