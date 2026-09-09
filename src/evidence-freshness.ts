/** Public report/qualification freshness; independent of administrator cache retention. */
export const DEFAULT_EVIDENCE_MAX_AGE_DAYS_V1 = 90;
export const DEFAULT_EVIDENCE_MAX_AGE_SECONDS_V1 = DEFAULT_EVIDENCE_MAX_AGE_DAYS_V1 * 86400;

function timestamp(value: string): number {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/u.test(value))
    throw new TypeError("Evidence dates require exact UTC timestamps.");
  const parsed = Date.parse(value);
  const normalized = value.includes(".") ? value : value.replace("Z", ".000Z");
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== normalized)
    throw new TypeError("Evidence date is invalid.");
  return parsed;
}

/** The original date owns the clock. Re-verification cannot extend signed expiry. */
export function evidenceExpiryV1(originalDate: string, signedExpiry?: string): string {
  const original = timestamp(originalDate);
  const ceiling = original + DEFAULT_EVIDENCE_MAX_AGE_SECONDS_V1 * 1000;
  const expiry = signedExpiry === undefined ? ceiling : Math.min(ceiling, timestamp(signedExpiry));
  if (expiry <= original) throw new TypeError("Evidence expiry must follow its original date.");
  return new Date(expiry).toISOString().replace(".000Z", "Z");
}

/** Fail closed on malformed dates; expiry is exclusive. No trust is granted here. */
export function evidenceIsCurrentV1(
  originalDate: string,
  signedExpiry: string | undefined,
  now: number,
): boolean {
  try {
    return (
      Number.isFinite(now) &&
      timestamp(originalDate) <= now &&
      now < timestamp(evidenceExpiryV1(originalDate, signedExpiry))
    );
  } catch {
    return false;
  }
}
