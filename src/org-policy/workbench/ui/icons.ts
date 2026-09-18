/**
 * Inline SVG icon set for the Policy Workbench (D2). Replaces the prototype's
 * Material Symbols icon font, which is a network font and not offline-safe.
 * Every glyph name used by prototype/policy-workbench/screens/admin-sources.html
 * and shell.js has an entry here. Each icon is a plain 24x24 stroke drawing
 * using `currentColor`, marked `aria-hidden="true"` since the icons are always
 * paired with visible or accessible text elsewhere in the markup.
 */

const ICON_ATTRS =
  'viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"';

function svg(body: string): string {
  return `<svg ${ICON_ATTRS}>${body}</svg>`;
}

/** Glyph name -> inline SVG markup. Names match the prototype's Material Symbols names. */
export const workbenchIcons: Record<string, string> = {
  account_tree: svg(
    '<circle cx="6" cy="6" r="2"/><circle cx="6" cy="18" r="2"/><circle cx="18" cy="12" r="2"/><path d="M6 8v8M6 12h10"/>',
  ),
  add: svg('<path d="M12 5v14M5 12h14"/>'),
  admin_panel_settings: svg(
    '<path d="M12 3l7 3v6c0 4.5-3 7.5-7 9-4-1.5-7-4.5-7-9V6l7-3z"/><circle cx="12" cy="11" r="2"/>',
  ),
  arrow_drop_down: svg('<path d="M7 10l5 5 5-5"/>'),
  arrow_forward: svg('<path d="M5 12h14M13 6l6 6-6 6"/>'),
  arrow_outward: svg('<path d="M7 17L17 7M9 7h8v8"/>'),
  bolt: svg('<path d="M13 3L5 14h6l-1 7 8-11h-6l1-7z"/>'),
  call_split: svg('<path d="M6 3v6c0 3 2 4 5 4h1M18 3v6c0 3-2 4-5 4h-1M12 13v8"/>'),
  check: svg('<path d="M5 13l4 4L19 7"/>'),
  check_circle: svg('<circle cx="12" cy="12" r="9"/><path d="M8 12l3 3 5-6"/>'),
  chevron_left: svg('<path d="M15 6l-6 6 6 6"/>'),
  chevron_right: svg('<path d="M9 6l6 6-6 6"/>'),
  close: svg('<path d="M6 6l12 12M18 6L6 18"/>'),
  code: svg('<path d="M9 6l-6 6 6 6M15 6l6 6-6 6"/>'),
  dark_mode: svg('<path d="M20 14.5A8.5 8.5 0 1 1 9.5 4a7 7 0 0 0 10.5 10.5z"/>'),
  dns: svg(
    '<rect x="3" y="4" width="18" height="6" rx="1.5"/><rect x="3" y="14" width="18" height="6" rx="1.5"/><circle cx="7" cy="7" r="1"/><circle cx="7" cy="17" r="1"/>',
  ),
  domain: svg(
    '<rect x="4" y="3" width="10" height="18"/><rect x="14" y="9" width="6" height="12"/><path d="M7 7h1M10 7h1M7 11h1M10 11h1M7 15h1M10 15h1"/>',
  ),
  download: svg(
    '<path d="M12 4v11M7.5 10.5L12 15l4.5-4.5"/><path d="M5 15v3.5A2.5 2.5 0 0 0 7.5 21h9a2.5 2.5 0 0 0 2.5-2.5V15"/>',
  ),
  done_all: svg('<path d="M2 12l4 4L14 8M8 12l4 4L22 6"/>'),
  edit_document: svg('<path d="M6 3h9l4 4v14H6z"/><path d="M9 15l6-6 2 2-6 6H9v-2z"/>'),
  expand_more: svg('<path d="M6 9l6 6 6-6"/>'),
  extension: svg(
    '<path d="M9 4h4v2.2a1.8 1.8 0 0 0 3.6 0V4H20v4.2a1.8 1.8 0 0 1 0 3.6V20H4v-4h2.2a1.8 1.8 0 0 0 0-3.6H4V9h5V4z"/>',
  ),
  flag: svg('<path d="M5 3v18M5 4h13l-3 4 3 4H5"/>'),
  folder: svg('<path d="M3 6h6l2 2h10v11H3z"/>'),
  folder_open: svg('<path d="M3 7h6l2 2h9l-2 9H5z"/>'),
  hard_drive: svg(
    '<rect x="2" y="7" width="20" height="10" rx="1.5"/><path d="M6 15h.01M10 15h4"/>',
  ),
  help: svg(
    '<circle cx="12" cy="12" r="9"/><path d="M9.5 9a2.5 2.5 0 1 1 3.5 2.3c-.8.4-1 .8-1 1.7"/><path d="M12 17h.01"/>',
  ),
  info: svg('<circle cx="12" cy="12" r="9"/><path d="M12 11v5M12 8h.01"/>'),
  inventory_2: svg(
    '<rect x="3" y="7" width="18" height="13" rx="1.5"/><path d="M3 7l2-4h14l2 4M10 12h4"/>',
  ),
  key: svg('<circle cx="8" cy="14" r="3.5"/><path d="M10.5 11.5L20 2M17 5l2 2M14 8l2 2"/>'),
  left_panel: svg(
    '<rect x="3" y="3" width="18" height="18" rx="2"/><path d="M9 3v18M13 9l3 3-3 3"/>',
  ),
  light_mode: svg(
    '<circle cx="12" cy="12" r="4"/><path d="M12 2v3M12 19v3M4 12H1M23 12h-3M4.9 4.9l2.1 2.1M17 17l2.1 2.1M19.1 4.9L17 7M7 17l-2.1 2.1"/>',
  ),
  link: svg(
    '<path d="M9 15l6-6"/><path d="M8 17l-2 2a3.5 3.5 0 0 1-5-5l2-2M16 7l2-2a3.5 3.5 0 0 1 5 5l-2 2"/>',
  ),
  link_off: svg(
    '<path d="M3 3l18 18M8 17l-2 2a3.5 3.5 0 0 1-5-5l2-2M16 7l2-2a3.5 3.5 0 0 1 5 5l-2 2M9 15l1.5-1.5"/>',
  ),
  lock: svg(
    '<rect x="5" y="11" width="14" height="9" rx="1.5"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/>',
  ),
  mail: svg('<rect x="3" y="5" width="18" height="14" rx="1.5"/><path d="M3 6l9 7 9-7"/>'),
  more_vert: svg('<path d="M12 5h.01M12 12h.01M12 19h.01"/>'),
  person: svg('<circle cx="12" cy="8" r="3.5"/><path d="M5 20c1.5-4 4.5-6 7-6s5.5 2 7 6"/>'),
  policy: svg(
    '<path d="M12 3l7 3v6c0 4.5-3 7.5-7 9-4-1.5-7-4.5-7-9V6l7-3z"/><path d="M9 12l2 2 4-4"/>',
  ),
  public: svg(
    '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c2.5 2.5 3.5 5.8 3.5 9s-1 6.5-3.5 9c-2.5-2.5-3.5-5.8-3.5-9s1-6.5 3.5-9z"/>',
  ),
  radar: svg(
    '<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="5"/><path d="M12 12L18 6"/>',
  ),
  right_panel: svg(
    '<rect x="3" y="3" width="18" height="18" rx="2"/><path d="M15 3v18M11 9l-3 3 3 3"/>',
  ),
  save: svg('<path d="M5 3h11l3 3v15H5z"/><path d="M8 3v6h8V3M8 21v-7h8v7"/>'),
  search: svg('<circle cx="11" cy="11" r="7"/><path d="M21 21l-4.3-4.3"/>'),
  security_update_good: svg(
    '<path d="M12 3l7 3v6c0 4.5-3 7.5-7 9-4-1.5-7-4.5-7-9V6l7-3z"/><path d="M9.5 12l1.8 1.8 3.2-3.6"/>',
  ),
  shield: svg('<path d="M12 3l7 3v6c0 4.5-3 7.5-7 9-4-1.5-7-4.5-7-9V6l7-3z"/>'),
  shield_with_house: svg(
    '<path d="M12 3l7 3v6c0 4.5-3 7.5-7 9-4-1.5-7-4.5-7-9V6l7-3z"/><path d="M9 13v-2l3-2 3 2v2M10 13v2h4v-2"/>',
  ),
  smart_toy: svg(
    '<rect x="5" y="8" width="14" height="11" rx="2"/><path d="M12 4v4M9 13h.01M15 13h.01M9 17h6"/>',
  ),
  straighten: svg(
    '<rect x="3" y="9" width="18" height="6" rx="1"/><path d="M6 9v3M9 9v2M12 9v3M15 9v2M18 9v3"/>',
  ),
  swap_horiz: svg('<path d="M6 8h13l-4-4M18 16H5l4 4"/>'),
  sync: svg(
    '<path d="M4 12a8 8 0 0 1 14-5.3L20 8M20 12a8 8 0 0 1-14 5.3L4 16"/><path d="M18 4v4h-4M6 20v-4h4"/>',
  ),
  terminal: svg(
    '<rect x="3" y="4" width="18" height="16" rx="1.5"/><path d="M7 9l4 3-4 3M13 15h4"/>',
  ),
  toll: svg('<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="3.5"/>'),
  tune: svg(
    '<path d="M4 6h10M18 6h2M4 12h2M8 12h12M4 18h14M20 18h0"/><circle cx="16" cy="6" r="2"/><circle cx="6" cy="12" r="2"/><circle cx="18" cy="18" r="2"/>',
  ),
  upload_file: svg('<path d="M6 3h9l4 4v14H6z"/><path d="M12 17v-6M9.5 13.5L12 11l2.5 2.5"/>'),
  verified_user: svg(
    '<path d="M12 3l7 3v6c0 4.5-3 7.5-7 9-4-1.5-7-4.5-7-9V6l7-3z"/><path d="M9 12l2 2 4-4"/>',
  ),
  vpn_key: svg('<circle cx="7" cy="15" r="3.5"/><path d="M9.5 12.5L18 4M15 6l2 2M12 9l2 2"/>'),
  webhook: svg(
    '<path d="M6 17a4 4 0 1 1 3-6.6"/><path d="M11 8l4 7"/><circle cx="17" cy="16" r="3"/><circle cx="9" cy="10" r="2"/>',
  ),
  wifi: svg(
    '<path d="M2 8.5a16 16 0 0 1 20 0M5.5 12a11 11 0 0 1 13 0M9 15.5a6 6 0 0 1 6 0"/><path d="M12 19h.01"/>',
  ),
};

/** Returns the inline SVG for a glyph name, or an empty string for an unknown one. */
export function workbenchIcon(name: string): string {
  const icon = workbenchIcons[name];
  if (icon === undefined) throw new Error(`Unknown Workbench icon: ${name}`);
  return icon;
}
