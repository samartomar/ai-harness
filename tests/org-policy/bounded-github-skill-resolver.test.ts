import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveConnectedGithubSkillV1 } from "../../src/org-policy/workbench/core/bounded-github-skill-resolver.js";

const commit = "41bbe19d1a1a7eaab5e7bb9050a417e5c6cffc8f";
const tree = "1".repeat(40);

function json(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    headers: { "content-type": "application/json" },
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("connected GitHub Skill resolver", () => {
  it("resolves a bounded canonical Skill through fixed official GitHub API endpoints", async () => {
    const fetchMock = vi.fn();
    fetchMock
      .mockResolvedValueOnce(json({ sha: commit, commit: { tree: { sha: tree } } }))
      .mockResolvedValueOnce(
        json({
          sha: tree,
          truncated: false,
          tree: [
            {
              path: "skills/frontend-design/SKILL.md",
              type: "blob",
              sha: "0".repeat(40),
            },
          ],
        }),
      );
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      resolveConnectedGithubSkillV1({ repository: "acme/design-system", skill: "frontend-design" }),
    ).resolves.toEqual({
      version: "aih-connected-github-skill/v1",
      state: "resolved-not-scanned",
      skill: "frontend-design",
      source: {
        type: "github",
        repository: "acme/design-system",
        commit,
        path: "skills/frontend-design/SKILL.md",
      },
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe(
      "https://api.github.com/repos/acme/design-system/commits/HEAD",
    );
    expect(String(fetchMock.mock.calls[1]?.[0])).toBe(
      `https://api.github.com/repos/acme/design-system/git/trees/${tree}?recursive=1`,
    );
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({
      method: "GET",
      redirect: "error",
      headers: { Accept: "application/vnd.github+json" },
    });
  });

  it("rejects an unsafe repository or noncanonical skill slug without calling the network", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      resolveConnectedGithubSkillV1({
        repository: "example.invalid/anything",
        skill: "../frontend-design",
      }),
    ).rejects.toThrow(/bounded GitHub/i);
    await expect(
      resolveConnectedGithubSkillV1({ repository: "owner/repo/extra", skill: "other-skill" }),
    ).rejects.toThrow(/bounded GitHub/i);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("does not return a pin when the immutable tree omits the declared Skill entry", async () => {
    const fetchMock = vi.fn();
    fetchMock
      .mockResolvedValueOnce(json({ sha: commit, commit: { tree: { sha: tree } } }))
      .mockResolvedValueOnce(json({ sha: tree, truncated: false, tree: [] }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      resolveConnectedGithubSkillV1({ repository: "anthropics/skills", skill: "frontend-design" }),
    ).rejects.toThrow(/requested Skill entry/i);
  });

  it("rejects a truncated GitHub tree instead of treating it as a complete source", async () => {
    const fetchMock = vi.fn();
    fetchMock
      .mockResolvedValueOnce(json({ sha: commit, commit: { tree: { sha: tree } } }))
      .mockResolvedValueOnce(
        json({
          sha: tree,
          truncated: true,
          tree: [
            {
              path: "skills/frontend-design/SKILL.md",
              type: "blob",
              sha: "0".repeat(40),
            },
          ],
        }),
      );
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      resolveConnectedGithubSkillV1({ repository: "anthropics/skills", skill: "frontend-design" }),
    ).rejects.toThrow(/complete immutable repository tree/i);
  });
});
