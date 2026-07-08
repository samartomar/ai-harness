import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ExecAction, PlanContext } from "../../src/internals/plan.js";
import { fakeRunner, type Runner } from "../../src/internals/proc.js";
import { makeHostAdapter } from "../../src/platform/detect.js";
import { workspaceHydrateCommand } from "../../src/workspace/hydrate.js";

let parent: string;

beforeEach(() => {
  parent = mkdtempSync(join(tmpdir(), "aih-hydrate-"));
});

afterEach(() => {
  rmSync(parent, { recursive: true, force: true });
});

function ctx(run: Runner = fakeRunner(() => undefined)): PlanContext {
  return {
    root: parent,
    contextDir: "ai-coding",
    apply: false,
    verify: false,
    json: false,
    run,
    host: makeHostAdapter({ platform: "linux", run, env: {} }),
    env: {},
    options: {},
  };
}

function writeManifest(repos: unknown[]): void {
  writeFileSync(
    join(parent, ".aih-workspace.json"),
    JSON.stringify({ contextDir: "ai-coding", repos }, null, 2),
  );
}

function writeRawManifest(manifest: unknown): void {
  writeFileSync(join(parent, ".aih-workspace.json"), JSON.stringify(manifest, null, 2));
}

function childRepo(path: string): void {
  mkdirSync(join(parent, path, ".git"), { recursive: true });
}

function execs(actions: Awaited<ReturnType<typeof workspaceHydrateCommand.plan>>["actions"]) {
  return actions.filter((action): action is ExecAction => action.kind === "exec");
}

describe("workspace hydrate", () => {
  it("plans clone and checkout actions for missing manifest children with recorded remote and ref", async () => {
    writeManifest([
      {
        id: "ui",
        path: "ui",
        remote: "https://github.com/acme/ui.git",
        ref: "release/v1.5.0",
      },
    ]);

    const planned = await workspaceHydrateCommand.plan(ctx());
    const plannedExecs = execs(planned.actions);

    expect(plannedExecs.map((action) => action.argv)).toEqual([
      ["git", "clone", "--branch", "release/v1.5.0", "--", "https://github.com/acme/ui.git", "ui"],
    ]);
    expect(plannedExecs[0]?.cwd).toBe(parent);
    for (const action of plannedExecs) {
      expect(action.argv).not.toContain("push");
      expect(action.argv).not.toContain("remote");
      expect(action.argv).not.toContain("set-url");
    }
  });

  it("clones the default branch when a missing manifest child has no recorded ref", async () => {
    writeManifest([{ id: "ui", path: "ui", remote: "https://github.com/acme/ui.git" }]);

    const planned = await workspaceHydrateCommand.plan(ctx());

    expect(execs(planned.actions).map((action) => action.argv)).toEqual([
      ["git", "clone", "--", "https://github.com/acme/ui.git", "ui"],
    ]);
  });

  it("uses the committed workspace lock remote and sha when the manifest lacks source metadata", async () => {
    mkdirSync(join(parent, "ai-coding"), { recursive: true });
    writeManifest(["ui"]);
    writeFileSync(
      join(parent, "ai-coding", "workspace-lock.json"),
      JSON.stringify(
        {
          schemaVersion: 1,
          createdAt: "2026-07-04T00:00:00.000Z",
          repos: [
            {
              id: "ui",
              path: "ui",
              remote: "https://github.com/acme/ui.git",
              branch: "main",
              sha: "0123456789abcdef0123456789abcdef01234567",
              dirty: false,
              git: true,
            },
          ],
        },
        null,
        2,
      ),
    );

    const planned = await workspaceHydrateCommand.plan(ctx());
    const plannedExecs = execs(planned.actions);

    expect(plannedExecs.map((action) => action.argv)).toEqual([
      ["git", "clone", "--no-checkout", "--", "https://github.com/acme/ui.git", "ui"],
      [
        "git",
        "-C",
        join(parent, "ui"),
        "checkout",
        "--detach",
        "0123456789abcdef0123456789abcdef01234567",
      ],
    ]);
  });

  it("prefers committed workspace lock sha over a mutable manifest ref", async () => {
    mkdirSync(join(parent, "ai-coding"), { recursive: true });
    writeManifest([
      {
        id: "ui",
        path: "ui",
        remote: "https://github.com/acme/ui.git",
        ref: "main",
      },
    ]);
    writeFileSync(
      join(parent, "ai-coding", "workspace-lock.json"),
      JSON.stringify({
        schemaVersion: 1,
        createdAt: "2026-07-04T00:00:00.000Z",
        repos: [
          {
            id: "ui",
            path: "ui",
            remote: "https://github.com/acme/ui.git",
            sha: "fedcba9876543210fedcba9876543210fedcba98",
            dirty: false,
            git: true,
          },
        ],
      }),
    );

    const planned = await workspaceHydrateCommand.plan(ctx());

    expect(execs(planned.actions).map((action) => action.argv)).toEqual([
      ["git", "clone", "--no-checkout", "--", "https://github.com/acme/ui.git", "ui"],
      [
        "git",
        "-C",
        join(parent, "ui"),
        "checkout",
        "--detach",
        "fedcba9876543210fedcba9876543210fedcba98",
      ],
    ]);
  });

  it("rejects hostile refs from a committed workspace lock", async () => {
    mkdirSync(join(parent, "ai-coding"), { recursive: true });
    writeManifest(["ui"]);
    writeFileSync(
      join(parent, "ai-coding", "workspace-lock.json"),
      JSON.stringify({
        schemaVersion: 1,
        createdAt: "2026-07-04T00:00:00.000Z",
        repos: [
          {
            id: "ui",
            path: "ui",
            remote: "https://github.com/acme/ui.git",
            sha: "-c",
            dirty: false,
            git: true,
          },
        ],
      }),
    );

    await expect(workspaceHydrateCommand.plan(ctx())).rejects.toThrow(/workspace repo ref/);
  });

  it("rejects branch-like values in the workspace lock sha field", async () => {
    mkdirSync(join(parent, "ai-coding"), { recursive: true });
    writeManifest(["ui"]);
    writeFileSync(
      join(parent, "ai-coding", "workspace-lock.json"),
      JSON.stringify({
        schemaVersion: 1,
        createdAt: "2026-07-04T00:00:00.000Z",
        repos: [
          {
            id: "ui",
            path: "ui",
            remote: "https://github.com/acme/ui.git",
            sha: "main",
            dirty: false,
            git: true,
          },
        ],
      }),
    );

    await expect(workspaceHydrateCommand.plan(ctx())).rejects.toThrow(/snapshot sha/);
  });

  it("rejects unsafe labels in the committed workspace lock", async () => {
    mkdirSync(join(parent, "ai-coding"), { recursive: true });
    writeManifest(["ui"]);
    writeFileSync(
      join(parent, "ai-coding", "workspace-lock.json"),
      JSON.stringify({
        schemaVersion: 1,
        createdAt: "2026-07-04T00:00:00.000Z",
        label: "<img src=x onerror=alert(1)>",
        repos: [
          {
            id: "ui",
            path: "ui",
            remote: "https://github.com/acme/ui.git",
            sha: "abcdef0123456789abcdef0123456789abcdef01",
            dirty: false,
            git: true,
          },
        ],
      }),
    );

    await expect(workspaceHydrateCommand.plan(ctx())).rejects.toThrow(
      /workspace-lock\.json snapshot label must be safe to print/,
    );
  });

  it("does not use gitignored local workspace snapshots as hydrate source metadata", async () => {
    mkdirSync(join(parent, ".aih", "workspace-snapshots"), { recursive: true });
    writeManifest(["ui"]);
    writeFileSync(
      join(parent, ".aih", "workspace-snapshots", "20260704T000000Z-local.json"),
      JSON.stringify({
        schemaVersion: 1,
        createdAt: "2026-07-04T00:00:00.000Z",
        repos: [
          {
            id: "ui",
            path: "ui",
            remote: "https://github.com/acme/ui.git",
            sha: "abcdef0123456789abcdef0123456789abcdef01",
            dirty: false,
            git: true,
          },
        ],
      }),
    );

    const planned = await workspaceHydrateCommand.plan(ctx());

    expect(execs(planned.actions)).toEqual([]);
    expect(planned.actions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "doc",
          describe: "workspace hydrate skipped",
          text: expect.stringContaining("ui: no recorded remote"),
        }),
      ]),
    );
  });

  it("emits a skip note instead of a clone when a missing child has no recorded remote", async () => {
    writeManifest(["ui"]);

    const planned = await workspaceHydrateCommand.plan(ctx());

    expect(execs(planned.actions)).toEqual([]);
    expect(planned.actions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "doc",
          describe: "workspace hydrate skipped",
          text: expect.stringContaining("ui: no recorded remote"),
        }),
      ]),
    );
  });

  it("rejects workspace locks under .aih runtime state", async () => {
    mkdirSync(join(parent, ".aih"), { recursive: true });
    writeRawManifest({ contextDir: ".aih", repos: ["ui"] });
    writeFileSync(
      join(parent, ".aih", "workspace-lock.json"),
      JSON.stringify({
        schemaVersion: 1,
        createdAt: "2026-07-04T00:00:00.000Z",
        repos: [
          {
            id: "ui",
            path: "ui",
            remote: "https://github.com/acme/ui.git",
            sha: "abcdef0123456789abcdef0123456789abcdef01",
            dirty: false,
            git: true,
          },
        ],
      }),
    );

    await expect(workspaceHydrateCommand.plan(ctx())).rejects.toThrow(/committed context dir/);
  });

  it("rejects missing clone targets below linked ancestors", async () => {
    const external = mkdtempSync(join(tmpdir(), "aih-hydrate-external-"));
    try {
      symlinkSync(external, join(parent, "linked"), "junction");
      writeManifest([
        {
          id: "api",
          path: "linked/api",
          remote: "https://github.com/acme/api.git",
        },
      ]);

      await expect(workspaceHydrateCommand.plan(ctx())).rejects.toThrow(/ancestor/);
    } finally {
      rmSync(external, { recursive: true, force: true });
    }
  });

  it("checks out a present clean child whose recorded ref differs from the current checkout", async () => {
    childRepo("ui");
    writeManifest([
      {
        id: "ui",
        path: "ui",
        remote: "https://github.com/acme/ui.git",
        ref: "release/v1.5.0",
      },
    ]);
    const run = fakeRunner((argv) => {
      const tail = argv.slice(3).join(" ");
      if (tail === "rev-parse --is-inside-work-tree") return { stdout: "true\n" };
      if (tail === "rev-parse --abbrev-ref HEAD") return { stdout: "main\n" };
      if (tail === "rev-parse HEAD")
        return { stdout: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\n" };
      if (tail === "status --porcelain") return { stdout: "" };
      return { code: 1 };
    });

    const planned = await workspaceHydrateCommand.plan(ctx(run));

    expect(execs(planned.actions).map((action) => action.argv)).toEqual([
      ["git", "-C", join(parent, "ui"), "switch", "release/v1.5.0"],
    ]);
  });

  it("does not treat a named ref as satisfied by a matching SHA prefix", async () => {
    childRepo("ui");
    writeManifest([{ id: "ui", path: "ui", remote: "https://github.com/acme/ui.git", ref: "a" }]);
    const run = fakeRunner((argv) => {
      const tail = argv.slice(3).join(" ");
      if (tail === "rev-parse --is-inside-work-tree") return { stdout: "true\n" };
      if (tail === "rev-parse --abbrev-ref HEAD") return { stdout: "main\n" };
      if (tail === "rev-parse HEAD")
        return { stdout: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\n" };
      if (tail === "status --porcelain") return { stdout: "" };
      return { code: 1 };
    });

    const planned = await workspaceHydrateCommand.plan(ctx(run));

    expect(execs(planned.actions).map((action) => action.argv)).toEqual([
      ["git", "-C", join(parent, "ui"), "switch", "a"],
    ]);
  });

  it("does nothing for a present child already at the recorded branch", async () => {
    childRepo("ui");
    writeManifest([
      {
        id: "ui",
        path: "ui",
        remote: "https://github.com/acme/ui.git",
        ref: "main",
      },
    ]);
    const run = fakeRunner((argv) => {
      const tail = argv.slice(3).join(" ");
      if (tail === "rev-parse --is-inside-work-tree") return { stdout: "true\n" };
      if (tail === "rev-parse --abbrev-ref HEAD") return { stdout: "main\n" };
      if (tail === "rev-parse HEAD")
        return { stdout: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\n" };
      if (tail === "status --porcelain") return { stdout: "" };
      return { code: 1 };
    });

    const planned = await workspaceHydrateCommand.plan(ctx(run));

    expect(execs(planned.actions)).toEqual([]);
  });

  it("does nothing for a present child already at the exact snapshot SHA", async () => {
    mkdirSync(join(parent, "ai-coding"), { recursive: true });
    childRepo("ui");
    writeManifest(["ui"]);
    writeFileSync(
      join(parent, "ai-coding", "workspace-lock.json"),
      JSON.stringify({
        schemaVersion: 1,
        createdAt: "2026-07-04T00:00:00.000Z",
        repos: [
          {
            id: "ui",
            path: "ui",
            remote: "https://github.com/acme/ui.git",
            sha: "abcdef0123456789abcdef0123456789abcdef01",
            dirty: false,
            git: true,
          },
        ],
      }),
    );
    const run = fakeRunner((argv) => {
      const tail = argv.slice(3).join(" ");
      if (tail === "rev-parse --is-inside-work-tree") return { stdout: "true\n" };
      if (tail === "rev-parse --abbrev-ref HEAD") return { stdout: "main\n" };
      if (tail === "rev-parse HEAD")
        return { stdout: "abcdef0123456789abcdef0123456789abcdef01\n" };
      return { code: 1 };
    });

    const planned = await workspaceHydrateCommand.plan(ctx(run));

    expect(execs(planned.actions)).toEqual([]);
  });

  it("skips checkout for a present child whose cleanliness cannot be proven", async () => {
    childRepo("ui");
    writeManifest([
      {
        id: "ui",
        path: "ui",
        remote: "https://github.com/acme/ui.git",
        ref: "release/v1.5.0",
      },
    ]);
    const run = fakeRunner((argv) => {
      const tail = argv.slice(3).join(" ");
      if (tail === "rev-parse --is-inside-work-tree") return { stdout: "true\n" };
      if (tail === "rev-parse --abbrev-ref HEAD") return { stdout: "main\n" };
      if (tail === "rev-parse HEAD")
        return { stdout: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\n" };
      if (tail === "status --porcelain") return { code: 1 };
      return { code: 1 };
    });

    const planned = await workspaceHydrateCommand.plan(ctx(run));

    expect(execs(planned.actions)).toEqual([]);
    expect(planned.actions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "doc",
          describe: "workspace hydrate skipped",
          text: expect.stringContaining("could not verify a clean working tree"),
        }),
      ]),
    );
  });
});
