import { ListFilter, PhoneOutgoing } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";

import { Button, PageHeader, Pagination, SelectField, TextField } from "@/components/ui";
import { cn } from "@/lib/cn";
import { readPaging } from "@/lib/paging";
import { currentConfiguration, soleLiveAgentId } from "@/features/agents/agents.service";
import { listCalls, type CallFilters } from "@/features/calls/calls.service";
import { CallTable } from "@/features/calls/components/call-table";
import { TestCallForm } from "@/features/calls/components/test-call-form";

export const metadata: Metadata = { title: "Calls · Ansa" };
export const dynamic = "force-dynamic";

/** The endings the API writes; the filter offers exactly these and no others. */
const END_REASONS = ["completed", "caller hung up", "transferred", "voicemail", "no-answer", "busy", "failed"];

/**
 * Declared as a type alias, not an interface, and that is load-bearing:
 * TypeScript gives a type alias an implicit index signature and an interface
 * none, so only this form can be handed to `Pagination`'s `params`. A cast
 * would have silenced the error without making it true.
 */
type CallsSearch = {
  readonly page?: string;
  readonly perPage?: string;
  /** Present when the filter panel is open. The URL is the whole state. */
  readonly filter?: string;
  readonly endReason?: string;
  readonly caller?: string;
  readonly dialled?: string;
  readonly from?: string;
  readonly to?: string;
};

/**
 * Page numbers, and the filter, both live in the URL.
 *
 * No client state on either: `?page=3&endReason=transferred` is the whole thing, so a
 * filtered view is a link somebody can send and the back button behaves. It also means
 * paging cannot lose the filters, which is exactly what the previous hand-rolled pager did.
 *
 * Page numbers over the cursor this used to use is a real trade. These lists are
 * newest-first and constantly written to, so a call arriving between page one and page two
 * shifts every row down and a reader can see the same row twice — a keyset never did that.
 * What it could not do is say how many calls there are, or take somebody to page four.
 */
const CallsPage = async ({
  searchParams,
}: {
  readonly searchParams: Promise<CallsSearch>;
}) => {
  const search = await searchParams;
  const requested = readPaging(search);

  const filters: CallFilters = {
    page: requested.page,
    perPage: requested.perPage,
    endReason: search.endReason,
    caller: search.caller,
    dialled: search.dialled,
    from: search.from,
    to: search.to,
  };
  /* Both in flight at once: the version is a caption on the toolbar, not a
     dependency of the list, so making the list wait for it would be a second
     round trip for one number. `allSettled` because a caption is not worth
     failing the page over. */
  /* The caption names the configuration a test call would run on, and it is the only thing
     this version feeds — `TestCallForm` below. So resolving the organisation's single live
     agent here is not an assumption papering over a gap: it is the same resolution
     `POST /testcall` performs server-side, and showing a different agent's version would be
     the bug. It stops being right the day the test call grows an agent picker, and both
     halves move together. */
  const captionAgent = await soleLiveAgentId().catch(() => null);
  const [calls, configuration] = await Promise.allSettled([
    listCalls(filters),
    captionAgent === null ? Promise.reject(new Error("no live agent")) : currentConfiguration(captionAgent),
  ]);
  if (calls.status === "rejected") throw calls.reason;
  const { items, page: pageNumber, perPage, totalPages, total } = calls.value;
  const configVersion = configuration.status === "fulfilled" ? configuration.value.version : undefined;
  const activeFilters = [search.endReason, search.caller, search.dialled, search.from, search.to]
    .filter((value) => value !== undefined && value !== "").length;
  // Open when asked for, and open on its own when something is filtering —
  // otherwise a filtered list looks unfiltered and the badge is the only clue.
  const filterOpen = search.filter === "1" || activeFilters > 0;

  return (
    <>
      <PageHeader
        eyebrow="Operate"
        title="Calls"
        meta="Every call this organisation has answered or placed, newest first."
        actions={
          <>
            {/* Anchors, not buttons: filtering is a URL and the test call is a
                control already on the page. A button that only scrolls to
                another control would be a second way to do one thing. */}
            <Link
              href={filterOpen ? "/calls" : "/calls?filter=1"}
              className={cn(
                "inline-flex h-[34px] items-center gap-2 rounded-lg border px-3.5 text-sm font-medium shadow-[var(--spec)]",
                activeFilters > 0
                  ? "border-[color-mix(in_srgb,var(--accent)_34%,transparent)] bg-[var(--accent-soft)] text-[var(--accent)]"
                  : "border-[var(--hairline)] bg-[var(--glass-hi)]",
              )}
            >
              <ListFilter aria-hidden className="size-4" />
              {activeFilters > 0 ? `${activeFilters} active` : "Filter"}
            </Link>
            {/* Submits the toolbar's form from up here. No client state is
                needed for that — `form` is a plain HTML attribute. */}
            <button
              type="submit"
              form="test-call-form"
              className="inline-flex h-[34px] items-center gap-2 rounded-lg border border-transparent bg-[linear-gradient(178deg,color-mix(in_srgb,var(--accent)_88%,#fff),var(--accent))] px-3.5 text-sm font-semibold text-[var(--accent-on)] shadow-[inset_0_1px_0_rgb(255_255_255/34%),0_1px_2px_rgb(6_20_26/22%),0_8px_20px_-8px_color-mix(in_srgb,var(--accent)_66%,transparent)]"
            >
              <PhoneOutgoing aria-hidden className="size-4" />
              Test call
            </button>
          </>
        }
      />

      <div className="flex flex-col gap-3.5">
        <TestCallForm configVersion={configVersion} />

        {filterOpen && (
          <form method="get" id="filter" className="glass scroll-mt-6 rounded-[18px] p-4">
            {/* Keeps the panel open across a submit, so applying one filter and
                then adding a second does not collapse it in between. */}
            <input type="hidden" name="filter" value="1" />
            <div className="grid gap-3.5 sm:grid-cols-2 lg:grid-cols-3">
              <SelectField label="Ended because" name="endReason" defaultValue={search.endReason ?? ""}>
                <option value="">Any</option>
                {END_REASONS.map((reason) => (
                  <option key={reason} value={reason}>
                    {reason}
                  </option>
                ))}
              </SelectField>
              <TextField label="Caller" name="caller" type="tel" placeholder="+234…" defaultValue={search.caller ?? ""} />
              <TextField label="Dialled" name="dialled" type="tel" placeholder="+234…" defaultValue={search.dialled ?? ""} />
              <TextField label="From" name="from" type="date" defaultValue={search.from ?? ""} />
              <TextField
                label="To"
                name="to"
                type="date"
                defaultValue={search.to ?? ""}
                hint="Exclusive, so consecutive ranges never share a call."
              />
              <div className="flex items-end gap-2">
                <Button type="submit" variant="primary">
                  Apply
                </Button>
                <Link
                  href="/calls"
                  className="inline-flex h-[34px] items-center rounded-lg px-3 text-sm text-[var(--ink-3)] hover:text-[var(--ink)]"
                >
                  Clear
                </Link>
              </div>
            </div>
          </form>
        )}

        <CallTable calls={items} />
      </div>

      <Pagination
        basePath="/calls"
        page={pageNumber}
        perPage={perPage}
        totalPages={totalPages}
        total={total}
        unit="calls"
        params={search}
      />
    </>
  );
};

export default CallsPage;
