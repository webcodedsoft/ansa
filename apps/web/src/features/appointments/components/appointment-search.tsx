import { SearchField } from "@/components/ui";

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
  <form action="/appointments" method="get" className="w-[220px]" role="search">
    <input type="hidden" name="calendar" value={calendarId} />
    <SearchField label="Search appointments" size="sm" name="q" defaultValue={query} placeholder="Search appointments" />
  </form>
);
