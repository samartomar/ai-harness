import type { CiImpactReceipt, CiOperatingSystem } from "./ci-impact.js";

/** Keep aligned with ci.yml's unconditional quality job (checked by tests). */
export const CI_STATIC_SCRIPTS = [
  "check:artifacts",
  "check:ecc-installer",
  "check:self-hosting-canon",
  "typecheck",
  "lint:ci",
  "docs:lint",
  "check:packed-doc-links",
  "build",
  "baseline:check",
] as const;

export interface LocalVerificationStep {
  script: string;
  args: string[];
  env: Record<string, string>;
}

export function localVerificationSteps(receipt: CiImpactReceipt): LocalVerificationStep[] {
  const steps: LocalVerificationStep[] = CI_STATIC_SCRIPTS.map((script) => ({
    script,
    args: [],
    env: {},
  }));
  if (receipt.fullSuite) {
    steps.push({
      script: "test:cov",
      args: ["--coverage.reportOnFailure", "--maxWorkers=2", "--testTimeout=15000"],
      env: {},
    });
  } else {
    steps.push({
      script: "ci:run-selected",
      args: [],
      env: {
        SELECTED_TESTS_JSON: JSON.stringify(receipt.selectedTests),
        FULL_SUITE: "false",
        TEST_LANE: receipt.testLane,
        PROVIDER_TESTS_JSON: JSON.stringify(receipt.providerTests),
        REQUIRES_GENERIC_BROWSER_JOURNEYS: String(receipt.requiresGenericBrowserJourneys),
      },
    });
  }
  if (receipt.requiresGenericBrowserJourneys) {
    steps.push({ script: "test:workbench:pr", args: [], env: {} });
  } else if (receipt.affectedProviders.length > 0) {
    steps.push({
      script: "test:workbench:providers",
      args: [],
      env: {
        AFFECTED_PROVIDERS_JSON: JSON.stringify(receipt.affectedProviders),
        PROVIDER_TESTS_JSON: JSON.stringify(receipt.providerTests),
      },
    });
  }
  return steps;
}

export function localVerificationGaps(
  receipt: CiImpactReceipt,
  platform: NodeJS.Platform,
): string[] {
  const hostOs: CiOperatingSystem | undefined =
    platform === "win32"
      ? "windows-latest"
      : platform === "darwin"
        ? "macos-latest"
        : platform === "linux"
          ? "ubuntu-latest"
          : undefined;
  const otherSystems = receipt.operatingSystems.filter((os) => os !== hostOs);
  return [
    ...(otherSystems.length > 0
      ? [`Selected tests still require hosted OS validation on: ${otherSystems.join(", ")}.`]
      : []),
    "Local results do not replace hosted runner/Node images, CodeQL, PR metadata or protected checks.",
    ...(receipt.requiresPackedArtifact
      ? ["Workbench acceptance still requires its hosted Ubuntu/Node/Chromium envelope."]
      : []),
    ...(receipt.releasePreparation
      ? ["Release-preparation authorization and allowlist checks remain required in CI."]
      : []),
  ];
}
