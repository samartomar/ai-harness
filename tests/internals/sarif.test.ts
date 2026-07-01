import { describe, expect, it } from "vitest";
import { reportToSarif } from "../../src/internals/sarif.js";
import { VerificationReport } from "../../src/internals/verify.js";
import { VERSION } from "../../src/program.js";

/** A report with one of each verdict, in a fixed order, for deterministic assertions. */
function mixedReport(): VerificationReport {
  return new VerificationReport()
    .pass("router present", "router present")
    .fail("bootloader CLAUDE.md in sync", "drifted from the canonical block — regenerate")
    .skip("claude installed", "not detected on this machine");
}

describe("reportToSarif", () => {
  it("emits a valid SARIF 2.1.0 envelope with the aih driver", () => {
    const sarif = JSON.parse(reportToSarif(mixedReport()));
    expect(sarif.version).toBe("2.1.0");
    expect(sarif.$schema).toContain("sarif-2.1.0");
    const driver = sarif.runs[0].tool.driver;
    expect(driver.name).toBe("aih");
    expect(driver.version).toBe(VERSION);
    expect(driver.informationUri).toContain("ai-harness");
  });

  it("maps verdicts to SARIF levels: fail→error, skip→note, pass→note", () => {
    const sarif = JSON.parse(reportToSarif(mixedReport()));
    const byRule = Object.fromEntries(
      sarif.runs[0].results.map((r: { ruleId: string; level: string }) => [r.ruleId, r.level]),
    );
    expect(byRule["router present"]).toBe("note"); // pass → note
    expect(byRule["bootloader CLAUDE.md in sync"]).toBe("error"); // fail → error
    expect(byRule["claude installed"]).toBe("note"); // skip → note
  });

  it("carries one result per check and the detail as the message text", () => {
    const sarif = JSON.parse(reportToSarif(mixedReport()));
    const results = sarif.runs[0].results;
    expect(results).toHaveLength(3);
    const fail = results.find(
      (r: { ruleId: string }) => r.ruleId === "bootloader CLAUDE.md in sync",
    );
    expect(fail.message.text).toBe("drifted from the canonical block — regenerate");
    // Probes are repo-global, not line-anchored — location-less is valid SARIF.
    expect(fail.locations).toEqual([]);
  });

  it("renders file-backed findings with physical locations and stable fingerprints", () => {
    const sarif = JSON.parse(
      reportToSarif(
        new VerificationReport().add({
          name: "plaintext-secret",
          verdict: "fail",
          detail: ".env — plaintext secret on disk",
          location: { uri: ".env", startLine: 1 },
          fingerprint: "plaintext-secret:.env",
        }),
      ),
    );
    const result = sarif.runs[0].results[0];
    expect(result.locations[0].physicalLocation.artifactLocation.uri).toBe(".env");
    expect(result.locations[0].physicalLocation.region.startLine).toBe(1);
    expect(result.partialFingerprints["aih/v1"]).toBe("plaintext-secret:.env");
  });

  it("drops unsafe artifact URIs from emitted SARIF locations", () => {
    const sarif = JSON.parse(
      reportToSarif(
        new VerificationReport().add({
          name: "unsafe-location",
          verdict: "fail",
          detail: "unsafe location",
          location: { uri: "../../../../etc/passwd", startLine: 1 },
        }),
      ),
    );

    expect(sarif.runs[0].results[0].locations).toEqual([]);
  });

  it("derives one rule per distinct check name (deduped, first-seen order)", () => {
    const report = new VerificationReport().fail("dup", "first").fail("dup", "second").pass("solo");
    const sarif = JSON.parse(reportToSarif(report));
    const ruleIds = sarif.runs[0].tool.driver.rules.map((r: { id: string }) => r.id);
    expect(ruleIds).toEqual(["dup", "solo"]);
    // Both occurrences still produce results, even though the rule is deduped.
    expect(sarif.runs[0].results).toHaveLength(3);
  });

  it("falls back to the check name as the message when no detail is given", () => {
    const sarif = JSON.parse(reportToSarif(new VerificationReport().pass("bare")));
    expect(sarif.runs[0].results[0].message.text).toBe("bare");
  });

  it("honors a custom tool name", () => {
    const sarif = JSON.parse(reportToSarif(new VerificationReport().pass("x"), "aih-secrets"));
    expect(sarif.runs[0].tool.driver.name).toBe("aih-secrets");
  });

  it("renders an empty-but-valid SARIF for a report with no checks", () => {
    const sarif = JSON.parse(reportToSarif(new VerificationReport()));
    expect(sarif.version).toBe("2.1.0");
    expect(sarif.runs[0].results).toEqual([]);
    expect(sarif.runs[0].tool.driver.rules).toEqual([]);
  });
});
