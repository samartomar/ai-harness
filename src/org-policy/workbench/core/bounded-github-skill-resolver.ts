const GITHUB_API_ORIGIN = "https://api.github.com";
const REQUEST_TIMEOUT_MS = 8_000;
const COMMIT_RESPONSE_MAX_BYTES = 64 * 1024;
const TREE_RESPONSE_MAX_BYTES = 4 * 1024 * 1024;
const GIT_OBJECT_SHA = /^[a-f0-9]{40}$/;
const REPOSITORY_SEGMENT = /^[A-Za-z0-9](?:[A-Za-z0-9_.-]{0,99})?$/;
const SKILL_SLUG = /^[a-z0-9](?:[a-z0-9._-]{0,127})?$/;

export interface ResolvedGithubSkillSourceV1 {
  readonly type: "github";
  readonly repository: string;
  readonly commit: string;
  readonly path: string;
}

/** A resolved pin remains a candidate until the separate trust scan observes it. */
export interface ResolvedGithubSkillV1 {
  readonly version: "aih-connected-github-skill/v1";
  readonly state: "resolved-not-scanned";
  readonly skill: string;
  readonly source: ResolvedGithubSkillSourceV1;
}

function fail(message: string): never {
  throw new Error(message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function responseLength(response: Response, maximum: number): void {
  const raw = response.headers.get("content-length");
  if (raw === null) return;
  if (!/^[0-9]+$/.test(raw) || Number(raw) > maximum) {
    fail("GitHub response exceeds the connected Workbench limit");
  }
}

async function boundedJson(response: Response, maximum: number): Promise<unknown> {
  if (!response.ok) fail("GitHub could not resolve this requested Skill source");
  responseLength(response, maximum);
  if (response.body === null) fail("GitHub returned an empty response");

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      size += next.value.byteLength;
      if (size > maximum) {
        await reader.cancel();
        fail("GitHub response exceeds the connected Workbench limit");
      }
      chunks.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }

  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(
      (() => {
        const bytes = new Uint8Array(size);
        let offset = 0;
        for (const chunk of chunks) {
          bytes.set(chunk, offset);
          offset += chunk.byteLength;
        }
        return bytes;
      })(),
    );
  } catch {
    fail("GitHub returned unreadable JSON");
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    fail("GitHub returned invalid JSON");
  }
}

async function githubJson(path: string, maximum: number): Promise<unknown> {
  const response = await fetch(new URL(path, GITHUB_API_ORIGIN), {
    method: "GET",
    headers: {
      Accept: "application/vnd.github+json",
      "User-Agent": "AIH-Policy-Workbench",
    },
    redirect: "error",
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  return boundedJson(response, maximum);
}

function commitIdentity(value: unknown): { readonly commit: string; readonly tree: string } {
  if (!isRecord(value)) fail("GitHub returned an invalid commit response");
  if (typeof value.sha !== "string" || !GIT_OBJECT_SHA.test(value.sha)) {
    fail("GitHub did not return an immutable commit");
  }
  if (
    !isRecord(value.commit) ||
    !isRecord(value.commit.tree) ||
    typeof value.commit.tree.sha !== "string" ||
    !GIT_OBJECT_SHA.test(value.commit.tree.sha)
  ) {
    fail("GitHub did not return the immutable commit tree");
  }
  return { commit: value.sha, tree: value.commit.tree.sha };
}

function hasSkillEntry(value: unknown, treeSha: string, skillPath: string): boolean {
  if (!isRecord(value)) fail("GitHub returned an invalid repository tree");
  if (value.sha !== treeSha || value.truncated !== false || !Array.isArray(value.tree)) {
    fail("GitHub did not return a complete immutable repository tree");
  }

  let entries = 0;
  for (const entry of value.tree) {
    entries += 1;
    if (entries > 100_000 || !isRecord(entry)) {
      fail("GitHub returned an invalid repository tree");
    }
    if (
      entry.path === skillPath &&
      entry.type === "blob" &&
      typeof entry.sha === "string" &&
      GIT_OBJECT_SHA.test(entry.sha)
    ) {
      return true;
    }
  }
  return false;
}

function sourceIdentity(input: { readonly repository: string; readonly skill: string }): {
  readonly repository: string;
  readonly skill: string;
  readonly path: string;
} {
  const parts = input.repository.split("/");
  if (
    parts.length !== 2 ||
    !REPOSITORY_SEGMENT.test(parts[0] ?? "") ||
    !REPOSITORY_SEGMENT.test(parts[1] ?? "") ||
    !SKILL_SLUG.test(input.skill)
  ) {
    fail("A connected Skill needs a bounded GitHub owner/repository and canonical skill slug");
  }
  return {
    repository: input.repository,
    skill: input.skill,
    path: `skills/${input.skill}/SKILL.md`,
  };
}

function githubRepositoryPath(repository: string): string {
  const [owner, name] = repository.split("/");
  return `/repos/${encodeURIComponent(owner ?? "")}/${encodeURIComponent(name ?? "")}`;
}

/**
 * Resolve one canonical `skills/<slug>/SKILL.md` declaration through fixed
 * official GitHub API endpoints. It never downloads, executes, scans, or
 * approves the Skill content.
 */
export async function resolveConnectedGithubSkillV1(input: {
  readonly repository: string;
  readonly skill: string;
}): Promise<ResolvedGithubSkillV1> {
  const source = sourceIdentity(input);
  const repositoryPath = githubRepositoryPath(source.repository);

  const identity = commitIdentity(
    await githubJson(`${repositoryPath}/commits/HEAD`, COMMIT_RESPONSE_MAX_BYTES),
  );
  const tree = await githubJson(
    `${repositoryPath}/git/trees/${identity.tree}?recursive=1`,
    TREE_RESPONSE_MAX_BYTES,
  );
  if (!hasSkillEntry(tree, identity.tree, source.path)) {
    fail("GitHub did not return the requested Skill entry at the immutable commit");
  }

  return {
    version: "aih-connected-github-skill/v1",
    state: "resolved-not-scanned",
    skill: source.skill,
    source: {
      type: "github",
      repository: source.repository,
      commit: identity.commit,
      path: source.path,
    },
  };
}
