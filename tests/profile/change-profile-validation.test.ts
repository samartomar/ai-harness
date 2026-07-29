import { describe, expect, it } from "vitest";
import { ChangeProfileInputError } from "../../src/errors.js";
import {
  type ChangeProfileInput,
  classifyChangeProfile,
  renderChangeProfile,
  serializeChangeProfile,
} from "../../src/profile/change-profile.js";

function text(value: string) {
  return { kind: "text" as const, text: value, byteLength: Buffer.byteLength(value) };
}

function input(overrides: Partial<ChangeProfileInput> = {}): ChangeProfileInput {
  return {
    schemaVersion: 1,
    source: "worktree",
    changes: [
      {
        scope: "staged",
        status: "modified",
        path: "src/main.ts",
        previousPath: null,
        before: text("export const value = 1;\n"),
        after: text("export const value = 2;\n"),
      },
    ],
    ...overrides,
  };
}

function issueCodes(value: unknown): string[] {
  try {
    classifyChangeProfile(value);
  } catch (error) {
    expect(error).toBeInstanceOf(ChangeProfileInputError);
    const typed = error as ChangeProfileInputError;
    expect(typed.code).toBe("AIH_CHANGE_PROFILE_INPUT");
    expect(JSON.stringify(typed)).not.toContain("top-secret");
    return typed.issues.map((issue) => issue.issueCode);
  }
  throw new Error("expected validation failure");
}

describe("change-profile validation", () => {
  it("rejects unknown keys, enums, versions, empty input, and unknown normalized statuses", () => {
    expect(issueCodes({ ...input(), extra: true })).toContain("input.unknown-key");
    expect(issueCodes({ ...input(), schemaVersion: 2 })).toContain("input.schema-version");
    expect(issueCodes({ ...input(), source: "index" })).toContain("input.source");
    expect(issueCodes({ ...input(), changes: [] })).toContain("changes.empty");
    expect(
      issueCodes({
        ...input(),
        changes: [{ ...input().changes[0], status: "C", after: text("top-secret") }],
      }),
    ).toContain("change.status");
  });

  it("enforces paths, revisions, sides, duplicate/conflicting facts, and diff/untracked rules", () => {
    const base = input().changes[0];
    expect(issueCodes({ ...input(), changes: [{ ...base, path: "../escape.ts" }] })).toContain(
      "change.path",
    );
    expect(issueCodes({ ...input(), changes: [{ ...base, beforeRevision: "ABC" }] })).toContain(
      "change.revision",
    );
    expect(issueCodes({ ...input(), changes: [{ ...base, beforeRevision: 42 }] })).toContain(
      "change.revision",
    );
    expect(
      issueCodes({ ...input(), changes: [{ ...base, status: "added", before: text("x") }] }),
    ).toContain("change.sides");
    expect(issueCodes({ ...input(), changes: [base, base] })).toContain("change.duplicate");
    expect(
      issueCodes({
        ...input({ source: "diff" }),
        changes: [{ ...base, scope: "untracked", status: "added", before: null }],
      }),
    ).toContain("change.diff-untracked");
  });

  it("allows only the staged-delete plus untracked-readd exception", () => {
    const deleted = {
      ...input().changes[0],
      status: "deleted" as const,
      path: "notes",
      before: text("old"),
      after: null,
    };
    const readd = {
      ...deleted,
      scope: "untracked" as const,
      status: "added" as const,
      before: null,
      after: text("new"),
    };
    expect(() => classifyChangeProfile({ ...input(), changes: [deleted, readd] })).not.toThrow();
    const first = classifyChangeProfile({ ...input(), changes: [deleted, readd] });
    const second = classifyChangeProfile({ ...input(), changes: [readd, deleted] });
    expect(serializeChangeProfile(first)).toBe(serializeChangeProfile(second));
    expect(renderChangeProfile(first)).toBe(renderChangeProfile(second));
    expect(first.inputIdentity).toBe(second.inputIdentity);
    expect(
      issueCodes({
        ...input(),
        changes: [
          { ...readd, scope: "unstaged" },
          { ...readd, after: text("other") },
        ],
      }),
    ).toContain("change.conflict");
  });

  it("rejects invalid Unicode, NUL, unsafe sizes, and text limits", () => {
    const base = input().changes[0];
    expect(issueCodes({ ...input(), changes: [{ ...base, path: "a\u0000.ts" }] })).toContain(
      "change.path",
    );
    expect(
      issueCodes({
        ...input(),
        changes: [{ ...base, after: { kind: "text", text: "\ud800", byteLength: 3 } }],
      }),
    ).toContain("content.unicode");
    expect(
      issueCodes({
        ...input(),
        changes: [{ ...base, after: { kind: "text", text: "x", byteLength: 9 } }],
      }),
    ).toContain("content.byte-length");
    expect(
      issueCodes({
        ...input(),
        changes: [
          {
            ...base,
            after: { kind: "text", text: "x".repeat(262_145), byteLength: 262_145 },
          },
        ],
      }),
    ).toContain("content.too-large");
  });

  it("rejects C0, C1, and bidi controls in current and previous paths", () => {
    const base = input().changes[0];
    for (const control of ["\u001b", "\u0085", "\u061c", "\u202e", "\u2066"]) {
      expect(
        issueCodes({
          ...input(),
          changes: [{ ...base, path: `src/${control}main.ts` }],
        }),
      ).toContain("change.path");
      expect(
        issueCodes({
          ...input(),
          changes: [
            {
              ...base,
              status: "renamed",
              previousPath: `src/${control}old.ts`,
            },
          ],
        }),
      ).toContain("change.previous-path");
    }
  });

  it("requires denied paths to contain only policy-denied unreadable facts", () => {
    const base = input().changes[0];
    expect(
      issueCodes({ ...input(), changes: [{ ...base, path: ".env", after: text("top-secret") }] }),
    ).toContain("content.denied-path");
    expect(() =>
      classifyChangeProfile({
        ...input(),
        changes: [
          {
            ...base,
            path: "secrets/token",
            before: { kind: "unreadable", reason: "policy-denied" },
            after: { kind: "unreadable", reason: "policy-denied" },
          },
        ],
      }),
    ).not.toThrow();
    expect(() =>
      classifyChangeProfile({ ...input(), changes: [{ ...base, path: "src/secrets/token.ts" }] }),
    ).not.toThrow();
    expect(() =>
      classifyChangeProfile({ ...input(), changes: [{ ...base, path: ".env.example" }] }),
    ).not.toThrow();
    expect(() =>
      classifyChangeProfile({ ...input(), changes: [{ ...base, path: ".env.sample" }] }),
    ).not.toThrow();
    expect(issueCodes({ ...input(), changes: [{ ...base, path: "config/.env" }] })).toContain(
      "content.denied-path",
    );
    expect(
      issueCodes({
        ...input(),
        changes: [
          {
            ...base,
            status: "renamed",
            path: "config/app.yml",
            previousPath: ".env",
            before: text("top-secret"),
          },
        ],
      }),
    ).toContain("content.denied-path");
    expect(() =>
      classifyChangeProfile({
        ...input(),
        changes: [
          {
            ...base,
            status: "renamed",
            path: "config/app.yml",
            previousPath: ".env",
            before: { kind: "unreadable", reason: "policy-denied" },
          },
        ],
      }),
    ).not.toThrow();
  });

  it("constrains unavailable-content reason and code signals", () => {
    const base = input().changes[0];
    for (const content of [
      { kind: "unreadable", reason: "captured error text" },
      { kind: "unknown", code: "UPPERCASE" },
      { kind: "unknown", code: `x${"a".repeat(64)}` },
    ]) {
      expect(issueCodes({ ...input(), changes: [{ ...base, after: content }] })).toContain(
        "content.invalid",
      );
    }
    expect(() =>
      classifyChangeProfile({
        ...input(),
        changes: [{ ...base, after: { kind: "unknown", code: "gatherer-gap.1" } }],
      }),
    ).not.toThrow();
  });

  it("is canonical, deterministic, byte-sensitive, and never leaks content or revisions", () => {
    const second = {
      ...input().changes[0],
      path: "README.md",
      beforeRevision: "a".repeat(40),
      afterRevision: "b".repeat(64),
      before: text("top-secret\r\n"),
      after: text("top-secret\n"),
    };
    const a = classifyChangeProfile({ ...input(), changes: [second, input().changes[0]] });
    const b = classifyChangeProfile({ ...input(), changes: [input().changes[0], second] });
    expect(serializeChangeProfile(a)).toBe(serializeChangeProfile(b));
    expect(renderChangeProfile(a)).toBe(renderChangeProfile(b));
    expect(serializeChangeProfile(a)).toMatch(/^\{\n {2}"schemaVersion": 1,/);
    expect(serializeChangeProfile(a).endsWith("\n")).toBe(true);
    expect(serializeChangeProfile(a)).not.toContain("top-secret");
    expect(serializeChangeProfile(a)).not.toContain("a".repeat(40));
    expect(renderChangeProfile(a)).not.toContain("top-secret");
    const crlf = classifyChangeProfile({
      ...input(),
      changes: [{ ...input().changes[0], after: text("x\r\n") }],
    });
    const lf = classifyChangeProfile({
      ...input(),
      changes: [{ ...input().changes[0], after: text("x\n") }],
    });
    expect(crlf.inputIdentity).not.toBe(lf.inputIdentity);
  });
});
