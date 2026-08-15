"use client";

import { ChevronLeft, ChevronRight, Loader2 } from "lucide-react";
import Link, { useLinkStatus } from "next/link";
import { useRouter } from "next/navigation";
import { useTransition, type ReactNode } from "react";

import { cn } from "@/lib/cn";
import { DEFAULT_PAGE_SIZE, PAGE_SIZES } from "@/lib/paging";

/**
 * Page-numbered pagination.
 *
 * The whole state is the URL — `?page=3&perPage=50` plus whatever filter was already
 * there — so a paginated, filtered view is a link somebody can send, refresh survives it,
 * and the back button behaves. That is also why `params` matters: every pager here used to
 * build its href from scratch and drop the filters, so paging a filtered list quietly
 * showed page two of everything.
 *
 * What it deliberately does not do: infinite scroll (you lose your place and cannot link
 * to a row), "load more" (makes the total meaningless and breaks the back button), or a
 * sticky bar (steals height from the rows it is meant to serve).
 */

/**
 * Which page numbers to draw.
 *
 * Always the first and last, always the current with a neighbour either side, and a gap
 * where numbers were left out. Drawing all of them is fine at four pages and unusable at
 * four hundred; the window keeps the control the same width either way.
 */
export const pageWindow = (current: number, total: number): readonly (number | "gap")[] => {
  if (total <= 7) return Array.from({ length: total }, (_, i) => i + 1);

  const pages = new Set<number>([1, total, current, current - 1, current + 1]);
  const shown = [...pages].filter((page) => page >= 1 && page <= total).sort((a, b) => a - b);

  const out: (number | "gap")[] = [];
  let previous = 0;
  for (const page of shown) {
    // A gap of exactly one is not worth an ellipsis — draw the number it would hide.
    if (page - previous === 2) out.push(previous + 1);
    else if (page - previous > 2) out.push("gap");
    out.push(page);
    previous = page;
  }
  return out;
};

type Params = Readonly<Record<string, string | number | boolean | undefined>>;

const buildHref = (basePath: string, params: Params | undefined, next: Params): string => {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries({ ...params, ...next })) {
    if (value === undefined || value === "") continue;
    query.set(key, String(value));
  }
  const search = query.toString();
  return search === "" ? basePath : `${basePath}?${search}`;
};

/**
 * Swaps a link's own label for a spinner while that link is navigating.
 *
 * `useLinkStatus` reports the enclosing `Link`'s pending state, so the feedback lands on
 * the control that was actually clicked rather than on the whole pager. Server-side paging
 * has real latency; without this a click looks like nothing happened.
 */
const LinkLabel = ({ children }: { readonly children: ReactNode }) => {
  const { pending } = useLinkStatus();
  return pending ? <Loader2 aria-hidden className="size-3.5 animate-spin" /> : <>{children}</>;
};

const STEP =
  "inline-flex h-8 items-center gap-1 rounded-lg border border-[var(--hairline)] px-2.5 text-[13px] font-medium transition-colors";

export const Pagination = ({
  basePath,
  page,
  perPage,
  totalPages,
  total,
  params,
  unit = "rows",
}: {
  readonly basePath: string;
  readonly page: number;
  readonly perPage: number;
  readonly totalPages: number;
  readonly total: number;
  /** The current query. `page` and `perPage` are replaced, everything else carried. */
  readonly params?: Params;
  readonly unit?: string;
}) => {
  const router = useRouter();
  const [resizing, startResize] = useTransition();

  const href = (to: number) =>
    // Page one is the default, so it stays out of the URL — a clean link for the common case.
    buildHref(basePath, params, { page: to === 1 ? undefined : to });

  // A range, not just a count: "26–50 of 63" says where you are as well as how much
  // there is, which two separate numbers never quite manage.
  const first = total === 0 ? 0 : (page - 1) * perPage + 1;
  const last = Math.min(page * perPage, total);
  const range =
    total === 0 ? `No ${unit}` : `${first}–${last} of ${total} ${unit}`;

  const changeSize = (size: number) => {
    startResize(() => {
      router.push(
        buildHref(basePath, params, {
          // Back to page one: page three of a list that just changed size is not a place.
          page: undefined,
          // And the default size stays out of the URL for the same reason page one
          // does. Writing `?perPage=10` when ten is what you get anyway would give
          // the default view two addresses.
          perPage: size === DEFAULT_PAGE_SIZE ? undefined : size,
        }),
      );
    });
  };

  return (
    <nav
      aria-label="Pagination"
      className="mt-3.5 flex flex-wrap items-center justify-between gap-3"
    >
      <p className="text-xs tabular-nums text-[var(--ink-3)]" aria-live="polite">
        {range}
      </p>

      {totalPages > 1 && (
        <div className="flex flex-wrap items-center gap-2">
          {page > 1 ? (
            <Link href={href(page - 1)} rel="prev" className={cn(STEP, "hover:border-[var(--ink-3)]")}>
              <LinkLabel>
                <ChevronLeft aria-hidden className="size-3.5" />
                Previous
              </LinkLabel>
            </Link>
          ) : (
            <span className={cn(STEP, "cursor-not-allowed opacity-45")} aria-disabled="true">
              <ChevronLeft aria-hidden className="size-3.5" />
              Previous
            </span>
          )}

          <ol className="flex items-center gap-1">
            {pageWindow(page, totalPages).map((entry, index) =>
              entry === "gap" ? (
                <li key={`gap-${index}`} aria-hidden className="px-1 text-[13px] text-[var(--ink-3)]">
                  …
                </li>
              ) : (
                <li key={entry}>
                  <Link
                    href={href(entry)}
                    aria-current={entry === page ? "page" : undefined}
                    aria-label={`Page ${entry}`}
                    className={cn(
                      "inline-flex h-8 min-w-8 items-center justify-center rounded-lg border px-2 text-[13px] tabular-nums transition-colors",
                      entry === page
                        ? "border-transparent bg-[var(--accent)] font-semibold text-[var(--accent-on)]"
                        : "border-[var(--hairline)] text-[var(--ink-2)] hover:border-[var(--ink-3)] hover:text-[var(--ink)]",
                    )}
                  >
                    <LinkLabel>{entry}</LinkLabel>
                  </Link>
                </li>
              ),
            )}
          </ol>

          {page < totalPages ? (
            <Link href={href(page + 1)} rel="next" className={cn(STEP, "hover:border-[var(--ink-3)]")}>
              <LinkLabel>
                Next
                <ChevronRight aria-hidden className="size-3.5" />
              </LinkLabel>
            </Link>
          ) : (
            <span className={cn(STEP, "cursor-not-allowed opacity-45")} aria-disabled="true">
              Next
              <ChevronRight aria-hidden className="size-3.5" />
            </span>
          )}
        </div>
      )}

      {total > PAGE_SIZES[0] && (
        <label className="flex items-center gap-2 text-xs text-[var(--ink-3)]">
          Per page
          <select
            value={perPage}
            disabled={resizing}
            onChange={(event) => changeSize(Number(event.target.value))}
            className="h-8 rounded-lg border border-[var(--hairline)] bg-[var(--surface-2)] px-2 text-[13px] text-[var(--ink)] tabular-nums disabled:opacity-55"
          >
            {PAGE_SIZES.map((size) => (
              <option key={size} value={size}>
                {size}
              </option>
            ))}
          </select>
        </label>
      )}
    </nav>
  );
};
