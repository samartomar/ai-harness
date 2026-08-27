export const PACKAGE_NAME = "@aihq/core";
export const REPO = "samartomar/ai-harness";
export const RELEASE_TAG_PREFIX = "v-core-";
export const VERSION = "0.2.0";

export function releaseTag(version: string): string {
  return `${RELEASE_TAG_PREFIX}${version}`;
}
