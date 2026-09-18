# Policy Workbench prototype

A clickable concept of the Policy Workbench: one page where an organization's admin decides what AI tooling is allowed, and one page where anyone in the organization picks what their AI carries from that.

Status: concept v3, 2026-09-18. Not product code. Nothing here is wired to aih; every number is a placeholder (`[n]`) or a sample value.

## Open it

The screens load files next to each other, so serve the folder rather than double-clicking:

```bash
python -m http.server 8769 --directory prototype/policy-workbench
```

Then open `http://localhost:8769/`. `index.html` is the guide: the flow step by step, what each screen is for, what to check, the decisions so far and the open questions. **Mode** on the left switches light and dark for every screen.

Tailwind, Inter, JetBrains Mono and Material Symbols load from CDNs, so you need a network connection. There is no build step.

## How people get in

Admin and user run the same command: `npx @aihq/core --ui`. It serves the Workbench on this machine only (loopback) and opens it.

| Where it is run | Page that opens |
|---|---|
| A clone of the organization's policy repo | Admin page |
| A project folder | User page |
| Anywhere else | A chooser (`screens/entry.html`) |

Both pages link to the other in their top bar.

Today the product opens one workbench and takes no other arguments (`src/program.ts`). **Choosing the page by folder is a proposal**, shown by the prototype.

## How the user page finds the admin's policy

This is the product's own lookup order (`src/commands/run.ts`, `src/config/posture.ts`). aih stops at the first match, and a malformed file stops it with an error instead of falling through:

1. `--policy <file>` on a command that accepts it
2. `AIH_ORG_POLICY`, a file path IT sets once per machine
3. `aih-org-policy.json` committed in the project
4. Nothing found: aih's own Recommended template is used

The user header shows which one was used, as a chip that opens the full order. To see each case, add `?source=project`, `?source=env` or `?source=none` to `screens/user-start.html` or `screens/user-trim.html`. With `none`, user-start shows how to connect a policy.

## Saving never touches the organization's policy

There are two files, and the user page writes only the second:

| File | What it is | Who writes it |
|---|---|---|
| `acme.policy.json` (reached through `AIH_ORG_POLICY`, or committed in the project as `aih-org-policy.json`) | The organization policy | The admin only. The user page reads it and never writes it. |
| `aih-project-policy.json` | The user's choices: Required, Optional, Skip, plus the policy id, version and digest they were cut from | The user page, as a download the user commits to the project |

`aih-org-policy.json` is the name aih reads the organization policy from (`src/org-policy/constants.ts`). Saving a trim under that name would replace Acme's policy in the project, which is why the choices get their own file. `aih-project-policy.json` is a **proposed name**; aih does not read it yet. The user header's strip shows both: `policy acme.policy.json v[n]` and `saves to aih-project-policy.json`.

Remembering a policy repo on a machine ("point at it once") is **not built**; it is an open question in the guide.

## The screens

| File | Who | What it shows |
|---|---|---|
| `overview.html` | both | The two doors, and the two files that travel between them |
| `entry.html` | both | What `npx @aihq/core --ui` opens, and the chooser |
| `admin-org.html` | admin | Your organization: name, id, policy repo, accountable people, Vibe or Enterprise |
| `admin-sources.html` | admin | **The reference screen.** Sources and catalogs, kind ledger, cards, inspector |
| `admin-item.html` | admin | One item's security view and the decision on its finding |
| `admin-changes.html` | admin | Changes from the template as JSON, ready to publish |
| `admin-scan.html` | admin | Scan review grouped by meaning, one item read as a short report |
| `admin-acme.html` | admin | Adding your own items: say what it is, scan it, decide (later) |
| `user-start.html` | user | Pick a starting point: the organization policy or an aih template |
| `user-trim.html` | user | Trim it: Required, Optional or Skip, with context cost |
| `system.html` | — | The design system on one sheet |

## The user page is about context, not security

The admin has already decided security, so the user page shows it as one chip: "everything here is allowed by Acme". What users pay for is room in the model's window, so `user-trim.html` shows that instead:

- **Ledger:** the same six tiles as admin-sources (Skills, Commands, Agents, MCP Servers, Hook Events, Token Budget). Each counts what you keep and the tokens it adds at start-up. Clicking a tile filters the cards to that kind.
- **Cost on each card:** tokens loaded at start and tokens loaded when used. MCP servers are usually the expensive ones, because their tool schemas load up front. Hooks cost nothing at start; only their output enters the window.
- **Choices cascade:** Required, Optional or Skip on a whole source, a category or one item. A change sets everything under it; a level whose items differ shows **mixed**. Every count updates at once and briefly glows.
- **Warnings with one-click fixes:** two items that do the same job, an item that needs something you skipped, and too many skills for the AI to pick the right one.

The budget, overlap pairs and depends-on links come from the organization policy. They are new fields the admin would author; the admin page does not have a place for them yet. **Token figures are sample values.** In the product they must be measured by aih for each AI tool from the exact pinned content, never estimated.

## Design system

One design system, taken from `screens/admin-sources.html`, the owner's final prototype. When a screen and admin-sources disagree, admin-sources wins. `DESIGN.md` lists the values.

| File | Holds |
|---|---|
| `screens/tokens.css` | Colour values for dark (default) and light, panel surfaces, the six kind colours |
| `screens/tw-config.js` | admin-sources' Tailwind config; its colours read `tokens.css` |
| `screens/wb.css` | admin-sources' base styles: scrollbars, panel transitions, card rules |
| `screens/fonts.css` | Inter, JetBrains Mono, Material Symbols |
| `screens/mode.js` | Light or dark: `?mode=light` wins, then the last choice, then dark |
| `screens/shell.js` | The admin header, sub-header, nav rail, ledger and source view, copied from admin-sources |
| `screens/user-shell.js` | The user header and the policy-source chip |

To add a screen, copy the `<head>` of any screen, build it with Tailwind classes in admin-sources' vocabulary, and add a step to the `STEPS` list in `index.html` (the step `id` is the file name).

## Not in this prototype

- Anything wired to aih: no policy is read or written.
- Measured token costs: all figures are samples.
- The admin fields for budget, overlaps and depends-on.
- Named profiles, several organization policies, and the Enterprise signing setup screen.
