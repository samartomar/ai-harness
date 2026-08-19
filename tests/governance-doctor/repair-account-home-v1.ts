/**
 * The OS-account home every Repair claim suite is pinned to.
 *
 * The durable claim store resolves its own home from the *account*, not from the
 * environment, and it exposes no caller input and no test setter for that
 * location -- which is exactly the property that keeps replay state from being
 * something a caller can choose. So the only seam a suite may use is the platform
 * module itself: `node:os` is replaced at the module boundary, and the
 * replacement reports this fixture directory as the account's home.
 *
 * This module deliberately imports nothing. A `vi.mock` factory runs while the
 * mocked module is being resolved, so anything it pulls in is loaded inside that
 * resolution; keeping this leaf free of repository imports is what stops that
 * from becoming a cycle.
 */
let accountHome: string | null = null;

/** Pins the account home, or releases it. Every suite must pin before it acquires. */
export function setRepairFixtureAccountHomeV1(path: string | null): void {
  accountHome = path;
}

/**
 * The pinned account home, or a hard failure. A suite that never pinned one would
 * otherwise resolve the operator's real account home and write durable claim
 * records into it, so the unpinned case is a thrown error rather than a fallback.
 */
export function repairFixtureAccountHomeV1(): string {
  if (accountHome === null)
    throw new Error("repair fixture account home is not pinned: refusing to resolve the real home");
  return accountHome;
}

/**
 * The `node:os` replacement every Repair claim suite installs. Only `userInfo` is
 * restated; `homedir()` is left exactly as the platform implements it, because
 * the store must not be reading it at all.
 */
export function repairFixtureOsModuleV1(
  actual: typeof import("node:os"),
): typeof import("node:os") {
  const userInfo = ((options?: unknown) => ({
    ...(actual.userInfo as unknown as (o?: unknown) => Record<string, unknown>)(options),
    homedir: repairFixtureAccountHomeV1(),
  })) as typeof actual.userInfo;
  const interposed = { ...actual, userInfo };
  return { ...interposed, default: interposed } as unknown as typeof import("node:os");
}
