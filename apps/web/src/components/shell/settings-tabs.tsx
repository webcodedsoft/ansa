"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

import { cn } from "@/lib/cn";

import { settingsDestinations } from "./navigation";

/**
 * The strip across the top of every Settings page.
 *
 * Links, not the in-place `Tabs` component: each of these is its own page with its own
 * data, and a tab that navigates is the honest shape for that. The same `Destination`
 * list the sidebar and the palette read, filtered by capability, so a page a caller may
 * not open is not a tab they can click.
 */
export const SettingsTabs = ({ capabilities }: { readonly capabilities: readonly string[] }) => {
  const pathname = usePathname();
  const tabs = settingsDestinations(capabilities);
  return (
    <nav
      aria-label="Settings"
      className="mb-5 flex gap-0.5 overflow-x-auto overflow-y-hidden border-b border-[var(--hairline)]"
    >
      {tabs.map((tab) => {
        const on = pathname === tab.href || pathname.startsWith(`${tab.href}/`);
        return (
          <Link
            key={tab.href}
            href={tab.href}
            aria-current={on ? "page" : undefined}
            className={cn(
              "-mb-px border-b-2 px-3 pt-1 pb-2.5 text-[13px] whitespace-nowrap transition-colors",
              on
                ? "border-[var(--accent)] font-medium text-[var(--ink)]"
                : "border-transparent text-[var(--ink-3)] hover:text-[var(--ink-2)]",
            )}
          >
            {tab.label}
          </Link>
        );
      })}
    </nav>
  );
};
