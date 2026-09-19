/**
 * Tailwind config for the Policy Workbench design foundation (P1).
 * Ported from prototype/policy-workbench/screens/tw-config.js (theme.extend only).
 * Colours resolve through the same CSS custom properties as the prototype so
 * this stays a pure utility-class compiler: no new color values are invented.
 * `corePlugins.preflight` is off — the generated CSS is inlined into the
 * existing document, which already has its own base styles.
 */
module.exports = {
  darkMode: ["selector", 'html[data-theme="dark"]'],
  corePlugins: { preflight: false },
  // Globs resolve against this config file, not process.cwd().
  content: {
    relative: true,
    files: ["../src/org-policy/workbench/ui/**/*.{ts,js}", "../src/org-policy/studio-template.ts"],
  },
  theme: {
    extend: {
      colors: {
        "on-secondary-fixed-variant": "#005236",
        "tertiary-fixed": "#ffddb8",
        "tertiary-fixed-dim": "#ffb95f",
        "surface-container-low": "var(--wb-color-surface-container-low, #181c23)",
        error: "var(--wb-color-error, #ffb4ab)",
        "surface-variant": "var(--wb-color-surface-variant, #31353d)",
        "surface-container-lowest": "var(--wb-color-surface-container-lowest, #0a0e15)",
        "on-tertiary-fixed-variant": "#653e00",
        "on-error": "#690005",
        "tertiary-container": "var(--wb-color-tertiary-container, #ca8100)",
        "on-surface-variant": "var(--wb-color-on-surface-variant, #c2c6d6)",
        "surface-dim": "var(--wb-color-surface-dim, #0f131b)",
        "secondary-container": "var(--wb-color-secondary-container, #00a572)",
        "on-primary": "#ffffff",
        "on-tertiary-container": "var(--wb-color-on-tertiary-container, #3e2400)",
        background: "var(--wb-color-background, #0f131b)",
        primary: "var(--wb-color-primary, #3b82f6)",
        "primary-bright": "var(--wb-color-primary-bright, #60a5fa)",
        "on-secondary-fixed": "#002113",
        "on-secondary-container": "#00311f",
        "secondary-fixed": "#6ffbbe",
        "on-tertiary-fixed": "#2a1700",
        "primary-fixed-dim": "#adc6ff",
        "error-container": "#93000a",
        tertiary: "var(--wb-color-tertiary, #ffb95f)",
        "on-primary-fixed": "#001a42",
        "inverse-surface": "var(--wb-color-inverse-surface, #dfe2ed)",
        secondary: "var(--wb-color-secondary, #4edea3)",
        "surface-tint": "#adc6ff",
        "inverse-on-surface": "#2d3038",
        "surface-container": "var(--wb-color-surface-container, #1c2027)",
        "surface-card": "var(--wb-color-surface-card, #181c23)",
        "on-surface": "var(--wb-color-on-surface, #dfe2ed)",
        "primary-container": "var(--wb-color-primary-container, #2563eb)",
        "on-secondary": "#003824",
        surface: "var(--wb-color-surface, #0f131b)",
        "outline-variant": "var(--wb-color-outline-variant, #424754)",
        "secondary-fixed-dim": "#4edea3",
        "on-primary-container": "#eff6ff",
        "surface-container-high": "var(--wb-color-surface-container-high, #262a32)",
        "on-background": "var(--wb-color-on-background, #dfe2ed)",
        "on-error-container": "#ffdad6",
        outline: "var(--wb-color-outline, #8c909f)",
        "primary-fixed": "#d8e2ff",
        "inverse-primary": "#005ac2",
        "surface-bright": "var(--wb-color-surface-bright, #353941)",
        "surface-container-highest": "var(--wb-color-surface-container-highest, #31353d)",
        "on-primary-fixed-variant": "#004395",
        "on-tertiary": "#472a00",
        // admin-sources.html's literal dark surfaces (bg-[#0a0e15] …) and the
        // light overrides its inline <style> maps them to, as theme tokens.
        hairline: "var(--wb-border-hairline)",
        "wb-nav": "var(--wb-theme-nav-rail-bg)",
        "wb-center": "var(--wb-theme-center-bg)",
        "wb-cards": "var(--wb-theme-cards-bg)",
        "wb-card": "var(--wb-card-bg)",
        "wb-card-hover": "var(--wb-card-bg-hover)",
        "wb-manifest": "var(--wb-theme-manifest-header-bg)",
        "wb-subhead": "var(--wb-theme-subhead-bg)",
        "wb-inspector": "var(--wb-theme-inspector-bg)",
        "wb-heading": "var(--wb-theme-heading-text)",
        "wb-pass-bg": "var(--wb-card-status-pass-bg)",
        "wb-pass": "var(--wb-card-status-pass-text)",
        "wb-review-bg": "var(--wb-card-status-rev-bg)",
        "wb-review": "var(--wb-card-status-rev-text)",
        "wb-badge-bg": "var(--wb-card-badge-bg)",
        "wb-badge-border": "var(--wb-card-badge-border)",
        "wb-badge": "var(--wb-card-badge-text)",
      },
      borderRadius: {
        DEFAULT: "0.125rem",
        lg: "0.25rem",
        xl: "0.375rem",
        full: "0.5rem",
      },
      fontFamily: {
        // D2: system stacks only; no font is shipped.
        "code-block": ["var(--wb-mono)"],
        mono: ["var(--wb-mono)"],
        body: ["var(--wb-font)"],
      },
    },
  },
};
