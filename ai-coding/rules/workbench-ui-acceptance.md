# Policy Workbench UI acceptance

> Load when: implementing, testing, or reviewing any outcome of the Policy
> Workbench UI delivery. Read `rules/workbench-ui-delivery.md` first.

What the component UI must reproduce and what it must refuse. Every entry
names the source or the existing test that pins it. Paths are relative to the
repo root. `wb-tests/` stands for `tests/org-policy/workbench/`.

## 1. Output files

Names and serialization are owned by
`src/org-policy/workbench/ui/shell/download-format.ts`.

| File | Content | Bytes | First slice |
|---|---|---|---|
| `aih-org-policy.json` | Organization policy (output A) | `JSON.stringify(policy, null, 2)` plus a newline | yes |
| `aih-project-policy.json` | Project selection, bound to A by `cutFrom` (output B) | two-space JSON plus a newline | yes |
| `aih-governance-decision.json` | Imported decision, inspection only | stable decision JSON plus a newline | with its editor |
| `aih-policy-bundle.json` | Protected policy bundle | two-space JSON plus a newline | with its editor |
| `aih-artifact-intake.json` | Artifact intake | two-space JSON plus a newline | with its editor |

- A custom name for output A must match `POLICY_FILENAME_PATTERN`. An unsafe
  name is refused and nothing is downloaded.
- Output A must parse with the canonical `OrgPolicySchema` in Node.
- Output B must parse with `ProjectPolicyV1Schema` and pass
  `checkProjectPolicyNarrowsV1` against A and the SHA-256 of A's original bytes.

## 2. Rules that decide the bytes

1. An untouched policy, and a policy that was only imported and migrated, is
   serialized as it is. It is not compiled. The three organization-policy
   goldens are schema version 2 for this reason.
2. A selection-driven change compiles through `projectWorkbenchPolicy` in
   `src/org-policy/workbench/compile-policy.ts`. That sets schema version 3,
   `minimumCoreVersion`, `authoringSelections`, and `authoringSources` when
   sources exist. A compiled policy over `WORKBENCH_MAX_POLICY_BYTES` is
   rejected and the input policy is kept.
3. Key insertion order decides the bytes. Build and migrate objects in the
   engine's order. Never re-sort.
4. Fields the UI does not edit are preserved structurally through an import.
5. `cutFrom.sha256` is the digest of the bound or imported policy's original
   bytes, supplied by the host. Re-serialized JSON is never hashed.

## 3. Journeys

- **J1, admin.** Open the admin page on the default model. Ask for Enterprise
  posture before any AI tool is chosen: it is refused, and the message points
  at the AI tools editor. Choose one AI tool, set Enterprise posture, select one
  catalog item from one framework, open the review, download. Output A is
  canonically valid, is schema version 3, and carries the selection in
  `authoringSelections`.
- **J2, user.** The host supplies the A from J1: the CLI host binds the launch
  folder to it, the web host imports it through a file picker. Mark the selected
  item Required, name the project, keep the type "project", run the check,
  download. In output B, `cutFrom.sha256` equals the SHA-256 of the J1 file's
  bytes, `cutFrom.schemaVersion` is 3, and the narrowing check passes.
- **J3, two hosts.** J1 and J2 pass on the hosted production build and on the
  CLI host loaded from an installed candidate package. The offline file runs
  under the exact offline policy with zero requests and zero violations.
- **J4, keyboard.** Every flyout opens from the keyboard, moves focus inside,
  keeps tab order inside while open, closes on Escape, and returns focus to the
  control that opened it.

## 4. Failure cases in the first slice

| # | Case | Required behavior | Pinned today by |
|---|---|---|---|
| 1 | Import is not strict JSON | Refused, the policy is kept, the message is shown as text | `wb-tests/new-shell-download-compat.test.ts`: "rejects a policy file that is not strict JSON with the legacy messages"; `wb-tests/shell-extracted-semantics.test.ts`: "parses strict JSON only" |
| 2 | Import is larger than `MAX_IMPORT_BYTES` (1 MiB) | Refused before the file is read | `wb-tests/new-shell-import-limit.test.ts`: "refuses an oversized #%s before reading it" |
| 3 | A committed change or import is rejected | The committed policy rolls back. Temporary text inside an editor may stay | `wb-tests/browser/journeys.spec.ts`: "imports legacy policy, rolls back invalid input, and downloads exact bytes" |
| 4 | Enterprise posture with no AI tool | Refused with the engine's message | `wb-tests/new-shell-org.test.ts`: "refuses Enterprise without an allowed CLI, then records posture and the allow-list"; `shell-extracted-semantics.test.ts`: "names the registry ids when enterprise posture has no CLI allow-list" |
| 5 | Unsafe download file name | Refused, nothing is downloaded | `new-shell-download-compat.test.ts` and `wb-tests/legacy-download-characterization.test.ts`: "refuses unsafe policy filenames without downloading" |
| 6 | Invalid prepared catalog | Check and Publish are disabled and imports are rejected | `new-shell-download-compat.test.ts`: "disables Check Policy and Publish and rejects imports" |
| 7 | Hostile text in the model or an import | Rendered as text, stored raw in the file | `new-shell-download-compat.test.ts`: "writes hostile text from an import as text, never as markup"; `wb-tests/user-door.test.ts`: "escapes model strings in the embedded data". A hostile id kept raw in the saved project file is a new test, with the first slice |
| 8 | User page without a usable policy: no source, an invalid source, no digest, no policy or an unknown schema version, or a policy that lists no items | Saving is disabled with the exact sentence from `userDoorViewModelV1` in `src/org-policy/workbench/ui/user-door-model.ts` | `user-door.test.ts`: "an invalid policy source disables save and lists nothing", "without a digest it lists nothing, names the missing server data, and cannot save", and "a policy that lists no items cannot be saved, and says why"; `wb-tests/browser/user-door.spec.ts`: "user door fails closed on an invalid policy source" |
| 9 | Empty project name | Refused | `user-door.test.ts`: "rejects a save the schema rejects (no name, no AI tool)" |
| 10 | The org policy changed after the cut | The check fails and nothing is saved | `tests/org-policy/project-policy.test.ts`: "flags a digest mismatch as 'org policy changed'" and "flags an item not present in the org policy". Saving nothing after a failed check is a new test, with the first slice |
| 11 | A web import whose bytes differ from its re-serialized JSON | The host's digest is that of the original bytes | new test, with the hosts |
| 12 | Malformed input to the engine | An error result, never a throw | new test, with the engine entry |

## 5. Byte anchors

Golden files live in `wb-tests/goldens/`. The component UI must reproduce each
one for the same inputs through the engine entry.

| Golden | Pinned by |
|---|---|
| `aih-org-policy.vibe.json`, `aih-org-policy.enterprise.json` | `legacy-download-characterization.test.ts` and `new-shell-download-compat.test.ts`: "downloads the organization policy byte-for-byte (aih-org-policy.json)" |
| `aih-org-policy.hook-control.json` | both characterization files: "downloads the organization policy after an imported transformation" |
| `import-migration.*.json`, `import-migration-messages.json` | `legacy-download-characterization.test.ts`: "pins the migration message and preview bytes for each schema-2 migration" |
| `aih-project-policy.json` | both characterization files: "serializes the project policy byte-for-byte (aih-project-policy.json)" |
| `aih-governance-decision.json`, `aih-policy-bundle.json`, `aih-artifact-intake.json` | both characterization files: their "byte-for-byte" tests |

In `new-shell-download-compat.test.ts`, use the fixed golden assertions as
anchors, not its comparisons of two shells.

**One new anchor, defined here and recorded with the engine entry.** No golden
today joins a real schema-version-3 organization policy to a project policy:
the three organization goldens are version 2, and the project golden carries a
placeholder digest. Record two files from the engine entry, review them in the
diff, then freeze them:

- `aih-org-policy.v3-selection.json`: the fixture model of the existing
  download tests, Enterprise posture, one AI tool, and its first selectable
  catalog item, compiled.
- `aih-project-policy.v3-selection.json`: cut from that file with the item
  Required, type "project", and `cutFrom.sha256` equal to the SHA-256 of the
  first file's bytes.

J1 and J2 must then produce exactly these two files on both hosts.
