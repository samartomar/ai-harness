# Vendored fonts for the policy workbench prototype

This folder holds the woff2 fonts (Inter, JetBrains Mono, Material Symbols Outlined) loaded by `prototype/policy-workbench/screens/`, vendored so the product works offline.
Regenerate with `node tools/wb-fonts.mjs --fetch` (the only step that needs the network), then check integrity with `node tools/wb-fonts.mjs --verify`.
Inter and JetBrains Mono are licensed under the SIL Open Font License 1.1 (see `licenses/inter-OFL.txt` and `licenses/jetbrains-mono-OFL.txt`).
Material Symbols Outlined is licensed under the Apache License 2.0 (see `licenses/material-symbols-APACHE-2.0.txt`).
