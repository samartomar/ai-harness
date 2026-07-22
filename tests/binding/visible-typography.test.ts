import { describe, expect, it } from "vitest";
import {
  classifyFileTypography,
  classifySentinelLineShape,
} from "../../src/binding/visible-typography.js";

// Visible typography (advisory-eligible) — literal glyphs are legible; all
// invisible / format characters are written as \u escapes so this test file
// carries no raw hidden characters of its own.
const EM = "—"; // U+2014 em dash (curated dash)
const BOX = "─"; // U+2500 box drawing
const ARROW = "→"; // U+2192 arrow
const SIGMA = "Σ"; // U+03A3 Greek capital letter (notation)
const CJK = "繁體"; // U+7E41 U+9AD4 CJK letters
const WARN = "⚠"; // U+26A0 emoji base (Extended_Pictographic)
const DHORIZ = "═"; // U+2550 box drawing double horizontal
const COPYRIGHT = "©"; // U+00A9 (\p{S} but OUT of the explicit decorative ranges)
const CYR_A = "а"; // U+0430 Cyrillic a (homoglyph confusable)
// Always-blocking (ruling point 3), one per class, as escapes:
const ZWSP = "​"; // zero-width space
const RLO = "‮"; // bidi control (right-to-left override)
const NBSP = " "; // suspicious whitespace
const SHY = "­"; // soft hyphen (Cf + explicit always-block)
const VS16 = "️"; // default-ignorable variation selector
const REPL = "�"; // U+FFFD replacement char (must NOT demote)

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

  it("box-drawing in a ts STRING literal now demotes (ruling: tsjs-string is a DISPLAY context)", () => {
    // CHANGED by the 2026-07-21 final ruling: ts/js string content is DISPLAY, so
    // an explicit decorative char there is advisory (was blocking pre-ruling).
    const verdict = classifyFileTypography("browse/src/x.ts", `const bar = "${BOX.repeat(10)}";\n`);
    expect(verdict.demote).toBe(true);
    expect(verdict.contextClass).toBe("tsjs-string");
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
    // prose em-dash (advisory) + a non-decorative symbol in inline code (blocks) → file blocks.
    // (A confusable LETTER in inline code is now advisory "notation-letters" per the
    // ruling, so the blocker here is ©, which is neither decorative nor a letter.)
    const verdict = classifyFileTypography(
      "qa/SKILL.md",
      `Intro ${EM} fine.\n\nInline: \`c${COPYRIGHT}fe\`\n`,
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

  it("cat-fed bash heredoc body now demotes as heredoc-display (ruling point 3b)", () => {
    // CHANGED by the final ruling: a cat-fed heredoc body is DISPLAY, so decorative
    // typography in it is advisory (was blocking pre-ruling).
    const text = `#!/bin/bash\ncat <<EOF\nDesign ${EM} review\nEOF\n`;
    const verdict = classifyFileTypography("bin/gstack-h", text);
    expect(verdict.demote).toBe(true);
    expect(verdict.contextClass).toBe("heredoc-display");
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

// -- New calibration behaviors (2026-07-21 final ruling, points 1/2/3) --------

describe("decorative allow-list is explicit ranges, not \\p{S}\\p{Pd} (ruling point 1)", () => {
  // One representative per accepted range/set, each dropped into a markdown fence.
  const DECORATIVE = [
    "‐", // U+2010 hyphen
    "—", // U+2014 em dash
    "―", // U+2015 horizontal bar
    "─", // U+2500 box drawing
    "█", // U+2588 block element (full block)
    "■", // U+25A0 geometric shape (black square)
    "→", // U+2192 arrow
    "✓", // U+2713 check mark
    "✘", // U+2718 cross mark
    "…", // U+2026 horizontal ellipsis (curated)
    "·", // U+00B7 middle dot (curated)
    "•", // U+2022 bullet (curated)
    "§", // U+00A7 section sign (curated)
  ];

  it("every explicit decorative code point demotes in a DISPLAY context", () => {
    for (const ch of DECORATIVE) {
      expect(classifyFileTypography("qa/SKILL.md", `\`\`\`\n${ch}\n\`\`\`\n`).demote).toBe(true);
    }
  });

  it("U+FFFD and U+00A9 do NOT demote in a DISPLAY context (out of the explicit ranges)", () => {
    expect(classifyFileTypography("qa/SKILL.md", `\`\`\`\n${REPL}\n\`\`\`\n`).demote).toBe(false);
    expect(classifyFileTypography("qa/SKILL.md", `\`\`\`\n${COPYRIGHT}\n\`\`\`\n`).demote).toBe(
      false,
    );
  });

  it("U+2011 non-breaking hyphen is NOT decorative (deliberately excluded)", () => {
    expect(classifyFileTypography("qa/SKILL.md", `\`\`\`\n‑\n\`\`\`\n`).demote).toBe(false);
  });

  it("U+00AD soft hyphen blocks even in prose (explicit always-block, defense in depth)", () => {
    const verdict = classifyFileTypography("qa/SKILL.md", `Prose with a soft${SHY}hyphen.\n`);
    expect(verdict.demote).toBe(false);
    expect(verdict.blockingReason).toMatch(/always-block/);
  });

  // Maintainer-authorized display-glyph correction (2026-07-22, option (b) after
  // the official requirement-8 BLOCK): the emoji-block status glyphs and observed
  // same-class display symbols the dingbat-only check/cross range missed.
  const CORRECTED_DISPLAY_GLYPHS = [
    "✅", // white heavy check mark (emoji check)
    "❌", // cross mark (emoji cross)
    "★", // black star
    "⚠", // warning sign (bare)
    "⛔", // no entry
    "\u{1F916}", // robot face
    "\u{1F525}", // fire
    "×", // multiplication sign
    "≤", // less-than or equal
    "≥", // greater-than or equal
  ];

  it("every corrected display glyph demotes in a markdown fence (DISPLAY context)", () => {
    for (const ch of CORRECTED_DISPLAY_GLYPHS) {
      expect(
        classifyFileTypography("qa/SKILL.md", `\`\`\`\n${ch} status line\n\`\`\`\n`).demote,
        `U+${(ch.codePointAt(0) ?? 0).toString(16).toUpperCase()}`,
      ).toBe(true);
    }
  });

  it("corrected BMP display glyphs demote in a ts string literal (DISPLAY context)", () => {
    // Astral glyphs are exercised via markdown above; the ts/js tokenizer scans
    // by code unit, and no astral display glyph occurs in ts contexts in the
    // pinned tree.
    for (const ch of CORRECTED_DISPLAY_GLYPHS.filter((c) => (c.codePointAt(0) ?? 0) <= 0xffff)) {
      expect(
        classifyFileTypography("browse/src/x.ts", `const s = "${ch} ok";\n`).demote,
        `U+${(ch.codePointAt(0) ?? 0).toString(16).toUpperCase()}`,
      ).toBe(true);
    }
  });

  it("the correction does not widen always-block or FFFD behavior", () => {
    expect(classifyFileTypography("qa/SKILL.md", `\`\`\`\n${REPL}\n\`\`\`\n`).demote).toBe(false);
    const zwsp = "​";
    expect(classifyFileTypography("qa/SKILL.md", `\`\`\`\n✅${zwsp}\n\`\`\`\n`).demote).toBe(false);
  });
});

describe("DISPLAY letter/mark advisories (ruling point 2)", () => {
  it("a Greek letter in markdown inline-code demotes with contextClass notation-letters", () => {
    const verdict = classifyFileTypography("qa/SKILL.md", `Use the \`${SIGMA}\` operator.\n`);
    expect(verdict.demote).toBe(true);
    expect(verdict.contextClass).toBe("notation-letters");
  });

  it("CJK letters in a ts string demote with contextClass display-string-letters", () => {
    const verdict = classifyFileTypography("browse/src/i18n.ts", `const label = "${CJK}";\n`);
    expect(verdict.demote).toBe(true);
    expect(verdict.contextClass).toBe("display-string-letters");
  });

  it("a letter in a markdown FENCE still blocks (fences never permit letters)", () => {
    expect(classifyFileTypography("qa/SKILL.md", `\`\`\`\n${SIGMA}\n\`\`\`\n`).demote).toBe(false);
  });

  it("a digit-like non-ASCII in inline-code still blocks (letters only, NOT digits)", () => {
    // U+FF15 FULLWIDTH DIGIT FIVE is \p{Nd}, not \p{L}/\p{M}: blocks in display.
    expect(classifyFileTypography("qa/SKILL.md", `value \`５\`\n`).demote).toBe(false);
  });
});

describe("FE0F emoji-presentation pair rule (ruling point 2)", () => {
  it("an emoji base + FE0F demotes with contextClass EXPECTED_EMOJI_PRESENTATION_SELECTOR", () => {
    const verdict = classifyFileTypography("qa/SKILL.md", `# t\n\nStatus ${WARN}${VS16} ok\n`);
    expect(verdict.demote).toBe(true);
    expect(verdict.contextClass).toBe("EXPECTED_EMOJI_PRESENTATION_SELECTOR");
  });

  it("a standalone FE0F (no emoji base before it) blocks", () => {
    const verdict = classifyFileTypography("qa/SKILL.md", `# t\n\nStatus ${VS16} ok\n`);
    expect(verdict.demote).toBe(false);
    expect(verdict.blockingReason).toMatch(/always-block/);
  });

  it("FE0F in a code/key/unknown context blocks even after an emoji base", () => {
    // scanOther classifies everything as unknown, which is not an FE0F pair context.
    expect(classifyFileTypography("assets/blob.dat", `${WARN}${VS16}`).demote).toBe(false);
  });
});

describe("scanTsJs template interpolation depth (ruling point 3a)", () => {
  it("an arrow inside a NESTED template string demotes (classified tsjs-string, not code)", () => {
    const src = `const label = \`Opened tab \${id}\${url ? \` ${ARROW} \${url}\` : ""}\`;\n`;
    const verdict = classifyFileTypography("browse/src/tabs.ts", src);
    expect(verdict.demote).toBe(true);
    expect(verdict.contextClass).toBe("tsjs-string");
  });

  it("a raw box-drawing char at a top-level code position (outside any string) blocks", () => {
    const verdict = classifyFileTypography("browse/src/const.ts", `const sep = ${DHORIZ};\n`);
    expect(verdict.demote).toBe(false);
    expect(verdict.blockingReason).toMatch(/code/);
  });

  it("code inside a template interpolation is code: a raw non-ASCII there blocks", () => {
    const src = `const s = \`n=\${count ${DHORIZ} 1}\`;\n`;
    expect(classifyFileTypography("browse/src/x.ts", src).demote).toBe(false);
  });
});

describe("scanBash heredoc feed classification (ruling point 3b)", () => {
  it("cat-fed heredoc (with redirect and quoted delimiter) demotes as heredoc-display", () => {
    const text = `#!/bin/bash\ncat >&2 <<'EOF'\nDesign ${EM} review\nEOF\n`;
    const verdict = classifyFileTypography("bin/gstack-note", text);
    expect(verdict.demote).toBe(true);
    expect(verdict.contextClass).toBe("heredoc-display");
  });

  it("python3-fed heredoc body is tokenized by the python scanner (a comment em-dash demotes)", () => {
    const text = `#!/bin/bash\npython3 - "$A" <<'PYEOF'\n# design ${EM} review\nprint("ok")\nPYEOF\n`;
    const verdict = classifyFileTypography("bin/gstack-embed", text);
    expect(verdict.demote).toBe(true);
    expect(verdict.contextClass).toBe("comment");
  });

  it("a non-cat/non-python interpreter heredoc (psql) still blocks", () => {
    const text = `#!/bin/bash\npsql <<EOF\nSELECT 'a ${EM} b';\nEOF\n`;
    const verdict = classifyFileTypography("bin/gstack-sql", text);
    expect(verdict.demote).toBe(false);
    expect(verdict.blockingReason).toMatch(/heredoc/);
  });

  it("a python3-fed heredoc with a code-position char still blocks", () => {
    const text = `#!/bin/bash\npython3 - <<'PYEOF'\nsep = ${DHORIZ}\nPYEOF\n`;
    expect(classifyFileTypography("bin/gstack-embed2", text).demote).toBe(false);
  });
});

describe("scanPython file class (ruling point 3c)", () => {
  it("docstring, comment, and f-string em-dashes all demote (comment/string contexts)", () => {
    const src = `"""Module ${EM} docs."""\n# note ${EM} here\nlabel = f"tag ${EM} {x}"\n`;
    expect(classifyFileTypography("tools/redact.py", src).demote).toBe(true);
  });

  it("a python code-position char blocks", () => {
    expect(classifyFileTypography("tools/redact.py", `sep = ${DHORIZ}\n`).demote).toBe(false);
  });

  it("a python-shebang file with no .py extension resolves to the python scanner", () => {
    const src = `#!/usr/bin/env python3\n# banner ${EM}\nprint("hi")\n`;
    expect(classifyFileTypography("bin/gstack-pytool", src).demote).toBe(true);
  });
});

// -- Sentinel-literal line-shape proof (ruling point 5) ----------------------
//
// The four EXPECTED_SANITIZER_SENTINEL_LITERAL acceptances (lib/redact-engine.ts,
// browse/src/server.ts, browse/src/sanitize.ts, browse/src/content-security.ts)
// are valid ONLY because their flagged lines carry the special/hidden characters
// as explicit detection/replacement VALUES — regex character classes, .replace()
// operands, and named sentinel-string constants — and NOT as executable
// identifiers, commands, paths, keys, or syntax. These are the exact sentinel
// lines from the pinned garrytan/gstack@11de390b tree, reconstructed with \u
// escapes (so this file carries no raw hidden characters); the orchestrator's
// evidence script runs the same helper over the full pinned files.
const ZW = {
  space: "​", // ZERO WIDTH SPACE
  nonJoiner: "‌", // ZERO WIDTH NON-JOINER
  joiner: "‍", // ZERO WIDTH JOINER
  wordJoiner: "⁠", // WORD JOINER
  bom: "﻿", // ZERO WIDTH NO-BREAK SPACE / BOM
};
const DH = "═"; // ═ box drawing double horizontal (envelope sentinel)

describe("classifySentinelLineShape (rule-8 EXPECTED_SANITIZER_SENTINEL_LITERAL proof)", () => {
  const SENTINEL_LINES: Array<{ from: string; code: string }> = [
    // lib/redact-engine.ts:89 — a zero-width detection regex constant.
    {
      from: "lib/redact-engine.ts:89 (ZERO_WIDTH regex const)",
      code: `const ZERO_WIDTH = /[${ZW.space}${ZW.nonJoiner}${ZW.joiner}${ZW.wordJoiner}${ZW.bom}]/g;`,
    },
    // lib/redact-engine.ts:89 and browse/src/server.ts:133 — a .replace() strip call.
    {
      from: "lib/redact-engine.ts:89 / browse/src/server.ts:133 (strip .replace)",
      code: `const stripped = raw.replace(/[\\s ${ZW.space}-${ZW.joiner}${ZW.bom}]/g, '');`,
    },
    // browse/src/server.ts:96 and browse/src/sanitize.ts:17 — replace to U+FFFD.
    {
      from: "browse/src/server.ts:96 / browse/src/sanitize.ts:17 (lone-surrogate .replace)",
      code: "return s.replace(LONE_SURROGATE_HIGH, '�').replace(LONE_SURROGATE_LOW, '�');",
    },
    // browse/src/content-security.ts:202-203 — the U+2550 envelope sentinel consts.
    {
      from: "browse/src/content-security.ts:202 (ENVELOPE_BEGIN const)",
      code: `const ENVELOPE_BEGIN = '${DH}${DH}${DH} BEGIN UNTRUSTED WEB CONTENT ${DH}${DH}${DH}';`,
    },
    {
      from: "browse/src/content-security.ts:203 (ENVELOPE_END const)",
      code: `const ENVELOPE_END = '${DH}${DH}${DH} END UNTRUSTED WEB CONTENT ${DH}${DH}${DH}';`,
    },
    // browse/src/content-security.ts:220-221 — escapeEnvelopeSentinels() .replace().
    {
      from: "browse/src/content-security.ts:220-221 (escapeEnvelopeSentinels .replace)",
      code: `return input.replace(/${DH}${DH}${DH} BEGIN UNTRUSTED WEB CONTENT ${DH}${DH}${DH}/g, marker);`,
    },
  ];

  it("classifies every pinned sentinel line as detection-replacement", () => {
    for (const { from, code } of SENTINEL_LINES) {
      expect(classifySentinelLineShape(code), from).toBe("detection-replacement");
    }
  });

  // Counterexamples: the SAME kinds of characters in identifier / command / path /
  // key / syntax positions must classify "other" (never proven benign).
  const COUNTEREXAMPLES: Array<{ shape: string; code: string }> = [
    { shape: "identifier (confusable letter)", code: `const c${CYR_A}fe = resolveUser();` },
    { shape: "identifier (zero-width joiner in a name)", code: `let user${ZW.space}Id = 0;` },
    { shape: "command", code: `rm -rf "$HOME/.cache/${ZW.space}state"` },
    { shape: "path / import specifier", code: `import { sanitizeInput } from "./sanitize";` },
    { shape: "object key", code: `  "user${ZW.space}name": loadConfig(),` },
    { shape: "heredoc command", code: "cat <<EOF" },
  ];

  it("classifies identifier / command / path / key / syntax counterexamples as other", () => {
    for (const { shape, code } of COUNTEREXAMPLES) {
      expect(classifySentinelLineShape(code), shape).toBe("other");
    }
  });

  it("content-security.ts non-sentinel display/comment glyphs satisfy point-5's negative condition", () => {
    // content-security.ts ALSO carries a U+26A0 display-warning glyph (line 238) and
    // header comment em-dashes / a U+2500 banner. Those are NON-executable,
    // NON-identifier, NON-path, NON-key, NON-syntax — display/comment DATA, not
    // detection-replacement VALUE shapes — so the helper returns "other" for a
    // display-call / comment line. The per-file content-pinned acceptance
    // (fileSha256) covers them under point-5's negative condition; they are NOT
    // relied on as detection-replacement.
    const displayGlyphCall = `logWarning('${WARN} untrusted content blocked');`;
    const commentBanner = ` * ${BOX.repeat(60)}`;
    expect(classifySentinelLineShape(displayGlyphCall)).toBe("other");
    expect(classifySentinelLineShape(commentBanner)).toBe("other");
    expect(classifySentinelLineShape("")).toBe("other");
  });
});
