---
name: Policy Workbench
source: screens/admin-sources.html (owner's final prototype, 2026-09-18)
tokens: screens/tokens.css
modes: [dark, light]   # <html class="dark|light">, dark is native
colors:
  dark:
    background: '#0f131b'
    surface-container-lowest: '#0a0e15'   # header, nav rail
    surface-container-low: '#181c23'
    surface-container: '#1c2027'
    surface-container-high: '#262a32'
    surface-container-highest: '#31353d'
    on-surface: '#dfe2ed'
    on-surface-variant: '#c2c6d6'
    outline: '#8c909f'
    outline-variant: '#424754'
    hairline: 'rgba(255,255,255,0.07)'
    primary: '#3b82f6'
    primary-bright: '#60a5fa'
    secondary: '#4edea3'   # passed, allowed
    tertiary: '#ffb95f'    # needs review, attention
    error: '#ffb4ab'
    panels: { center: '#0c1017', cards: '#0d111a', card: '#141822', card-active: '#191e2b', ledger: '#121622', subheader: '#0e131d', inspector: '#12161f' }
  light:
    background: '#f6f8fa'
    surface-container-lowest: '#ffffff'
    surface-container: '#eaeef2'
    on-surface: '#1f2328'
    on-surface-variant: '#57606a'
    outline: '#6e7781'
    hairline: '#e2e8f0'
    primary: '#0969da'
    secondary: '#1a7f37'
    tertiary: '#b05700'
    error: '#cf222e'
primitives:
  skill:   { color: '#f59e0b', icon: extension }
  command: { color: '#06b6d4', icon: terminal }
  agent:   { color: '#a855f7', icon: smart_toy }
  mcp:     { color: '#3b82f6', icon: dns }
  hook:    { color: '#10b981', icon: webhook }
  token:   { color: '#f97316', icon: toll }
typography:
  sans: Inter
  mono: JetBrains Mono
  base: 13px
  weights: [400, 500, 600, 700]
icons: Material Symbols Outlined
radii: { DEFAULT: 2px, lg: 4px, xl: 6px, full: 8px }
layout:
  header: 44px
  subheader: 32px
  nav-rail: 240px, collapsible
  inspector: 390px, collapsible
---

The Policy Workbench has one design system: the one in `screens/admin-sources.html`.
`screens/tokens.css` holds its values; every screen reads them, admin-sources included.
When a screen and admin-sources disagree, admin-sources wins. No other themes exist.
