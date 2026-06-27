import { describe, expect, it } from "vitest";
import { parseSupportGuidance } from "../../src/support/setup.js";

/** SETUP.md → support guidance: explicit markers win; a heading is a soft fallback. */
describe("parseSupportGuidance", () => {
  it("extracts both fields from explicit markers", () => {
    const text = [
      "# Setup",
      "<!-- support:why -->",
      "acme-web processes card data; the toolchain must verify TLS to stay PCI-compliant.",
      "<!-- /support:why -->",
      "",
      "<!-- support:language -->",
      "Address to the IT Service Desk; use British English and reference change tickets.",
      "<!-- /support:language -->",
    ].join("\n");
    expect(parseSupportGuidance(text)).toEqual({
      projectContext:
        "acme-web processes card data; the toolchain must verify TLS to stay PCI-compliant.",
      corporateGuidance:
        "Address to the IT Service Desk; use British English and reference change tickets.",
    });
  });

  it("falls back to the first paragraph under a Why/Overview heading", () => {
    const text = [
      "# acme-web",
      "## Overview",
      "This service is air-gapped in production, so the dev environment must mirror that.",
      "More detail in the next paragraph.",
      "",
      "## Install",
      "steps...",
    ].join("\n");
    expect(parseSupportGuidance(text).projectContext).toBe(
      "This service is air-gapped in production, so the dev environment must mirror that. More detail in the next paragraph.",
    );
  });

  it("prefers the marker over the heading fallback", () => {
    const text = [
      "## Why",
      "heading paragraph",
      "",
      "<!-- support:why -->marker paragraph<!-- /support:why -->",
    ].join("\n");
    expect(parseSupportGuidance(text).projectContext).toBe("marker paragraph");
  });

  it("extracts real routing metadata only from its marker", () => {
    const text = "<!-- support:routing -->Assignment group: Corp IT L2<!-- /support:routing -->";
    expect(parseSupportGuidance(text).routing).toBe("Assignment group: Corp IT L2");
    expect(parseSupportGuidance("## Install\nsteps").routing).toBeUndefined();
  });

  it("returns nothing for a plain setup file", () => {
    expect(parseSupportGuidance("# Setup\n\nRun the install script.\n")).toEqual({
      projectContext: undefined,
      corporateGuidance: undefined,
      routing: undefined,
    });
  });
});
