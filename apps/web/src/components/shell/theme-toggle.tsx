"use client";

import { Moon, Sun } from "lucide-react";
import { useEffect, useState } from "react";

import { IconButton } from "@/components/ui";

/**
 * Light and dark.
 *
 * It reads the current state rather than inferring it. An earlier version
 * compared the computed `--bg` against a hard-coded hex; when the palette was
 * retuned that string went stale, the comparison was false forever, and the
 * button could only ever set dark. State is on the root element, and with no
 * explicit choice the system preference is the truth.
 */
export const ThemeToggle = () => {
  const [dark, setDark] = useState(false);

  useEffect(() => {
    const chosen = document.documentElement.getAttribute("data-theme");
    setDark(chosen === null ? window.matchMedia("(prefers-color-scheme: dark)").matches : chosen === "dark");
  }, []);

  const flip = () => {
    const next = dark ? "light" : "dark";
    document.documentElement.setAttribute("data-theme", next);
    setDark(!dark);
  };

  return (
    <IconButton
      onClick={flip}
      title={dark ? "Switch to light" : "Switch to dark"}
      aria-label={dark ? "Switch to light" : "Switch to dark"}
    >
      {dark ? <Sun className="size-4" /> : <Moon className="size-4" />}
    </IconButton>
  );
};
