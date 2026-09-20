import { parseNativeStrictJsonObjectV1 } from "../../../contract/native-strict-json-object-v1.js";
import { checkProjectPolicyNarrowsV1 } from "../../project-policy.js";
import type { OrgPolicy } from "../../schema.js";
import {
  jsonFileText,
  MAX_IMPORT_BYTES,
  PROJECT_POLICY_FILENAME,
} from "../ui/shell/download-format.js";
import {
  buildProjectPolicyV1,
  type UserDoorSaveInputV1,
  type UserDoorSaveResultV1,
  type UserDoorViewModelV1,
  userDoorViewModelV1,
} from "../ui/user-door-model.js";
import { type EngineFile, errorMessage, record, utf8ByteLength } from "./shared.js";

/**
 * The user half of the engine entry (Policy Workbench UI delivery, "Preview
 * slice"): the user page's view model, the project policy it builds, and the
 * narrowing check against the org policy the host bound or imported. Pure: no
 * DOM, no `window`, no Node built-ins. Nothing thrown crosses this entry.
 */

/** The current org policy a saved cut is checked against. */
export interface UserCheckAgainstV1 {
  /** The org policy as the host reads it now; defaults to the bound policy. */
  readonly policy?: unknown;
  /** The host's digest of that policy's bytes; defaults to the bound digest. */
  readonly sha256?: string;
}

export type UserCheckResultV1 =
  | { readonly ok: true; readonly file: EngineFile }
  | { readonly ok: false; readonly errors: readonly string[] };

export interface UserEngine {
  view(): UserDoorViewModelV1;
  build(input: UserDoorSaveInputV1): UserDoorSaveResultV1;
  /**
   * `build` plus the narrowing check against the bound policy and its
   * host-supplied digest. `against` overrides both when the host has re-read
   * the org policy since the cut; a mismatch fails and produces no file.
   */
  check(input: UserDoorSaveInputV1, against?: UserCheckAgainstV1): UserCheckResultV1;
}

const UNAVAILABLE_DIGEST = "The policy digest is unavailable. Saving is disabled.";
const UNAVAILABLE_POLICY = "The org policy is unavailable. Saving is disabled.";

function orgPolicyOrUndefined(value: unknown): OrgPolicy | undefined {
  const policy = record(value);
  if (policy === undefined) return undefined;
  if (policy.schemaVersion !== 2 && policy.schemaVersion !== 3) return undefined;
  return policy as unknown as OrgPolicy;
}

export function createUserEngine(modelValue: unknown): UserEngine {
  const model = record(modelValue);
  const view = (): UserDoorViewModelV1 => userDoorViewModelV1(modelValue);
  const build = (input: UserDoorSaveInputV1): UserDoorSaveResultV1 => {
    try {
      if (record(input) === undefined || !(input?.choices instanceof Map))
        return { ok: false, errors: ["A project selection input is required."] };
      return buildProjectPolicyV1(view(), input);
    } catch (error) {
      return { ok: false, errors: [errorMessage(error, "The project policy was rejected.")] };
    }
  };
  return {
    view,
    build,
    check(input, against) {
      try {
        const built = build(input);
        if (!built.ok) return { ok: false, errors: built.errors };
        const current = view();
        const digest = against?.sha256 ?? current.source?.sha256;
        if (digest === undefined) return { ok: false, errors: [UNAVAILABLE_DIGEST] };
        const orgPolicy = orgPolicyOrUndefined(
          against?.policy === undefined ? model?.initialPolicy : against.policy,
        );
        if (orgPolicy === undefined) return { ok: false, errors: [UNAVAILABLE_POLICY] };
        const narrows = checkProjectPolicyNarrowsV1(built.policy, orgPolicy, digest);
        if (!narrows.ok) return { ok: false, errors: narrows.reasons };
        return {
          ok: true,
          file: { name: PROJECT_POLICY_FILENAME, text: jsonFileText(built.policy) },
        };
      } catch (error) {
        return { ok: false, errors: [errorMessage(error, "The project policy check failed.")] };
      }
    },
  };
}

/**
 * The web host's import: `text` is the file's text and `sha256` the host's
 * digest of the ORIGINAL bytes (64 hex), never computed here. Hostile text
 * stays raw: the page renders it as text and files store it as it came.
 */
export function userModelFromImportedPolicy(input: {
  text: string;
  sha256: string;
  fileName: string;
  bundle?: unknown;
}): unknown {
  const given = record(input) ?? {};
  const text = typeof given.text === "string" ? given.text : "";
  const sha256 = typeof given.sha256 === "string" ? given.sha256 : "";
  const fileName = typeof given.fileName === "string" ? given.fileName : "";
  const source: Record<string, unknown> = { kind: "import", path: fileName, sha256 };
  let initialPolicy: unknown;
  if (typeof given.text !== "string") {
    source.valid = false;
    source.error = "file import JSON root must be an object";
  } else if (utf8ByteLength(text) > MAX_IMPORT_BYTES) {
    source.valid = false;
    source.error = "file exceeds the 1 MiB limit";
  } else {
    try {
      initialPolicy = parseNativeStrictJsonObjectV1(text, "file import");
      source.valid = true;
    } catch (error) {
      source.valid = false;
      source.error = errorMessage(error, "valid policy JSON required");
    }
  }
  return {
    door: "user",
    policySource: source,
    initialPolicy,
    workbenchBundle: given.bundle,
  };
}
