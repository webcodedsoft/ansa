import Link from "next/link";

import { Tag } from "@/components/ui";
import { phone as formatPhone, when } from "@/lib/format";

import { callStatusLabel, callTone } from "../campaigns.display";
import type { ScheduledCall } from "../campaigns.service";

/**
 * The last few calls, newest first — the answer to "is it working right now".
 *
 * A feed rather than a table. The paged list on the Calls tab is for finding a particular
 * person; this is for watching, and what somebody watching wants is the call that just
 * finished at the top, what came of it, and a way to hear it. Ten rows, no pager, and the
 * page it sits on re-renders itself while the campaign is running so the top row changes
 * without anybody pressing anything.
 */
export const RecentCallsFeed = ({ calls }: { readonly calls: readonly ScheduledCall[] }) => {
  if (calls.length === 0) {
    return (
      <p className="text-[12.5px] text-[var(--ink-3)]">
        Nothing has been dialled yet. The first call appears here the moment it finishes.
      </p>
    );
  }

  return (
    <ol className="flex flex-col">
      {calls.map((call) => (
        <li
          key={call.id}
          className="flex flex-wrap items-start gap-x-3 gap-y-1 border-b border-[var(--hairline)] py-2.5 last:border-b-0"
        >
          <span className="w-[5.5rem] flex-none pt-0.5 text-[11.5px] tabular-nums text-[var(--ink-3)]">
            {call.lastAttemptAt === null ? "—" : when(call.lastAttemptAt)}
          </span>
          <Tag tone={callTone[call.status] ?? "neutral"}>
            {callStatusLabel[call.status] ?? call.status}
          </Tag>
          <span className="min-w-0 flex-1">
            <span className="block text-[13px] font-medium text-[var(--ink)]">
              {call.displayName ?? formatPhone(call.phone)}
            </span>
            {call.outcome !== null && call.outcome.trim() !== "" && (
              <span className="block text-[12px] leading-relaxed text-[var(--ink-2)]">
                {call.outcome}
              </span>
            )}
          </span>
          {call.callId !== null && (
            <Link
              href={`/calls/${call.callId}`}
              className="flex-none pt-0.5 text-[11.5px] text-[var(--accent)] hover:underline"
            >
              Listen
            </Link>
          )}
        </li>
      ))}
    </ol>
  );
};
