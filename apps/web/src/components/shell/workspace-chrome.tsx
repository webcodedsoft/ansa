"use client";

import { PanelLeft } from "lucide-react";
import { usePathname } from "next/navigation";
import { useState, type ReactNode } from "react";

import { IconButton } from "@/components/ui";
import { cn } from "@/lib/cn";

import { CommandPalette } from "./command-palette";
import { DESTINATIONS } from "./navigation";
import { Sidebar } from "./sidebar";
import { ThemeToggle } from "./theme-toggle";

/**
 * The chrome around every signed-in page.
 *
 * Sidebar and top bar live in one client component because they share the
 * collapsed state. Splitting them would mean lifting that state into a context
 * or the URL, and neither is worth it for a boolean that nothing else reads.
 *
 * Everything below the header scrolls; the chrome does not. That is the whole
 * reason it is glass — content passing under a fixed pane is what the material
 * is for, and a page that scrolled the window would slide it off the top.
 */
export const WorkspaceChrome = ({
  organisation,
  user,
  role,
  capabilities,
  counts,
  signOut,
  children,
}: {
  readonly organisation: string;
  readonly user: string;
  readonly role: string;
  readonly capabilities: readonly string[];
  readonly counts?: Readonly<Record<string, number>>;
  readonly signOut: () => Promise<void>;
  readonly children: ReactNode;
}) => {
  const [collapsed, setCollapsed] = useState(false);
  const pathname = usePathname();

  /* Longest matching destination wins, so `/agents/new` reads as "Build an
     agent" rather than "All agents" — a breadcrumb that names the wrong page
     is worse than none. */
  const here = [...DESTINATIONS]
    .filter((d) => pathname === d.href || pathname.startsWith(`${d.href}/`))
    .sort((a, b) => b.href.length - a.href.length)[0];

  return (
    <div
      className={cn(
        "relative z-10 grid h-screen grid-cols-1 transition-[grid-template-columns] duration-200",
        collapsed ? "sm:grid-cols-[68px_minmax(0,1fr)]" : "sm:grid-cols-[244px_minmax(0,1fr)]",
      )}
    >
      <div className="hidden min-h-0 sm:block">
        <Sidebar
          organisation={organisation}
          user={user}
          role={role}
          capabilities={capabilities}
          counts={counts}
          signOut={signOut}
          collapsed={collapsed}
        />
      </div>

      <div className="flex min-h-0 min-w-0 flex-col">
        <header className="glass flex h-14 flex-none items-center gap-2.5 rounded-none border-x-0 border-t-0 px-[18px]">
          <IconButton
            onClick={() => setCollapsed((was) => !was)}
            aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
            title={collapsed ? "Expand sidebar" : "Collapse sidebar"}
            className="hidden sm:grid"
          >
            <PanelLeft className="size-4" />
          </IconButton>

          <nav aria-label="Breadcrumb" className="flex min-w-0 items-center gap-2 text-[13px]">
            <span className="truncate text-[var(--ink-3)]">{organisation}</span>
            {here !== undefined && (
              <>
                <span aria-hidden className="text-[var(--ink-3)] opacity-50">
                  /
                </span>
                <span className="truncate font-medium">{here.label}</span>
              </>
            )}
          </nav>

          <span className="flex-1" />
          <CommandPalette capabilities={capabilities} />
          <ThemeToggle />
        </header>

        <main className="min-h-0 flex-1 overflow-y-auto">
          {/* Every page reads at a column width, except a canvas: a drawing surface inside
              1080 pixels is a drawing surface nobody can see, which is why the flow builder
              left the workspace's tabs for a page of its own. The route says which it is. */}
          <div
            className={cn(
              "ansa-enter mx-auto px-9 pt-9 pb-24",
              /\/agents\/[^/]+\/flow$/.test(pathname) ? "max-w-[1600px]" : "max-w-[1080px]",
            )}
          >
            {children}
          </div>
        </main>
      </div>
    </div>
  );
};
