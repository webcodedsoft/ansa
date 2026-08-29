"use client";

import { Search } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";

import { useProgressStore } from "@/stores/progress.store";
import { cn } from "@/lib/cn";

import { allowedDestinations, type Destination } from "./navigation";

/**
 * ⌘K.
 *
 * Past about ten destinations, searching beats scanning — and this console is
 * built for sixteen and growing. It reads the same list the sidebar renders,
 * so a new section becomes searchable the moment it becomes navigable.
 */
export const CommandPalette = ({ capabilities }: { readonly capabilities: readonly string[] }) => {
  const router = useRouter();
  const beginNavigation = useProgressStore((store) => store.beginNavigation);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [at, setAt] = useState(0);

  const all = allowedDestinations(capabilities);
  const needle = query.trim().toLowerCase();
  const results: readonly Destination[] =
    needle === "" ? all : all.filter((d) => `${d.label} ${d.group}`.toLowerCase().includes(needle));

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setOpen((was) => !was);
        setQuery("");
        setAt(0);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const goTo = (href: string) => {
    setOpen(false);
    /* Chosen with the keyboard, so no anchor was clicked and the document listener sees
       nothing. Started by hand here; the URL change releases it like any other. */
    beginNavigation();
    router.push(href);
  };

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="flex h-[30px] items-center gap-2 rounded-[4px] border border-[var(--hairline)] bg-[var(--glass-lo)] px-2.5 text-[12.5px] text-[var(--ink-3)] transition-colors hover:bg-[var(--glass-hi)] hover:text-[var(--ink-2)]"
      >
        <Search className="size-3.5" />
        Search
        <kbd className="rounded border border-[var(--hairline)] bg-[var(--surface-2)] px-1.5 py-px font-mono text-[10.5px]">
          ⌘K
        </kbd>
      </button>

      {open && (
        <div
          className="fixed inset-0 z-50 grid place-items-start justify-center bg-[rgb(4_10_12/42%)] pt-[14vh] backdrop-blur-[3px]"
          onClick={(e) => {
            if (e.target === e.currentTarget) setOpen(false);
          }}
        >
          <div
            role="dialog"
            aria-modal="true"
            aria-label="Search"
            className="ansa-enter w-[min(100%-2rem,560px)] overflow-hidden rounded-xl border border-[var(--hairline)] bg-[var(--glass-hi)] shadow-[var(--shadow-l),var(--spec)] backdrop-blur-[40px] backdrop-saturate-200"
          >
            <input
              autoFocus
              value={query}
              placeholder="Search calls, numbers, settings…"
              onChange={(e) => {
                setQuery(e.target.value);
                setAt(0);
              }}
              onKeyDown={(e) => {
                if (e.key === "Escape") setOpen(false);
                else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
                  e.preventDefault();
                  if (results.length === 0) return;
                  setAt((n) => (n + (e.key === "ArrowDown" ? 1 : -1) + results.length) % results.length);
                } else if (e.key === "Enter") {
                  e.preventDefault();
                  const hit = results[at];
                  if (hit !== undefined) goTo(hit.href);
                }
              }}
              className="w-full border-b border-[var(--hairline)] bg-transparent px-[18px] py-4 text-[15px] outline-none"
            />
            <div className="max-h-[340px] overflow-y-auto p-1.5">
              {results.length === 0 ? (
                <p className="p-6 text-center text-[13px] text-[var(--ink-3)]">Nothing matches</p>
              ) : (
                results.map((d, i) => (
                  <button
                    key={d.href}
                    type="button"
                    onMouseEnter={() => setAt(i)}
                    onClick={() => goTo(d.href)}
                    className={cn(
                      "flex w-full items-center gap-2.5 rounded-lg px-3 py-2.5 text-left text-[13.5px] transition-colors",
                      i === at ? "bg-[var(--glass-hi)] text-[var(--ink)]" : "text-[var(--ink-2)]",
                    )}
                  >
                    <span>{d.label}</span>
                    <span className="ml-auto text-[11px] text-[var(--ink-3)]">{d.group}</span>
                  </button>
                ))
              )}
            </div>
          </div>
        </div>
      )}
    </>
  );
};
