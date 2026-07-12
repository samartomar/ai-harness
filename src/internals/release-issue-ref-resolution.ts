/**
 * Resolves a commit-subject `(#N)` reference that does not resolve as a pull request
 * (`gh pr view N` fails) to the unique merged pull request that closed issue #N.
 *
 * Uses GitHub's own closing-reference evidence — the same linkage GitHub computes to
 * show "closed via #N" on an issue and to populate an issue's linked-PR sidebar — via
 * `Issue.timelineItems(itemTypes: [CLOSED_EVENT]).closer`. This is authoritative
 * (GitHub-computed from merge/keyword linkage), unlike free-text search over PR
 * bodies, which depends on exact wording and can both over- and under-match.
 *
 * Never guesses: zero or more-than-one candidate merged-PR closer is a resolution
 * failure. Callers turn that into a named preflight finding rather than trusting a
 * fabricated mapping (see release-preflight.ts's evidence-binding contract, #382).
 *
 * Read-only: a single `gh api graphql` read through the shared {@link Runner} seam
 * (see CONTRIBUTING.md's "the one hard rule" — no production code mutates remote
 * state).
 */
import { defaultRunner, type Runner } from "./proc.js";
import type { MergedPr } from "./release-preflight.js";

export const ISSUE_REF_RESOLUTION_EVIDENCE =
  "gh api graphql: repository.issue.timelineItems(CLOSED_EVENT).closer";

const CLOSED_EVENT_QUERY = `
query($owner: String!, $repo: String!, $number: Int!) {
  repository(owner: $owner, name: $repo) {
    issue(number: $number) {
      timelineItems(itemTypes: [CLOSED_EVENT], last: 20) {
        nodes {
          ... on ClosedEvent {
            closer {
              __typename
              ... on PullRequest {
                number
                title
                merged
                labels(first: 20) { nodes { name } }
                milestone { title }
              }
            }
          }
        }
      }
    }
  }
}`;

interface ClosingPrLabelNode {
  name: unknown;
}

interface ClosingPrNode {
  __typename: unknown;
  number?: unknown;
  title?: unknown;
  merged?: unknown;
  labels?: { nodes?: ClosingPrLabelNode[] } | null;
  milestone?: { title?: unknown } | null;
}

interface TimelineGraphqlResponse {
  data?: {
    repository?: {
      issue?: {
        timelineItems?: {
          nodes?: ({ closer?: ClosingPrNode | null } | null)[];
        } | null;
      } | null;
    } | null;
  };
  errors?: { message: string }[];
}

function isMergedPullRequestCloser(
  closer: ClosingPrNode | null | undefined,
): closer is ClosingPrNode & { number: number; title: string; merged: true } {
  return (
    closer !== null &&
    closer !== undefined &&
    closer.__typename === "PullRequest" &&
    closer.merged === true &&
    typeof closer.number === "number" &&
    typeof closer.title === "string"
  );
}

/**
 * Resolves issue #{@link issueNumber} to the unique merged pull request that closed
 * it, returning the same shape `release-preflight.ts` fetches for a direct PR ref.
 * Rejects (never returns a guess) when there is no closer, the closer never merged,
 * the closer is a bare commit rather than a PR, or more than one distinct merged PR
 * closed the issue (e.g. reopened and closed again by a different PR).
 */
export async function resolveIssueRefToMergedPr(
  issueNumber: number,
  run: Runner = defaultRunner,
): Promise<MergedPr> {
  const result = await run([
    "gh",
    "api",
    "graphql",
    "-f",
    `query=${CLOSED_EVENT_QUERY}`,
    "-F",
    "owner={owner}",
    "-F",
    "repo={repo}",
    "-F",
    `number=${issueNumber}`,
  ]);
  if (result.code !== 0 || result.spawnError) {
    throw new Error(
      `closing-PR lookup failed: ${result.stderr.trim() || `gh api graphql exited ${result.code}`}`,
    );
  }

  let parsed: TimelineGraphqlResponse;
  try {
    parsed = JSON.parse(result.stdout) as TimelineGraphqlResponse;
  } catch {
    throw new Error("closing-PR lookup returned invalid JSON");
  }
  if (parsed.errors && parsed.errors.length > 0) {
    throw new Error(`closing-PR lookup failed: ${parsed.errors.map((e) => e.message).join("; ")}`);
  }

  const nodes = parsed.data?.repository?.issue?.timelineItems?.nodes ?? [];
  const mergedClosers = new Map<number, { title: string; labels: string[]; milestone?: string }>();
  for (const node of nodes) {
    const closer = node?.closer;
    if (!isMergedPullRequestCloser(closer)) continue;
    const labelNodes = closer.labels?.nodes ?? [];
    mergedClosers.set(closer.number, {
      title: closer.title,
      labels: labelNodes
        .map((l) => l.name)
        .filter((name): name is string => typeof name === "string"),
      milestone: typeof closer.milestone?.title === "string" ? closer.milestone.title : undefined,
    });
  }

  if (mergedClosers.size === 0) {
    throw new Error("has no unique closing merged PR");
  }
  if (mergedClosers.size > 1) {
    const candidates = [...mergedClosers.keys()]
      .sort((a, b) => a - b)
      .map((n) => `#${n}`)
      .join(", ");
    throw new Error(
      `has ${mergedClosers.size} candidate closing merged PRs (${candidates}) — ambiguous`,
    );
  }

  const [entry] = mergedClosers.entries();
  if (!entry) throw new Error("has no unique closing merged PR");
  const [number, pr] = entry;
  return {
    number,
    title: pr.title,
    semverLabels: pr.labels.filter((l) => l.startsWith("semver:")),
    milestone: pr.milestone,
  };
}
