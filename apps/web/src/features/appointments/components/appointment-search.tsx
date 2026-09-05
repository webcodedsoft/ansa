import { Search } from "lucide-react";

import { CONTROL } from "@/components/ui";
import { cn } from "@/lib/cn";

/**
 * Find an appointment by name, without knowing which week it is in.
 *
 * A plain GET form rather than a client component: the query belongs in the URL like every
 * other piece of this page's state, so a search is a link, the back button leaves it, and the
 * results are server-rendered with everything else. It also means the box works before any
 * JavaScript has loaded, which a search box on a busy desk should.
 *
 * The calendar id rides along so that clearing the search returns you to the calendar you were
 * reading rather than to whichever one happens to sort first.
 */
export const AppointmentSearch = ({
  calendarId,
  query,
}: {
  readonly calendarId: string;
  readonly query: string;
}) => (
  <form action="/appointments" method="get" className="relative" role="search">
    <input type="hidden" name="calendar" value={calendarId} />
    <Search
      aria-hidden
      className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-[var(--ink-3)]"
    />
    <input
      type="search"
      name="q"
      defaultValue={query}
      placeholder="Search appointments"
      aria-label="Search appointments"
      className={cn(CONTROL, "h-8 w-[200px] pl-8 text-[12.5px]")}
    />
  </form>
);
