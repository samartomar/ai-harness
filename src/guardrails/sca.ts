import { lines } from "../internals/render.js";
import { GITLEAKS_REV } from "./precommit.js";

/**
 * CI software-composition-analysis (SCA) workflow: scan dependency licenses and
 * fail the build on copyleft that legal will not accept. The license matrix
 * encodes the blueprint's "Open-Source Compliance Gates" tiers — permissive is
 * auto-approved, weak copyleft alerts, strong copyleft fails, and network
 * copyleft (AGPL) is hard-blocked.
 *
 * This emits a GENERATED FILE only. The harness never runs CI — the workflow
 * executes in the customer's pipeline (see the accompanying `doc`).
 */

export type LicenseDisposition = "auto-approve" | "alert" | "fail" | "block";

export interface LicenseTier {
  /** Compliance category from the blueprint. */
  category: string;
  /** SPDX identifiers that fall in this tier. */
  spdx: string[];
  disposition: LicenseDisposition;
  note: string;
}

/** License matrix (blueprint: Legal and Open-Source Compliance Gates). */
export const LICENSE_MATRIX: LicenseTier[] = [
  {
    category: "permissive",
    spdx: ["MIT", "Apache-2.0", "BSD-2-Clause", "BSD-3-Clause", "ISC", "0BSD", "Unlicense"],
    disposition: "auto-approve",
    note: "No reciprocal obligations — cleared automatically.",
  },
  {
    category: "weak-copyleft",
    spdx: ["MPL-2.0", "LGPL-2.1", "LGPL-3.0", "EPL-2.0", "CDDL-1.0"],
    disposition: "alert",
    note: "File-level reciprocity — allowed, but raise a review alert.",
  },
  {
    category: "strong-copyleft",
    // Include modern SPDX -only / -or-later variants: a dep declaring `GPL-3.0-only`
    // carries the same obligation as `GPL-3.0` and must not slip through the gate.
    spdx: [
      "GPL-2.0",
      "GPL-2.0-only",
      "GPL-2.0-or-later",
      "GPL-3.0",
      "GPL-3.0-only",
      "GPL-3.0-or-later",
    ],
    disposition: "fail",
    note: "Whole-work reciprocity — fail the build pending legal sign-off.",
  },
  {
    category: "network-copyleft",
    spdx: ["AGPL-3.0", "AGPL-3.0-only", "AGPL-3.0-or-later", "SSPL-1.0"],
    disposition: "block",
    note: "Network reciprocity (AGPL) — hard block, never ship.",
  },
];

/** SPDX ids whose presence must FAIL the gate (strong + network copyleft). */
export function blockingLicenses(): string[] {
  return LICENSE_MATRIX.filter(
    (t) => t.disposition === "fail" || t.disposition === "block",
  ).flatMap((t) => t.spdx);
}

/**
 * The blocking SPDX ids actually present in an SBOM document — a faithful mirror of
 * the generated workflow's gate (`grep -q "\"$spdx\"" sbom.spdx.json`). Exported so
 * the gate's POLICY is unit-tested against representative SBOM fixtures (MIT passes,
 * GPL/AGPL fail), not merely asserted as generated strings. Empty list = gate passes.
 */
export function blockedLicensesFound(
  sbomText: string,
  blocked: string[] = blockingLicenses(),
): string[] {
  return blocked.filter((spdx) => sbomText.includes(`"${spdx}"`));
}

function matrixComment(): string[] {
  const rows = LICENSE_MATRIX.map(
    (t) => `#   ${t.category.padEnd(16)} -> ${t.disposition.padEnd(12)} (${t.spdx.join(", ")})`,
  );
  return ["# License matrix (blueprint: Open-Source Compliance Gates):", ...rows];
}

/** Render `.github/workflows/sca.yml` — license scan that blocks AGPL/strong copyleft. */
export function scaWorkflowYaml(): string {
  const blocking = blockingLicenses();
  const gv = GITLEAKS_REV.replace(/^v/, ""); // bare semver for the release asset name
  return lines(
    "# .github/workflows/sca.yml — SCA + license gate (managed by aih guardrails)",
    "# Policy intent: every dependency change is scanned; copyleft that legal has",
    "# not cleared fails the pipeline. Strong + network copyleft are blocking.",
    ...matrixComment(),
    "",
    "name: sca",
    "",
    "on:",
    "  pull_request:",
    "  push:",
    "    branches: [main]",
    "",
    "permissions:",
    "  contents: read",
    "",
    "jobs:",
    // Secret scanning runs in CI too — not just the local pre-commit hook — so
    // CI-only commits, bot commits, and developers without pre-commit installed are
    // still gated. Same pinned gitleaks version + `.gitleaks.toml` policy as local.
    "  secret-scan:",
    "    runs-on: ubuntu-latest",
    "    steps:",
    "      - uses: actions/checkout@9c091bb21b7c1c1d1991bb908d89e4e9dddfe3e0 # v7.0.0",
    "        with:",
    "          fetch-depth: 0",
    `      - name: Install gitleaks (pinned ${GITLEAKS_REV})`,
    "        shell: bash",
    "        run: |",
    "          set -euo pipefail",
    `          curl -sSfL https://github.com/gitleaks/gitleaks/releases/download/${GITLEAKS_REV}/gitleaks_${gv}_linux_x64.tar.gz \\`,
    "            | tar -xz -C /usr/local/bin gitleaks",
    "      - name: Scan for committed secrets",
    "        run: gitleaks detect --config .gitleaks.toml --redact --no-banner --exit-code 1",
    "  license-gate:",
    "    runs-on: ubuntu-latest",
    "    steps:",
    // Actions SHA-pinned (matching aih's own CI discipline). anchore/sbom-action
    // is the real SBOM action — the old anchore/syft-action ref did not resolve.
    "      - uses: actions/checkout@9c091bb21b7c1c1d1991bb908d89e4e9dddfe3e0 # v7.0.0",
    "      - name: Scan dependency licenses (SBOM)",
    "        uses: anchore/sbom-action@e22c389904149dbc22b58101806040fa8d37a610 # v0.24.0",
    "        with:",
    "          output-file: sbom.spdx.json",
    "          format: spdx-json",
    "      - name: Fail on strong / network copyleft (AGPL)",
    "        shell: bash",
    "        env:",
    `          BLOCKED_LICENSES: "${blocking.join(" ")}"`,
    "        run: |",
    "          set -euo pipefail",
    "          # Block AGPL and other strong-copyleft licenses from the build.",
    '          found=""',
    "          for spdx in $BLOCKED_LICENSES; do",
    '            if grep -q "\\"$spdx\\"" sbom.spdx.json; then',
    '              found="$found $spdx"',
    "            fi",
    "          done",
    '          if [ -n "$found" ]; then',
    '            echo "::error::Blocked copyleft license(s) detected:$found"',
    "            exit 1",
    "          fi",
    '          echo "License gate passed — no blocking copyleft licenses."',
  );
}
