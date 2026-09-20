import { useCallback, useEffect, useState } from "react";

/**
 * Light or dark, as the prototype's `screens/mode.js`:
 * `<html class="dark|light" data-mode="…">`. `?mode=light|dark` wins, then the
 * last choice remembered under `wb-mode`, then dark. Storage can throw or be
 * empty, so every access is guarded and the page renders correctly without it.
 */
export type WorkbenchMode = "dark" | "light";

const STORAGE_KEY = "wb-mode";

function remembered(): WorkbenchMode | undefined {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    return saved === "light" || saved === "dark" ? saved : undefined;
  } catch {
    return undefined;
  }
}

function requested(): WorkbenchMode | undefined {
  const asked = new URLSearchParams(location.search).get("mode");
  return asked === "light" || asked === "dark" ? asked : undefined;
}

function remember(mode: WorkbenchMode): void {
  try {
    localStorage.setItem(STORAGE_KEY, mode);
  } catch {
    // A private window or blocked site data: the page still works.
  }
}

function apply(mode: WorkbenchMode): void {
  const root = document.documentElement;
  root.classList.toggle("dark", mode === "dark");
  root.classList.toggle("light", mode !== "dark");
  root.dataset.mode = mode;
}

export function useWorkbenchMode(): {
  mode: WorkbenchMode;
  label: string;
  toggle: () => void;
} {
  const [mode, setMode] = useState<WorkbenchMode>(() => requested() ?? remembered() ?? "dark");
  useEffect(() => {
    apply(mode);
  }, [mode]);
  const toggle = useCallback(() => {
    setMode((current) => {
      const next: WorkbenchMode = current === "dark" ? "light" : "dark";
      remember(next);
      return next;
    });
  }, []);
  return {
    mode,
    label: mode === "dark" ? "Switch to light mode" : "Switch to dark mode",
    toggle,
  };
}
