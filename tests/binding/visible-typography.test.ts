import { describe, expect, it } from "vitest";
import { classifyFileTypography } from "../../src/binding/visible-typography.js";

// Visible typography (advisory-eligible): em-dash, box-drawing, arrow, star.
const EM = "—";
const BOX = "─";
const ARROW = "→";
// Always-blocking (ruling point 3), one per class:
const ZWSP = "​"; // zero-width
const RLO = "‮"; // bidi control
const NBSP = " "; // suspicious whitespace
const SHY = "­"; // soft hyphen (Cf)
const VS16 = "️"; // default-ignorable variation selector
// Homoglyph confusable letter (Cyrillic a):
const CYR_A = "а";

describe("classifyFileTypography (rule-8 per-file visible-typography demotion)", () => {
  it("em-dash in markdown prose demotes (context prose)", () => {
    const verdict = classifyFileTypography("qa/SKILL.md", `# Title\n\nDesign ${EM} review pass.\n`);
    expect(verdict.demote).toBe(true);
    expect(verdict.contextClass).toBe("prose");
  });

  it("box-drawing in a ts BLOCK comment continuation line demotes (the coarse-report gap)", () => {
    const text = `/*\n * ${BOX.repeat(20)}\n * banner\n */\nexport const x = 1;\n`;
    const verdict = classifyFileTypography("browse/src/activity.ts", text);
    expect(verdict.demote).toBe(true);
    expect(verdict.contextClass).toBe("comment");
  });

  it("box-drawing at a genuine ts code position blocks", () => {
    const verdict = classifyFileTypography("browse/src/x.ts", `const ${BOX} = 1;\n`);
    expect(verdict.demote).toBe(false);
    expect(verdict.blockingReason).toMatch(/code/);
  });

  it("box-drawing in a ts STRING literal blocks (ruling: ts/js strings are not advisory)", () => {
    const verdict = classifyFileTypography("browse/src/x.ts", `const bar = "${BOX.repeat(10)}";\n`);
    expect(verdict.demote).toBe(false);
  });

  it("every point-3 always-block class keeps an otherwise-prose file blocking", () => {
    for (const bad of [ZWSP, RLO, NBSP, SHY, VS16]) {
      const verdict = classifyFileTypography(
        "qa/SKILL.md",
        `Prose with ${EM} and a hidden ${bad} char.\n`,
      );
      expect(verdict.demote).toBe(false);
      expect(verdict.blockingReason).toMatch(/always-block/);
    }
  });

  it("per-file roll-up: one blocking occurrence keeps an otherwise-advisory file high", () => {
    // prose em-dash (advisory) + a confusable letter in inline code (blocks) → file blocks.
    const verdict = classifyFileTypography(
      "qa/SKILL.md",
      `Intro ${EM} fine.\n\nInline: \`c${CYR_A}fe\`\n`,
    );
    expect(verdict.demote).toBe(false);
  });

  it("bash comment and quoted string demote; bash code position blocks", () => {
    expect(
      classifyFileTypography("bin/gstack-x", `#!/usr/bin/env bash\n# ${BOX.repeat(10)}\necho hi\n`)
        .demote,
    ).toBe(true);
    expect(
      classifyFileTypography("bin/gstack-y", `#!/bin/bash\necho "Design ${EM} review"\n`).demote,
    ).toBe(true);
    expect(classifyFileTypography("bin/gstack-z", `#!/bin/bash\nfoo=${BOX}\n`).demote).toBe(false);
  });

  it("bash heredoc body blocks (treated as unknown unless provably doc text)", () => {
    const text = `#!/bin/bash\ncat <<EOF\nrm ${EM} rf\nEOF\n`;
    expect(classifyFileTypography("bin/gstack-h", text).demote).toBe(false);
  });

  it("yaml quoted human-facing value demotes; key and unquoted scalar block", () => {
    const quoted = classifyFileTypography(
      "agents/openai.yaml",
      `short_description: "Plan ${EM} do"\n`,
    );
    expect(quoted.demote).toBe(true);
    expect(quoted.contextClass).toBe("string");
    expect(classifyFileTypography("agents/x.yaml", `desc${EM}ription: value\n`).demote).toBe(false);
    expect(classifyFileTypography("agents/y.yaml", `name: Design ${EM} review\n`).demote).toBe(
      false,
    );
  });

  it("json human-facing value demotes; key and non-human value block", () => {
    expect(
      classifyFileTypography("package.json", `{"description": "Build ${EM} tool"}\n`).demote,
    ).toBe(true);
    expect(classifyFileTypography("package.json", `{"version": "1.0${EM}0"}\n`).demote).toBe(false);
    expect(classifyFileTypography("x.json", `{"na${EM}me": "v"}\n`).demote).toBe(false);
  });

  it("identifier confusable (non-ASCII letter in ts code) blocks", () => {
    expect(classifyFileTypography("browse/src/x.ts", `const c${CYR_A}fe = 1;\n`).demote).toBe(
      false,
    );
  });

  it("markdown code fence: decorative diagram demotes; confusable and point-3 block", () => {
    expect(
      classifyFileTypography("qa/SKILL.md", `\`\`\`\n${BOX.repeat(10)}\n${ARROW}\n\`\`\`\n`).demote,
    ).toBe(true);
    expect(classifyFileTypography("qa/SKILL.md", `\`\`\`\ncmd ${CYR_A}\n\`\`\`\n`).demote).toBe(
      false,
    );
    expect(classifyFileTypography("qa/SKILL.md", `\`\`\`\ncmd${ZWSP}\n\`\`\`\n`).demote).toBe(
      false,
    );
  });

  it("an all-ASCII file does not demote (zero occurrences)", () => {
    const verdict = classifyFileTypography("qa/SKILL.md", "# plain ascii only\n");
    expect(verdict.demote).toBe(false);
    expect(verdict.occurrences).toBe(0);
  });

  it("an unrecognized file class blocks every non-ASCII char (unknown context)", () => {
    const verdict = classifyFileTypography("assets/data.bin", `${EM}${BOX}`);
    expect(verdict.demote).toBe(false);
    expect(verdict.blockingReason).toMatch(/unknown/);
  });
});
