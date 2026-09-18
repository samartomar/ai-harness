/* Tailwind config of admin-sources.html, shared by every screen. Colours read tokens.css. */
tailwind.config = {
      darkMode: "class",
      theme: {
        extend: {
          colors: {
            "on-secondary-fixed-variant": "#005236",
            "tertiary-fixed": "#ffddb8",
            "tertiary-fixed-dim": "#ffb95f",
            "surface-container-low": "var(--color-surface-container-low, #181c23)",
            "error": "var(--color-error, #ffb4ab)",
            "surface-variant": "var(--color-surface-variant, #31353d)",
            "surface-container-lowest": "var(--color-surface-container-lowest, #0a0e15)",
            "on-tertiary-fixed-variant": "#653e00",
            "on-error": "#690005",
            "tertiary-container": "var(--color-tertiary-container, #ca8100)",
            "on-surface-variant": "var(--color-on-surface-variant, #c2c6d6)",
            "surface-dim": "var(--color-surface-dim, #0f131b)",
            "secondary-container": "var(--color-secondary-container, #00a572)",
            "on-primary": "#ffffff",
            "on-tertiary-container": "var(--color-on-tertiary-container, #3e2400)",
            "background": "var(--color-background, #0f131b)",
            "primary": "var(--color-primary, #3b82f6)",
            "primary-bright": "var(--color-primary-bright, #60a5fa)",
            "on-secondary-fixed": "#002113",
            "on-secondary-container": "#00311f",
            "secondary-fixed": "#6ffbbe",
            "on-tertiary-fixed": "#2a1700",
            "primary-fixed-dim": "#adc6ff",
            "error-container": "#93000a",
            "tertiary": "var(--color-tertiary, #ffb95f)",
            "on-primary-fixed": "#001a42",
            "inverse-surface": "var(--color-inverse-surface, #dfe2ed)",
            "secondary": "var(--color-secondary, #4edea3)",
            "surface-tint": "#adc6ff",
            "inverse-on-surface": "#2d3038",
            "surface-container": "var(--color-surface-container, #1c2027)",
            "surface-card": "var(--color-surface-card, #181c23)",
            "on-surface": "var(--color-on-surface, #dfe2ed)",
            "primary-container": "var(--color-primary-container, #2563eb)",
            "on-secondary": "#003824",
            "surface": "var(--color-surface, #0f131b)",
            "outline-variant": "var(--color-outline-variant, #424754)",
            "secondary-fixed-dim": "#4edea3",
            "on-primary-container": "#eff6ff",
            "surface-container-high": "var(--color-surface-container-high, #262a32)",
            "on-background": "var(--color-on-background, #dfe2ed)",
            "on-error-container": "#ffdad6",
            "outline": "var(--color-outline, #8c909f)",
            "primary-fixed": "#d8e2ff",
            "inverse-primary": "#005ac2",
            "surface-bright": "var(--color-surface-bright, #353941)",
            "surface-container-highest": "var(--color-surface-container-highest, #31353d)",
            "on-primary-fixed-variant": "#004395",
            "on-tertiary": "#472a00"
          },
          borderRadius: {
            "DEFAULT": "0.125rem",
            "lg": "0.25rem",
            "xl": "0.375rem",
            "full": "0.5rem"
          },
          fontFamily: {
            "code-block": ["JetBrains Mono", "monospace"],
            "mono": ["JetBrains Mono", "monospace"],
            "body": ["Inter", "sans-serif"]
          }
        }
      }
    }
