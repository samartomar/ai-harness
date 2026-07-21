import { createHash } from "node:crypto";
import { z } from "zod";
import acceptanceDecisionsJson from "./acceptance-decisions.json";

/**
 * Signed accepted-with-conditions policy decisions (W4 maintainer ruling (e)).
 *
 * A decision NEVER changes a signed vet verdict: blocked evidence stays
 * blocked-by-default in the vendor lock, findings intact. What it records is
 * that a named owner reviewed the EXACT findings on the EXACT pinned
 * components and accepts installing them for ONE exact
 * framework/profile/host/adapter tuple. The effective-eligibility join
 * (`verify.ts` at runtime; `check-baseline-installable.ts` at the release
 * gate) admits a blocked component only when every bound field matches and no
 * unwaivable finding is present; everything else stays held. Evidence
 * surfaces (checks, ledger authorizations, Framework Cards) carry the raw vet
 * outcome AND the acceptance side by side — an admitted component is never
 * reported as "vet passed".
 *
 * No wildcards, by construction: a decision binds exact repository, exact
 * 40-char commit, exact whole-tree digest, exact component ids WITH exact
 * component tree digests, and exact accepted finding codes. Any mismatch —
 * source, digest, component, extra finding code, expired or unsigned record —
 * leaves the component held.
 */

export const ACCEPTANCE_POLICY_VERSION = 1;

/**
 * Codes no acceptance decision may waive, ever: behavioral / supply-chain
 * danger classes where "reviewed the bytes" is not a sufficient basis to run
 * them. Mirrors the trust lane's danger floor at the next tier up.
 */
export const UNWAIVABLE_FINDING_CODES: ReadonlySet<string> = new Set([
  "trust.malicious-code",
  "trust.auto-exec-hook",
  "trust.dependency-confusion",
  "trust.typosquat",
  "trust.source-changed",
]);

const SHA40 = /^[0-9a-f]{40}$/;
const SHA256_HEX = /^[0-9a-f]{64}$/;

const AcceptedComponentSchema = z
  .object({
    evidenceComponentId: z.string().min(1).max(240),
    treeSha256: z.string().regex(SHA256_HEX),
    acceptedFindingCodes: z.array(z.string().min(1).max(120)).min(1).max(64),
  })
  .strict();

const AcceptanceDecisionSchema = z
  .object({
    decisionId: z.string().min(1).max(240),
    decision: z.literal("accepted-with-conditions"),
    owner: z.string().min(1).max(240),
    policyVersion: z.literal(ACCEPTANCE_POLICY_VERSION),
    framework: z.string().min(1).max(120),
    profile: z.string().min(1).max(120),
    host: z.string().min(1).max(120),
    adapter: z.string().min(1).max(120),
    repository: z.string().min(1).max(240),
    commitSha: z.string().regex(SHA40),
    treeDigest: z.string().regex(SHA256_HEX),
    residualRisk: z.string().min(1).max(2000),
    components: z.array(AcceptedComponentSchema).min(1).max(256),
    /** Optional review condition: past this instant the decision stops matching. */
    expiresAt: z.string().datetime().optional(),
    recordSha256: z.string().regex(SHA256_HEX),
  })
  .strict();

const AcceptanceArtifactSchema = z
  .object({
    schemaVersion: z.literal(1),
    decisions: z.array(AcceptanceDecisionSchema).max(64),
  })
  .strict();

export type AcceptanceDecision = z.infer<typeof AcceptanceDecisionSchema>;

function sortKeysDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeysDeep);
  if (value !== null && typeof value === "object") {
    const input = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(input).sort()) out[key] = sortKeysDeep(input[key]);
    return out;
  }
  return value;
}

/**
 * Canonical self-digest: sha256 over the key-sorted JSON of the decision with
 * `recordSha256` emptied. Within this repo's trust model the committed,
 * maintainer-pushed artifact is the signature; the self-digest pins the
 * record's exact content so any edit unsigns it.
 */
export function acceptanceRecordSha256(decision: AcceptanceDecision): string {
  const unsigned = { ...decision, recordSha256: "" };
  return createHash("sha256")
    .update(JSON.stringify(sortKeysDeep(unsigned)), "utf8")
    .digest("hex");
}

let cached: AcceptanceDecision[] | undefined;

/**
 * Shipped decisions, schema-validated AND self-digest-verified. Any invalid,
 * unsigned, or digest-mismatched decision is EXCLUDED — a malformed artifact
 * can only narrow eligibility, never widen it.
 */
export function readAcceptanceDecisions(): readonly AcceptanceDecision[] {
  if (cached !== undefined) return cached;
  const parsed = AcceptanceArtifactSchema.safeParse(acceptanceDecisionsJson);
  cached = parsed.success
    ? parsed.data.decisions.filter(
        (decision) => acceptanceRecordSha256(decision) === decision.recordSha256,
      )
    : [];
  return cached;
}

export interface ComponentAcceptanceCandidate {
  framework: string;
  repository: string;
  commitSha: string;
  componentId: string;
  componentTreeSha256: string;
  findingCodes: readonly string[];
}

export interface ComponentAcceptanceMatch {
  decisionId: string;
  recordSha256: string;
  acceptedFindingCodes: string[];
}

/**
 * Exact-tuple component admission over the EVIDENCE-side fields (the ECC
 * adapter separately asserts profile/host/adapter/treeDigest against the
 * resolved source — two enforcement points, each where its data natively
 * lives). Returns undefined — the component stays held — on any mismatch,
 * any finding code outside the accepted set, any unwaivable code, or an
 * expired decision.
 */
export function matchComponentAcceptance(
  decisions: readonly AcceptanceDecision[],
  candidate: ComponentAcceptanceCandidate,
  now: Date = new Date(),
  tuple?: AcceptanceTuple,
): ComponentAcceptanceMatch | undefined {
  const codes = candidate.findingCodes.length > 0 ? candidate.findingCodes : ["trust.finding"];
  if (codes.some((code) => UNWAIVABLE_FINDING_CODES.has(code))) return undefined;
  for (const decision of decisions) {
    // Defense in depth: an unsigned or content-tampered record never matches,
    // regardless of how the decision list reached this function.
    if (acceptanceRecordSha256(decision) !== decision.recordSha256) continue;
    if (tuple !== undefined) {
      // Profile isolation: a decision for another profile/host/adapter must
      // never authorize this one, even over identical components.
      if (decision.profile !== tuple.profile) continue;
      if (decision.host !== tuple.host) continue;
      if (decision.adapter !== tuple.adapter) continue;
      if (decision.framework !== tuple.framework) continue;
    }
    if (decision.framework !== candidate.framework) continue;
    if (decision.repository !== candidate.repository) continue;
    if (decision.commitSha !== candidate.commitSha) continue;
    if (decision.expiresAt !== undefined && now.getTime() >= Date.parse(decision.expiresAt)) {
      continue;
    }
    const component = decision.components.find(
      (entry) => entry.evidenceComponentId === candidate.componentId,
    );
    if (component === undefined) continue;
    if (component.treeSha256 !== candidate.componentTreeSha256) continue;
    const accepted = new Set(component.acceptedFindingCodes);
    if (!codes.every((code) => accepted.has(code))) continue;
    return {
      decisionId: decision.decisionId,
      recordSha256: decision.recordSha256,
      acceptedFindingCodes: [...component.acceptedFindingCodes],
    };
  }
  return undefined;
}

export interface AcceptanceTuple {
  framework: string;
  profile: string;
  host: string;
  adapter: string;
}

/**
 * Resolve-side binding check for a live install composition: when a decision
 * for the tuple exists, its repository, commit, and whole-tree digest must
 * match the actual resolution EXACTLY before acceptance may enter the
 * evidence pipeline. Returns human-readable mismatch descriptions (empty =
 * bound). A caller that passes acceptance into a pipeline MUST refuse on any
 * mismatch — a tuple-mismatched decision never rides along silently.
 */
export function acceptanceResolutionMismatches(
  decision: AcceptanceDecision,
  resolution: { repository: string; commitSha: string; treeDigest: string },
): string[] {
  const mismatches: string[] = [];
  if (decision.repository !== resolution.repository) {
    mismatches.push(
      `repository ${JSON.stringify(resolution.repository)} != ${JSON.stringify(decision.repository)}`,
    );
  }
  if (decision.commitSha !== resolution.commitSha) {
    mismatches.push(`commitSha ${resolution.commitSha} != ${decision.commitSha}`);
  }
  if (decision.treeDigest !== resolution.treeDigest) {
    mismatches.push(`treeDigest ${resolution.treeDigest} != ${decision.treeDigest}`);
  }
  return mismatches;
}

/** The decision for one framework/profile/host/adapter tuple, if shipped. */
export function findAcceptanceDecision(
  decisions: readonly AcceptanceDecision[],
  tuple: AcceptanceTuple,
): AcceptanceDecision | undefined {
  return decisions.find(
    (decision) =>
      decision.framework === tuple.framework &&
      decision.profile === tuple.profile &&
      decision.host === tuple.host &&
      decision.adapter === tuple.adapter,
  );
}
