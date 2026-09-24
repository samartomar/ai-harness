import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { gzipSync } from "node:zlib";
import { canonicalStrictJsonBytesV1 } from "../../src/contract/strict-json-v1.js";

export const sha256 = (bytes: Buffer | string) => createHash("sha256").update(bytes).digest("hex");

/** A canonical framework descriptor whose digest Core's authority table does not accept. */
export const CANDIDATE_DESCRIPTOR_PIN = "f".repeat(40);
export const candidateDescriptorBytes = Buffer.concat([
  canonicalStrictJsonBytesV1({
    format: "aih-catalog-framework-descriptor",
    version: 1,
    frameworkId: "superpowers",
    sections: { vendorLock: { pinnedSha: CANDIDATE_DESCRIPTOR_PIN } },
  }),
  Buffer.from("\n"),
]);

/** The files of a minimal candidate package, keyed by package-relative path. */
export function candidatePackageFiles(
  overrides: Record<string, Buffer | string | undefined> = {},
): Record<string, Buffer | string> {
  const files: Record<string, Buffer | string | undefined> = {
    "package.json": JSON.stringify({
      name: "@aihq/catalog",
      version: "0.3.0",
      exports: {
        "./catalog-framework-superpowers.json": "./defaults/catalog-framework-superpowers-v1.json",
        "./package.json": "./package.json",
      },
    }),
    "defaults/catalog-framework-superpowers-v1.json": candidateDescriptorBytes,
    ...overrides,
  };
  return Object.fromEntries(
    Object.entries(files).filter((entry): entry is [string, Buffer | string] => !!entry[1]),
  );
}

export function candidateDirectory(files: Record<string, Buffer | string>): string {
  const root = mkdtempSync(join(realpathSync(tmpdir()), "aih-candidate-catalog-"));
  for (const [path, bytes] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), bytes);
  }
  return root;
}

/** sha256 of `<sha256>  <path>\n` per regular file, in byte order of the path. */
export function candidateListingDigest(files: Record<string, Buffer | string>): string {
  return sha256(
    Object.keys(files)
      .sort((left, right) => (left < right ? -1 : left > right ? 1 : 0))
      .map((path) => `${sha256(files[path] as Buffer | string)}  ${path}\n`)
      .join(""),
  );
}

function header(path: string, size: number, type: string): Buffer {
  const block = Buffer.alloc(512);
  block.write(path, 0, 100, "utf8");
  block.write("0000644\0", 100);
  block.write("0000000\0", 108);
  block.write("0000000\0", 116);
  block.write(`${size.toString(8).padStart(11, "0")}\0`, 124);
  block.write("00000000000\0", 136);
  block.write("        ", 148);
  block.write(type, 156);
  block.write("ustar\0", 257);
  block.write("00", 263);
  let sum = 0;
  for (const byte of block) sum += byte;
  block.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148);
  return block;
}

/**
 * An uncompressed ustar archive; entries are [path, bytes, type, declared size]. The declared
 * size defaults to the byte length; the bytes are padded to whole blocks either way.
 */
export function candidateTar(
  entries: readonly (readonly [string, Buffer | string, string?, number?])[],
  end: Buffer = Buffer.alloc(1024),
): Buffer {
  const blocks: Buffer[] = [];
  for (const [path, content, type = "0", size] of entries) {
    const bytes = Buffer.from(content);
    blocks.push(header(path, size ?? bytes.length, type), bytes);
    blocks.push(Buffer.alloc((512 - (bytes.length % 512)) % 512));
  }
  blocks.push(end);
  return Buffer.concat(blocks);
}

/** A gzip'd ustar archive, as `npm pack` writes one; entries are [path, bytes, type]. */
export function candidateTarball(
  entries: readonly (readonly [string, Buffer | string, string?, number?])[],
): Buffer {
  return gzipSync(candidateTar(entries));
}

/** A pax extended header body: one `<length> <key>=<value>\n` record per pair. */
export function paxBody(records: readonly (readonly [string, string])[]): string {
  return records
    .map(([key, value]) => {
      const text = ` ${key}=${value}\n`;
      let length = Buffer.byteLength(text) + 1;
      while (String(length).length + Buffer.byteLength(text) !== length) length += 1;
      return `${length}${text}`;
    })
    .join("");
}

export function packageEntries(
  files: Record<string, Buffer | string>,
): (readonly [string, Buffer | string])[] {
  return Object.entries(files).map(([path, bytes]) => [`package/${path}`, bytes] as const);
}
