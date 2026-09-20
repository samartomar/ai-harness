/**
 * Tailwind for the component UI: the prototype's own configuration, read from
 * prototype/policy-workbench/screens/tw-config.js so there is one copy of it.
 * That file is a browser script which assigns `tailwind.config`, so it is
 * evaluated against a holder object. It is a local repository file.
 */
const { readFileSync } = require("node:fs");
const { resolve } = require("node:path");

const prototypeConfigPath = resolve(
  __dirname,
  "../prototype/policy-workbench/screens/tw-config.js",
);
const holder = {};
new Function("tailwind", readFileSync(prototypeConfigPath, "utf8"))(holder);
if (holder.config === undefined || holder.config.theme === undefined)
  throw new Error(`The prototype Tailwind configuration is unreadable: ${prototypeConfigPath}`);

module.exports = {
  ...holder.config,
  content: {
    relative: true,
    files: ["./index.html", "./src/**/*.{ts,tsx}", "./preview/**/*.{ts,tsx}"],
  },
  // The prototype loads Tailwind with `?plugins=forms,container-queries`.
  plugins: [require("@tailwindcss/forms"), require("@tailwindcss/container-queries")],
};
