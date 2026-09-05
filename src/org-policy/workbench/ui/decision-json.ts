export type SchemaError = (schema: unknown, value: unknown, path: string) => string[];

type DecisionRecord = Record<string, unknown>;

function compareText(left: string, right: string): number {
  return left === right ? 0 : left < right ? -1 : 1;
}

export function stableDecisionJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableDecisionJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value)
      .sort(([left], [right]) => compareText(left, right))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableDecisionJson(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

const timestamp =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,3})?(Z|[+-](\d{2}):(\d{2}))$/;

function daysInMonth(year: number, month: number): number {
  if (month === 2) return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0) ? 29 : 28;
  return month === 4 || month === 6 || month === 9 || month === 11 ? 30 : 31;
}

export function isDecisionTimestamp(value: unknown): value is string {
  const match = typeof value === "string" ? timestamp.exec(value) : null;
  if (match === null) return false;
  const year = Number(match[1]!);
  const month = Number(match[2]!);
  const day = Number(match[3]!);
  const hour = Number(match[4]!);
  const minute = Number(match[5]!);
  const second = Number(match[6]!);
  const offsetHour = match[8] === undefined ? 0 : Number(match[8]);
  const offsetMinute = match[9] === undefined ? 0 : Number(match[9]);
  return (
    month >= 1 &&
    month <= 12 &&
    day >= 1 &&
    day <= daysInMonth(year, month) &&
    hour <= 23 &&
    minute <= 59 &&
    second <= 59 &&
    offsetHour <= 23 &&
    offsetMinute <= 59 &&
    Number.isFinite(Date.parse(value as string))
  );
}

function sortedStrings(value: unknown): value is string[] {
  return (
    Array.isArray(value) &&
    value.every(
      (item, index) =>
        typeof item === "string" && (index === 0 || compareText(value[index - 1]!, item) < 0),
    )
  );
}

function validText(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 500 &&
    value === value.trim() &&
    !/\p{C}/u.test(value)
  );
}
function validId(value: unknown): value is string {
  return typeof value === "string" && /^[a-z][a-z0-9-]{0,63}$/.test(value);
}
function validDigest(value: unknown): value is string {
  return typeof value === "string" && /^sha256:[0-9a-f]{64}$/.test(value);
}
function validSet(
  value: unknown,
  min: number,
  max: number,
  check: (item: unknown) => boolean,
): value is string[] {
  return (
    Array.isArray(value) &&
    value.length >= min &&
    value.length <= max &&
    value.every(check) &&
    sortedStrings(value)
  );
}

/** Validate the locally displayed decision; it never grants policy authority. */
export function decisionProblems(
  value: unknown,
  schema: unknown,
  schemaErrors: SchemaError,
): string[] {
  const problems = schemaErrors(schema, value, "decision");
  if (value === null || typeof value !== "object" || Array.isArray(value))
    return problems.length > 0 ? problems : ["decision: must be an object"];
  const decision = value as DecisionRecord;
  const issuedAt = decision.issuedAt;
  const notBeforeAt = decision.notBefore;
  const expiresAt = decision.expiresAt;
  if (
    !isDecisionTimestamp(issuedAt) ||
    !isDecisionTimestamp(notBeforeAt) ||
    !isDecisionTimestamp(expiresAt)
  )
    problems.push("decision: timestamps must be calendar-valid offset-qualified values");
  else {
    const issued = Date.parse(issuedAt);
    const notBefore = Date.parse(notBeforeAt);
    const expires = Date.parse(expiresAt);
    if (notBefore < issued || expires <= notBefore || expires - issued > 7776000000)
      problems.push("decision: validity window is invalid");
  }
  if (
    ![decision.candidate, decision.kind, decision.issuer, decision.actor].every(validId) ||
    !/^decision-[a-z0-9-]{0,55}$/.test(String(decision.id)) ||
    ![decision.sourceDigest, decision.evidenceDigest, decision.reviewedControlDigest].every(
      validDigest,
    ) ||
    ![decision.policyVersion, decision.reason].every(validText)
  )
    problems.push("decision: identity or text is invalid");
  if (
    !validSet(decision.targets, 1, 64, validId) ||
    !validSet(decision.effects, 1, 64, validId) ||
    !validSet(decision.acceptedFindings, 0, 64, validId) ||
    !validSet(decision.acceptedGaps, 0, 64, validId) ||
    !validSet(decision.conditions, 0, 32, validText)
  )
    problems.push("decision: bounded collections must be ordinal-sorted and unique");
  if (decision.disposition === "accepted-with-conditions") {
    const findings = decision.acceptedFindings as string[];
    const gaps = decision.acceptedGaps as string[];
    if (
      !isDecisionTimestamp(decision.reviewBy) ||
      !validSet(decision.conditions, 1, 32, validText) ||
      findings.length + gaps.length === 0 ||
      findings.some((item) => gaps.includes(item)) ||
      Date.parse(decision.reviewBy) < Date.parse(decision.notBefore as string) ||
      Date.parse(decision.reviewBy) > Date.parse(decision.expiresAt as string)
    )
      problems.push("decision: accepted-with-conditions semantics are invalid");
  }
  return [...new Set(problems)];
}
