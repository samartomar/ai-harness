/**
 * The Node.js release Core requires: 20.6, the first with a synchronous, unflagged
 * `import.meta.resolve`. The framework-plugin loader needs it to prove that a plugin's
 * ESM entry resolves inside the plugin's own install tree. `engines.node` in
 * package.json states the same floor.
 */
export const NODE_RUNTIME_FLOOR_TEXT = "20.6";

const FLOOR_MAJOR = 20;
const FLOOR_MINOR = 6;

/**
 * Whether a `node --version` or `process.versions.node` string meets the floor. The whole
 * trimmed string must be one version (`v` optional, numeric major.minor.patch, optional
 * prerelease suffix); anything else fails closed.
 */
export function nodeVersionMeetsFloor(version: string): boolean {
  const match = /^v?(\d+)\.(\d+)\.\d+(?:-[0-9A-Za-z.-]+)?$/.exec(version.trim());
  if (match === null) return false;
  const major = Number(match[1]);
  const minor = Number(match[2]);
  return major > FLOOR_MAJOR || (major === FLOOR_MAJOR && minor >= FLOOR_MINOR);
}
