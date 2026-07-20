import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { type BindingLock, BindingLockSchema, BindingWriteSchema } from "../../src/binding/lock.js";
import {
  BINDING_HOSTS,
  BINDING_SCHEMA_VERSION,
  type BindingDeclaration,
  BindingDeclarationSchema,
  FRAMEWORK_IDS,
} from "../../src/binding/schema.js";

/**
 * Bounded property-based breadth pass over the binding declaration/lock schemas
 * (see schema.test.ts / lock.test.ts for the example-based coverage this
 * generalizes, not duplicates). Five properties: declaration round-trip,
 * identity-mutation rejection, strictness (unknown keys never stripped),
 * SafeRelPath acceptance/rejection, and the lock match/digest tying invariant.
 * Pure schema parsing only: no filesystem, subprocesses, or network.
 */

const NUM_RUNS = 100;

// ---------------------------------------------------------------------------
// Shared character-class arbitraries
// ---------------------------------------------------------------------------

const LOWER_HEX_CHARS = "0123456789abcdef".split("");
const hexCharArb = fc.constantFrom(...LOWER_HEX_CHARS);

/** Exact-length lowercase hex string (commitSha / sha256 digest fields). */
function hexStr(length: number): fc.Arbitrary<string> {
  return fc
    .array(hexCharArb, { minLength: length, maxLength: length })
    .map((chars) => chars.join(""));
}

const upperHexLetterArb = fc.constantFrom(..."ABCDEF".split(""));
const nonHexCharArb = fc.constantFrom(..."ghijklmnopqrstuvwxyzGHIJKLMNOPQRSTUVWXYZ!@$".split(""));

function replaceCharAt(value: string, index: number, char: string): string {
  return value.slice(0, index) + char + value.slice(index + 1);
}

// ---------------------------------------------------------------------------
// git repository arbitrary: plausible https URL or bare owner/repo, mirroring
// isPlausibleGitRepository (no '#', no whitespace, no leading '-').
// ---------------------------------------------------------------------------

const repoHeadCharArb = fc.constantFrom(
  ..."abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_.".split(""),
);
const repoTailCharArb = fc.constantFrom(
  ..."abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_.-".split(""),
);

function repoSegmentArb(): fc.Arbitrary<string> {
  return fc
    .tuple(repoHeadCharArb, fc.array(repoTailCharArb, { maxLength: 12 }))
    .map(([head, tail]) => head + tail.join(""));
}

const ownerRepoArb = fc
  .tuple(repoSegmentArb(), repoSegmentArb())
  .map(([owner, repo]) => `${owner}/${repo}`);

const httpsPathCharArb = fc.constantFrom(
  ..."abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789/_.-".split(""),
);
const httpsRepoArb = fc
  .tuple(
    fc.constantFrom("github.com", "gitlab.com", "example.org"),
    fc.array(httpsPathCharArb, { minLength: 1, maxLength: 20 }),
  )
  .map(([host, path]) => `https://${host}/${path.join("")}`);

const gitRepositoryArb = fc.oneof(ownerRepoArb, httpsRepoArb);

// ---------------------------------------------------------------------------
// npm package name arbitrary, mirroring NPM_PACKAGE.
// ---------------------------------------------------------------------------

const pkgHeadCharArb = fc.constantFrom(..."abcdefghijklmnopqrstuvwxyz0123456789".split(""));
const pkgTailCharArb = fc.constantFrom(..."abcdefghijklmnopqrstuvwxyz0123456789._-".split(""));

function pkgSegmentArb(): fc.Arbitrary<string> {
  return fc
    .tuple(pkgHeadCharArb, fc.array(pkgTailCharArb, { maxLength: 10 }))
    .map(([head, tail]) => head + tail.join(""));
}

const npmPackageArb = fc.oneof(
  pkgSegmentArb(),
  fc.tuple(pkgSegmentArb(), pkgSegmentArb()).map(([scope, name]) => `@${scope}/${name}`),
);

// ---------------------------------------------------------------------------
// Exact semver arbitrary with optional prerelease/build, mirroring EXACT_SEMVER.
// ---------------------------------------------------------------------------

const identifierFirstCharArb = fc.constantFrom(
  ..."0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz".split(""),
);
const identifierTailCharArb = fc.constantFrom(
  ..."0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz.-".split(""),
);

function semverIdentifierArb(): fc.Arbitrary<string> {
  return fc
    .tuple(identifierFirstCharArb, fc.array(identifierTailCharArb, { maxLength: 8 }))
    .map(([head, tail]) => head + tail.join(""));
}

const exactSemverArb = fc
  .tuple(
    fc.nat({ max: 999 }),
    fc.nat({ max: 999 }),
    fc.nat({ max: 999 }),
    fc.option(semverIdentifierArb(), { nil: undefined }),
    fc.option(semverIdentifierArb(), { nil: undefined }),
  )
  .map(([major, minor, patch, prerelease, build]) => {
    let version = `${major}.${minor}.${patch}`;
    if (prerelease !== undefined) version += `-${prerelease}`;
    if (build !== undefined) version += `+${build}`;
    return version;
  });

// ---------------------------------------------------------------------------
// SRI sha512 integrity arbitrary: "sha512-" + 86 base64 chars + "==", mirroring
// SRI_SHA512.
// ---------------------------------------------------------------------------

const sriBodyCharArb = fc.constantFrom(
  ..."ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/".split(""),
);
const sriBodyArb = fc
  .array(sriBodyCharArb, { minLength: 86, maxLength: 86 })
  .map((chars) => chars.join(""));
const integrityArb = sriBodyArb.map((body) => `sha512-${body}==`);

// ---------------------------------------------------------------------------
// framework / declaration arbitraries. mode is only ever generated when
// id === "ecc", matching MODE_FRAMEWORK.
// ---------------------------------------------------------------------------

const hostArb = fc.constantFrom(...BINDING_HOSTS);
const modeArb = fc.constantFrom("lean" as const, "full" as const);
const nonEccFrameworkIdArb = fc.constantFrom(...FRAMEWORK_IDS.filter((id) => id !== "ecc"));

/**
 * Framework arbitrary built as a flat oneof (rather than chaining on id) so each
 * branch's shape is independently inferred: mode is only ever attached to "ecc",
 * matching MODE_FRAMEWORK.
 */
function frameworkArb() {
  return fc.oneof(
    fc.record({ id: nonEccFrameworkIdArb, host: hostArb }),
    fc.record({ id: fc.constant("ecc" as const), host: hostArb }),
    fc.record({ id: fc.constant("ecc" as const), mode: modeArb, host: hostArb }),
  );
}

function gitSourceArb() {
  return fc.record({
    kind: fc.constant("git" as const),
    repository: gitRepositoryArb,
    commitSha: hexStr(40),
    treeDigest: hexStr(64),
  });
}

function npmSourceArb() {
  return fc.record({
    kind: fc.constant("npm" as const),
    package: npmPackageArb,
    exactVersion: exactSemverArb,
    integrity: integrityArb,
  });
}

function gitDeclarationArb() {
  return fc.record({
    schemaVersion: fc.constant(BINDING_SCHEMA_VERSION),
    framework: frameworkArb(),
    source: gitSourceArb(),
  });
}

function npmDeclarationArb() {
  return fc.record({
    schemaVersion: fc.constant(BINDING_SCHEMA_VERSION),
    framework: frameworkArb(),
    source: npmSourceArb(),
  });
}

describe("1. declaration round-trip", () => {
  it("round-trips arbitrary valid git declarations through parse -> serialize -> parse", () => {
    fc.assert(
      fc.property(gitDeclarationArb(), (declaration) => {
        const first = BindingDeclarationSchema.parse(declaration);
        const second = BindingDeclarationSchema.parse(JSON.parse(JSON.stringify(first)));
        expect(second).toEqual(first);
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it("round-trips arbitrary valid npm declarations through parse -> serialize -> parse", () => {
    fc.assert(
      fc.property(npmDeclarationArb(), (declaration) => {
        const first = BindingDeclarationSchema.parse(declaration);
        const second = BindingDeclarationSchema.parse(JSON.parse(JSON.stringify(first)));
        expect(second).toEqual(first);
      }),
      { numRuns: NUM_RUNS },
    );
  });
});

describe("2. identity rejection properties", () => {
  describe("git commitSha mutations", () => {
    it("rejects a shortened commitSha", () => {
      fc.assert(
        fc.property(gitDeclarationArb(), fc.integer({ min: 1, max: 39 }), (declaration, cut) => {
          const shortened = declaration.source.commitSha.slice(0, 40 - cut);
          const mutated = {
            ...declaration,
            source: { ...declaration.source, commitSha: shortened },
          };
          expect(BindingDeclarationSchema.safeParse(mutated).success).toBe(false);
        }),
        { numRuns: NUM_RUNS },
      );
    });

    it("rejects a lengthened commitSha", () => {
      fc.assert(
        fc.property(
          gitDeclarationArb(),
          fc.integer({ min: 1, max: 20 }),
          hexStr(20),
          (declaration, count, pool) => {
            const lengthened = declaration.source.commitSha + pool.slice(0, count);
            const mutated = {
              ...declaration,
              source: { ...declaration.source, commitSha: lengthened },
            };
            expect(BindingDeclarationSchema.safeParse(mutated).success).toBe(false);
          },
        ),
        { numRuns: NUM_RUNS },
      );
    });

    it("rejects a commitSha with an uppercase character inserted anywhere", () => {
      fc.assert(
        fc.property(
          gitDeclarationArb(),
          fc.integer({ min: 0, max: 39 }),
          upperHexLetterArb,
          (declaration, index, upperChar) => {
            const mutatedSha = replaceCharAt(declaration.source.commitSha, index, upperChar);
            const mutated = {
              ...declaration,
              source: { ...declaration.source, commitSha: mutatedSha },
            };
            expect(BindingDeclarationSchema.safeParse(mutated).success).toBe(false);
          },
        ),
        { numRuns: NUM_RUNS },
      );
    });

    it("rejects a commitSha containing a non-hex character", () => {
      fc.assert(
        fc.property(
          gitDeclarationArb(),
          fc.integer({ min: 0, max: 39 }),
          nonHexCharArb,
          (declaration, index, nonHex) => {
            const mutatedSha = replaceCharAt(declaration.source.commitSha, index, nonHex);
            const mutated = {
              ...declaration,
              source: { ...declaration.source, commitSha: mutatedSha },
            };
            expect(BindingDeclarationSchema.safeParse(mutated).success).toBe(false);
          },
        ),
        { numRuns: NUM_RUNS },
      );
    });
  });

  describe("npm exactVersion mutations", () => {
    const rangePrefixArb = fc.constantFrom("^", "~", ">", "<", "=");

    it("rejects an exactVersion with a range operator prefix", () => {
      fc.assert(
        fc.property(npmDeclarationArb(), rangePrefixArb, (declaration, prefix) => {
          const mutated = {
            ...declaration,
            source: {
              ...declaration.source,
              exactVersion: `${prefix}${declaration.source.exactVersion}`,
            },
          };
          expect(BindingDeclarationSchema.safeParse(mutated).success).toBe(false);
        }),
        { numRuns: NUM_RUNS },
      );
    });

    const wildcardVersionArb = fc
      .tuple(
        fc.constantFrom("x", "*"),
        fc.integer({ min: 0, max: 2 }),
        fc.nat({ max: 999 }),
        fc.nat({ max: 999 }),
        fc.nat({ max: 999 }),
      )
      .map(([token, position, major, minor, patch]) => {
        const parts = [String(major), String(minor), String(patch)];
        parts[position] = token;
        return parts.join(".");
      });

    it("rejects an exactVersion with a wildcarded version component", () => {
      fc.assert(
        fc.property(npmDeclarationArb(), wildcardVersionArb, (declaration, wildcardVersion) => {
          const mutated = {
            ...declaration,
            source: { ...declaration.source, exactVersion: wildcardVersion },
          };
          expect(BindingDeclarationSchema.safeParse(mutated).success).toBe(false);
        }),
        { numRuns: NUM_RUNS },
      );
    });

    it("rejects the 'latest' dist-tag as exactVersion", () => {
      fc.assert(
        fc.property(npmDeclarationArb(), (declaration) => {
          const mutated = {
            ...declaration,
            source: { ...declaration.source, exactVersion: "latest" },
          };
          expect(BindingDeclarationSchema.safeParse(mutated).success).toBe(false);
        }),
        { numRuns: NUM_RUNS },
      );
    });
  });

  describe("npm integrity mutations", () => {
    const badPrefixArb = fc.constantFrom(
      "sha256-",
      "sha1-",
      "sha512_",
      "Sha512-",
      "SHA512-",
      "sha512",
    );

    it("rejects integrity with a non-'sha512-' prefix", () => {
      fc.assert(
        fc.property(npmDeclarationArb(), sriBodyArb, badPrefixArb, (declaration, body, prefix) => {
          const mutated = {
            ...declaration,
            source: { ...declaration.source, integrity: `${prefix}${body}==` },
          };
          expect(BindingDeclarationSchema.safeParse(mutated).success).toBe(false);
        }),
        { numRuns: NUM_RUNS },
      );
    });

    it("rejects integrity with a base64 body that is not exactly 86 characters", () => {
      fc.assert(
        fc.property(
          npmDeclarationArb(),
          fc.integer({ min: 1, max: 10 }),
          fc.boolean(),
          sriBodyArb,
          (declaration, delta, shorter, body) => {
            const badBody = shorter ? body.slice(0, 86 - delta) : body + body.slice(0, delta);
            const mutated = {
              ...declaration,
              source: { ...declaration.source, integrity: `sha512-${badBody}==` },
            };
            expect(BindingDeclarationSchema.safeParse(mutated).success).toBe(false);
          },
        ),
        { numRuns: NUM_RUNS },
      );
    });

    const badTailArb = fc.constantFrom("", "=", "===", "%%", "ab");

    it("rejects integrity missing or altering the '==' tail", () => {
      fc.assert(
        fc.property(npmDeclarationArb(), sriBodyArb, badTailArb, (declaration, body, tail) => {
          const mutated = {
            ...declaration,
            source: { ...declaration.source, integrity: `sha512-${body}${tail}` },
          };
          expect(BindingDeclarationSchema.safeParse(mutated).success).toBe(false);
        }),
        { numRuns: NUM_RUNS },
      );
    });
  });
});

const ROOT_RESERVED_KEYS = ["schemaVersion", "framework", "source"];
const FRAMEWORK_RESERVED_KEYS = ["id", "mode", "host", "features"];
const GIT_SOURCE_RESERVED_KEYS = ["kind", "repository", "commitSha", "treeDigest"];

function unknownKeyArb(reserved: readonly string[]): fc.Arbitrary<string> {
  return fc
    .tuple(
      fc.constantFrom(..."abcdefghijklmnopqrstuvwxyz".split("")),
      fc.array(fc.constantFrom(..."abcdefghijklmnopqrstuvwxyz0123456789".split("")), {
        maxLength: 9,
      }),
    )
    .map(([head, tail]) => head + tail.join(""))
    .filter((name) => !reserved.includes(name));
}

const unknownValueArb = fc.oneof(fc.boolean(), fc.integer(), fc.string(), fc.constant(null));

describe("3. strictness: unknown keys are always rejected, never stripped", () => {
  it("rejects an unknown key at the declaration root", () => {
    fc.assert(
      fc.property(
        gitDeclarationArb(),
        unknownKeyArb(ROOT_RESERVED_KEYS),
        unknownValueArb,
        (declaration, key, value) => {
          const mutated = { ...declaration, [key]: value };
          expect(BindingDeclarationSchema.safeParse(mutated).success).toBe(false);
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });

  it("rejects an unknown key on the framework object", () => {
    fc.assert(
      fc.property(
        gitDeclarationArb(),
        unknownKeyArb(FRAMEWORK_RESERVED_KEYS),
        unknownValueArb,
        (declaration, key, value) => {
          const mutated = { ...declaration, framework: { ...declaration.framework, [key]: value } };
          expect(BindingDeclarationSchema.safeParse(mutated).success).toBe(false);
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });

  it("rejects an unknown key on the source object", () => {
    fc.assert(
      fc.property(
        gitDeclarationArb(),
        unknownKeyArb(GIT_SOURCE_RESERVED_KEYS),
        unknownValueArb,
        (declaration, key, value) => {
          const mutated = { ...declaration, source: { ...declaration.source, [key]: value } };
          expect(BindingDeclarationSchema.safeParse(mutated).success).toBe(false);
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });
});

const goodPathSegCharArb = fc.constantFrom(
  ..."abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789".split(""),
);
function goodPathSegmentArb(): fc.Arbitrary<string> {
  return fc
    .array(goodPathSegCharArb, { minLength: 1, maxLength: 8 })
    .map((chars) => chars.join(""));
}
const goodPathArb = fc
  .array(goodPathSegmentArb(), { minLength: 1, maxLength: 4 })
  .map((segments) => segments.join("/"));

const pathSchema = BindingWriteSchema.shape.path;

describe("4. SafeRelPath (BindingWriteSchema.path)", () => {
  it("accepts simple well-formed posix relative paths (1-4 alphanumeric segments)", () => {
    fc.assert(
      fc.property(goodPathArb, (path) => {
        expect(pathSchema.safeParse(path).success).toBe(true);
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it("rejects a path containing a '..' segment", () => {
    fc.assert(
      fc.property(goodPathArb, fc.integer({ min: 0, max: 3 }), (path, position) => {
        const segments = path.split("/");
        const index = position % segments.length;
        segments[index] = "..";
        expect(pathSchema.safeParse(segments.join("/")).success).toBe(false);
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it("rejects a path containing a backslash", () => {
    fc.assert(
      fc.property(goodPathArb, (path) => {
        expect(pathSchema.safeParse(`${path}\\x`).success).toBe(false);
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it("rejects a path with a leading '/'", () => {
    fc.assert(
      fc.property(goodPathArb, (path) => {
        expect(pathSchema.safeParse(`/${path}`).success).toBe(false);
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it("rejects a path with a drive-letter prefix", () => {
    const driveLetterArb = fc.constantFrom(
      ..."ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz".split(""),
    );
    fc.assert(
      fc.property(goodPathArb, driveLetterArb, (path, letter) => {
        expect(pathSchema.safeParse(`${letter}:${path}`).success).toBe(false);
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it("rejects a path containing an empty segment ('//')", () => {
    fc.assert(
      fc.property(goodPathArb, (path) => {
        const mutated = path.includes("/") ? path.replace("/", "//") : `${path}//x`;
        expect(pathSchema.safeParse(mutated).success).toBe(false);
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it("rejects a path with a trailing '/'", () => {
    fc.assert(
      fc.property(goodPathArb, (path) => {
        expect(pathSchema.safeParse(`${path}/`).success).toBe(false);
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it("rejects a path containing a control character", () => {
    const controlCharArb = fc
      .oneof(fc.integer({ min: 0, max: 31 }), fc.constant(127))
      .map((code) => String.fromCharCode(code));
    fc.assert(
      fc.property(goodPathArb, controlCharArb, (path, control) => {
        expect(pathSchema.safeParse(`${path}${control}`).success).toBe(false);
      }),
      { numRuns: NUM_RUNS },
    );
  });
});

const FIXTURE_SHA_A = "a".repeat(64);
const FIXTURE_SHA_B = "b".repeat(64);

function fixtureDeclaration(): BindingDeclaration {
  return {
    schemaVersion: BINDING_SCHEMA_VERSION,
    framework: { id: "ecc", mode: "lean", host: "claude" },
    source: {
      kind: "git",
      repository: "affaan-m/ECC",
      commitSha: "c".repeat(40),
      treeDigest: FIXTURE_SHA_A,
    },
  };
}

function fixtureLock(overrides: Partial<BindingLock> = {}): BindingLock {
  return {
    schemaVersion: 1,
    declaration: fixtureDeclaration(),
    writes: [
      { path: ".claude/skills/ecc/SKILL.md", mechanism: "file", contentDigest: FIXTURE_SHA_B },
    ],
    scannedDigest: FIXTURE_SHA_A,
    loadedDigest: FIXTURE_SHA_A,
    match: true,
    ownership: [
      {
        kind: "json-pointer",
        target: "/mcpServers/ecc",
        preExisting: { absent: true },
        applied: { command: "ecc-mcp" },
        postApplyDigest: FIXTURE_SHA_B,
      },
      {
        kind: "file",
        target: ".claude/skills/ecc/SKILL.md",
        preExisting: { value: "old" },
        applied: FIXTURE_SHA_B,
        postApplyDigest: FIXTURE_SHA_B,
      },
    ],
    ...overrides,
  };
}

function distinctSha256PairArb(): fc.Arbitrary<[string, string]> {
  return fc
    .tuple(hexStr(64), fc.integer({ min: 0, max: 63 }), hexCharArb)
    .map(([base, index, replacement]) => {
      const original = base[index] ?? "0";
      const alt =
        replacement === original
          ? (LOWER_HEX_CHARS[(LOWER_HEX_CHARS.indexOf(replacement) + 1) % 16] ?? "0")
          : replacement;
      return [base, replaceCharAt(base, index, alt)];
    });
}

describe("5. lock match-tying property", () => {
  it("rejects match:true when scannedDigest and loadedDigest differ", () => {
    fc.assert(
      fc.property(distinctSha256PairArb(), ([scanned, loaded]) => {
        const candidate = fixtureLock({
          scannedDigest: scanned,
          loadedDigest: loaded,
          match: true,
        });
        expect(BindingLockSchema.safeParse(candidate).success).toBe(false);
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it("rejects match:false when scannedDigest and loadedDigest are equal", () => {
    fc.assert(
      fc.property(hexStr(64), (digest) => {
        const candidate = fixtureLock({
          scannedDigest: digest,
          loadedDigest: digest,
          match: false,
        });
        expect(BindingLockSchema.safeParse(candidate).success).toBe(false);
      }),
      { numRuns: NUM_RUNS },
    );
  });
});
