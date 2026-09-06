import { cn } from "@/lib/cn";

import type { CampaignWindow } from "../campaigns.service";

/** Monday first, because a working week reads that way; the value is the API's own 0–6. */
const DAYS: readonly { readonly value: number; readonly label: string; readonly full: string }[] = [
  { value: 1, label: "M", full: "Monday" },
  { value: 2, label: "T", full: "Tuesday" },
  { value: 3, label: "W", full: "Wednesday" },
  { value: 4, label: "T", full: "Thursday" },
  { value: 5, label: "F", full: "Friday" },
  { value: 6, label: "S", full: "Saturday" },
  { value: 0, label: "S", full: "Sunday" },
];

/**
 * The bound every outbound call is held to, whatever a campaign asks for.
 *
 * Null is not "no window" — it is this. Drawn rather than described, so a campaign that set
 * nothing looks like what it is: the full permitted day, every day.
 */
const DEFAULT_WINDOW = { startHour: 8, endHour: 20, weekdays: [0, 1, 2, 3, 4, 5, 6] } as const;

const pad = (hour: number): string => `${String(hour).padStart(2, "0")}:00`;

/**
 * When this campaign may ring, as seven columns of the day.
 *
 * A sentence — "09:00–17:00 WAT, weekdays" — is accurate and takes a moment to picture. The
 * shape does not: a glance says how much of the day is open and which days are shut, and two
 * campaigns side by side are comparable without reading either.
 *
 * Each column is midnight to midnight, top to bottom, with the permitted hours filled. That
 * is the honest projection of the data — `startHour` and `endHour` are hours of a day, and a
 * day is the thing being divided — and it is why a narrow window looks narrow rather than
 * merely reading as two different numbers.
 *
 * A day the campaign does not call is drawn empty rather than omitted. Seven columns always,
 * because the gap is the information: "not weekends" is a shape, and a strip that showed only
 * the five would look identical to one that ran all week.
 */
export const CallingWindowStrip = ({ window: chosen }: { readonly window: CampaignWindow | null }) => {
  const { startHour, endHour, weekdays } = chosen ?? DEFAULT_WINDOW;
  const open = new Set(weekdays);

  /* Percentages of the day, so the fill is the real proportion rather than a fixed inset.
     An end at or before the start is a window that can never fire; it draws as nothing,
     which is what it is. */
  const top = (startHour / 24) * 100;
  const height = Math.max(0, ((endHour - startHour) / 24) * 100);

  return (
    <div>
      <div className="flex gap-2">
        {/* The axis. Without it the columns are blocks that happen to be part-filled; with it
            they are a day, and "half the day, starting mid-morning" is readable at a glance.
            Measured first without it: the proportion was exactly right and looked wrong. */}
        <div className="relative h-16 w-7 flex-none text-[9px] text-[var(--ink-3)]">
          <span className="absolute top-0 right-0 -translate-y-1/2 tabular-nums">00</span>
          <span className="absolute top-1/2 right-0 -translate-y-1/2 tabular-nums">12</span>
          <span className="absolute right-0 bottom-0 translate-y-1/2 tabular-nums">24</span>
        </div>

        <div
          className="flex flex-1 gap-[3px]"
          role="img"
          aria-label={`Calls between ${pad(startHour)} and ${pad(endHour)} WAT`}
        >
          {DAYS.map((day) => {
            const on = open.has(day.value);
            return (
              <div key={day.value} className="flex flex-1 flex-col items-center gap-1.5">
                <div
                  title={
                    on ? `${day.full}, ${pad(startHour)}–${pad(endHour)}` : `${day.full} — no calls`
                  }
                  className="relative h-16 w-full overflow-hidden rounded-[3px] bg-[var(--hairline)]"
                >
                  {/* Noon, quietly. One line is enough to fix the scale in the eye; a full
                      grid on a 64px column is noise at this size. */}
                  <div className="absolute inset-x-0 top-1/2 h-px bg-[var(--surface-line)]" />
                  {on && height > 0 && (
                    <div
                      className="absolute inset-x-0 rounded-[2px] bg-[var(--accent)]"
                      style={{ top: `${top}%`, height: `${height}%` }}
                    />
                  )}
                </div>
                <span
                  className={cn(
                    "text-[10px] leading-none",
                    on ? "text-[var(--ink-2)]" : "text-[var(--ink-3)]",
                  )}
                >
                  {day.label}
                </span>
              </div>
            );
          })}
        </div>
      </div>

      <p className="mt-2.5 text-[12px] text-[var(--ink-2)]">
        <span className="tabular-nums">
          {pad(startHour)}–{pad(endHour)}
        </span>{" "}
        WAT
        {chosen === null && <span className="text-[var(--ink-3)]"> · the default bound</span>}
      </p>
    </div>
  );
};
