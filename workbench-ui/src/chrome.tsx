import * as Dialog from "@radix-ui/react-dialog";
import { type ReactNode, useId } from "react";

/**
 * The chrome both pages share, in the prototype's design: the 44px header of
 * `prototype/policy-workbench/screens/shell.js` (`HEAD`), its 32px sub-header
 * strip (`SUB`), the 240px nav rail (`NAV`), the segmented control of
 * `screens/user-trim.html` (`seg`), and the card shell of
 * `screens/admin-sources.html`. Class strings are the prototype's.
 */

export const HEADER =
  "h-11 w-full bg-surface-container-lowest border-b border-surface-container-high/60 px-3 flex items-center justify-between z-50 shrink-0";
export const SUB_HEADER =
  "min-h-8 py-1.5 bg-surface-container-lowest/90 border-b border-surface-container-high/40 px-3 flex items-start gap-2.5 text-[11px] shrink-0";
export const RAIL =
  "shrink-0 w-60 bg-[#0a0e15] border-r border-surface-container-high/60 flex flex-col overflow-hidden";
export const RAIL_HEADING =
  "px-2 py-0.5 text-[10px] font-mono tracking-wider text-outline uppercase font-semibold flex items-center justify-between";
export const MASTHEAD =
  "px-5 py-2 border-b border-surface-container-high/40 bg-[#0e131d] flex flex-wrap items-center justify-between gap-2 shrink-0 text-[11.5px]";
export const CARD_GRID = "grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3";
export const CARD =
  "group rounded border border-surface-container-high/60 bg-[#141822] p-3 flex flex-col justify-between hover:border-primary transition-all shadow-xs";
export const CARD_TITLE = "font-mono font-bold text-white text-[13px] tracking-tight truncate";
export const KIND_CHIP =
  "px-1.5 py-0.5 rounded bg-surface-container-low border border-surface-container-high/40 text-[8.5px] font-mono text-outline/90 uppercase shrink-0";
export const CARD_FOOTER =
  "pt-2.5 mt-2.5 border-t border-surface-container-high/40 flex items-center justify-between gap-2 text-[10px]";
export const PRIMARY_BUTTON =
  "flex items-center gap-1 px-3 py-1 rounded bg-primary hover:bg-primary-bright text-white text-[12px] font-medium transition-colors shadow-xs disabled:opacity-50 disabled:cursor-not-allowed";
export const SECONDARY_BUTTON =
  "px-2.5 py-1 rounded bg-surface-container hover:bg-surface-container-high text-on-surface text-[12px] font-medium transition-colors disabled:opacity-50 disabled:cursor-not-allowed";
export const GHOST_BUTTON =
  "flex items-center gap-1 px-2 py-1 rounded hover:bg-surface-container text-on-surface-variant hover:text-on-surface text-[11px] transition-colors disabled:opacity-50 disabled:cursor-not-allowed";
export const TEXT_INPUT =
  "h-6 px-2 py-0 leading-6 rounded bg-[#141822] border border-surface-container-high/60 font-mono text-on-surface text-[11px] focus:border-primary focus:outline-none focus:ring-0";
export const PILL =
  "text-[10px] font-mono uppercase tracking-wider px-1.5 py-0.5 rounded bg-surface-container-highest text-on-surface-variant font-medium";
export const PANEL_HEADING = "font-semibold text-on-surface text-[13px]";
export const FACTS =
  "rounded bg-surface-container-low border border-surface-container-high/40 divide-y divide-surface-container-high/40";
export const FACT_ROW = "flex justify-between gap-2 px-2.5 py-1.5";

/** The identity block of `HEAD`: the mark, "aih Policy", and the door chip. */
export function Identity({ door }: { readonly door: string }) {
  return (
    <div className="flex items-center gap-2 pr-1">
      <div className="w-5 h-5 rounded bg-primary flex items-center justify-center shadow-sm">
        <span aria-hidden="true" className="material-symbols-outlined text-white text-[14px]">
          shield_with_house
        </span>
      </div>
      <span className="font-semibold text-[13px] tracking-tight text-on-surface">aih Policy</span>
      <span className={PILL}>{door}</span>
    </div>
  );
}

export function Divider() {
  return <div className="h-3.5 w-px bg-surface-container-high mx-0.5" />;
}

export interface SegmentedOption<T extends string> {
  readonly value: T;
  readonly label: string;
}

/**
 * The prototype's segmented control (`user-trim.html`, `seg`), as a
 * `radiogroup` so the choice is one named group in the accessibility tree.
 */
export function Segmented<T extends string>({
  label,
  value,
  options,
  onChange,
  size = "md",
}: {
  readonly label: string;
  readonly value: T;
  readonly options: readonly SegmentedOption<T>[];
  readonly onChange: (value: T) => void;
  readonly size?: "sm" | "md";
}) {
  const pad = size === "sm" ? "px-2 py-0.5 text-[10.5px]" : "px-2.5 py-1 text-[11px]";
  const group = useId();
  return (
    <div
      aria-label={label}
      className="flex items-center bg-surface-container-lowest p-0.5 rounded border border-surface-container-high/60 shrink-0"
      role="radiogroup"
    >
      {options.map((option) => {
        const active = option.value === value;
        return (
          <label
            className={`${pad} rounded transition-colors cursor-pointer ${
              active
                ? "bg-surface-container text-primary font-semibold shadow-xs"
                : "text-on-surface-variant hover:text-on-surface hover:bg-surface-container"
            }`}
            key={option.value}
          >
            <input
              checked={active}
              className="sr-only"
              name={group}
              onChange={() => onChange(option.value)}
              type="radio"
              value={option.value}
            />
            {option.label}
          </label>
        );
      })}
    </div>
  );
}

/**
 * A flyout: a Radix modal dialog, so it opens from the keyboard, holds focus,
 * closes on Escape and returns focus to its trigger.
 */
export function Flyout({
  title,
  description,
  trigger,
  open,
  onOpenChange,
  children,
}: {
  readonly title: string;
  readonly description: string;
  readonly trigger: ReactNode;
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly children: ReactNode;
}) {
  const descriptionId = useId();
  return (
    <Dialog.Root onOpenChange={onOpenChange} open={open}>
      <Dialog.Trigger asChild>{trigger}</Dialog.Trigger>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 bg-black/50" />
        <Dialog.Content
          aria-describedby={descriptionId}
          className="fixed left-1/2 top-1/2 w-[min(640px,calc(100vw-32px))] max-h-[85vh] -translate-x-1/2 -translate-y-1/2 overflow-y-auto p-3 rounded bg-surface-container-lowest border border-surface-container-high/60 shadow-2xl space-y-2 text-[11.5px]"
        >
          <Dialog.Title className={PANEL_HEADING}>{title}</Dialog.Title>
          <Dialog.Description className="text-[10.5px] text-outline" id={descriptionId}>
            {description}
          </Dialog.Description>
          {children}
          <div className="flex justify-end pt-1">
            <Dialog.Close asChild>
              <button className={GHOST_BUTTON} type="button">
                Close
              </button>
            </Dialog.Close>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

/**
 * The sub-header strip's message region. An accepted outcome is a status, a
 * refusal an alert; both are always plain text.
 */
export function MessageStrip({
  outcome,
}: {
  readonly outcome: { readonly ok: boolean; readonly message: string } | undefined;
}) {
  const refusal = outcome?.ok === false ? outcome.message : "";
  const status = outcome?.ok === true ? outcome.message : "";
  return (
    <>
      <span className="font-mono uppercase tracking-wider text-[10px] text-outline font-semibold">
        Status
      </span>
      {/* A message is read in full: it grows the strip and is never cut off. */}
      <span className="min-w-0 text-secondary [overflow-wrap:anywhere]" role="status">
        {status}
      </span>
      <span className="min-w-0 text-tertiary [overflow-wrap:anywhere]" role="alert">
        {refusal}
      </span>
    </>
  );
}

/** The prototype's theme button (`HEAD`), labelled by where it takes you. */
export function ModeToggle({
  label,
  onToggle,
}: {
  readonly label: string;
  readonly onToggle: () => void;
}) {
  return (
    <button
      aria-label={label}
      className="p-1 rounded bg-surface-container-low hover:bg-surface-container border border-surface-container-high/60 text-on-surface-variant hover:text-on-surface transition-colors flex items-center justify-center shadow-xs"
      onClick={onToggle}
      title={label}
      type="button"
    >
      <span aria-hidden="true" className="material-symbols-outlined text-[15px]">
        light_mode
      </span>
    </button>
  );
}

/** A control a host cannot perform: always the words, never a dead control. */
export function UnavailableControl({
  label,
  reason,
}: {
  readonly label: string;
  readonly reason: string;
}) {
  const reasonId = useId();
  return (
    <span className="flex items-center gap-1.5">
      <button aria-describedby={reasonId} className={GHOST_BUTTON} disabled type="button">
        {label}
      </button>
      <span className="text-[10px] text-outline" id={reasonId}>
        {reason}
      </span>
    </span>
  );
}
