import type { Metadata } from "next";
import { notFound } from "next/navigation";
import Link from "next/link";

import { Card, Pagination, Stack, Tag, buttonClass } from "@/components/ui";
import { WidePage } from "@/components/shell/wide-page";
import { ContactConsent } from "@/features/contacts/components/contact-consent";
import { initialsOf, nameOf } from "@/features/contacts/contacts.display";
import { callsThisWeek, daysSince, timelineOf } from "@/features/contacts/contact-timeline";
import { readContactDetail } from "@/features/contacts/contacts.service";
import { refusedWith } from "@/lib/api/server";
import { readPaging } from "@/lib/paging";
import { cn } from "@/lib/cn";
import { dayLabel, directionLabel, duration, humanise, phone, timeOfDay, when } from "@/lib/format";
import { outcomeOf } from "@/features/calls/outcome";

export const metadata: Metadata = { title: "Contact · Ansa" };
export const dynamic = "force-dynamic";

/**
 * One person: everything that has happened, and what we know about them.
 *
 * This page was a call table, which answered "when did they ring" and left "who is this" to
 * another screen. It is a timeline now because those are the same question asked at different
 * distances — somebody rings back and what you need is the last thing that happened, whatever
 * kind of thing it was.
 *
 * **Captured values are shown here, which reverses an earlier decision.** The comment this
 * replaces said they lived on Collected data because "two places rendering the same values is
 * two places to keep in step, and the one with the export wins". That reasoning holds for the
 * *table* and not for this: Collected data answers "what have we learned across everyone",
 * filterable and exportable, while these few lines answer "who am I about to speak to". Same
 * rows, different question — and this one carries the provenance the table has no room for,
 * which is the call that confirmed each value.
 *
 * **"Whether we may ring" is here now**, which the note this replaces said it could not be:
 * an endpoint exposes consent and suppression per number, so the panel shows `mayCall`'s own
 * verdict rather than a second reading of the rules.
 *
 * Still deliberately absent, because nothing serves them yet: merging two numbers into one
 * person, and a subject-access export. Cards promising those with nothing behind them would be
 * worse than their absence.
 */
const ContactPage = async ({
  params,
  searchParams,
}: {
  readonly params: Promise<{ readonly contactId: string }>;
  readonly searchParams: Promise<{ readonly page?: string; readonly perPage?: string }>;
}) => {
  const { contactId } = await params;
  const search = await searchParams;
  const requested = readPaging(search);

  const detail = await readContactDetail(contactId, requested).catch((error: unknown) => {
    // Another organisation's contact looks exactly like one that does not exist, which is
    // deliberate on the API side. Both are a 404 here too.
    if (refusedWith(error, 404)) return null;
    throw error;
  });
  if (detail === null) notFound();

  const { contact, calls, consent, appointments, consentEvents, handedToHuman } = detail;
  const now = new Date();
  const entries = timelineOf(calls.items, contact.values, appointments, consentEvents, {
    first: calls.page === 1,
    /* The oldest page reaches back past the first call, which is where the import or the
       consent that predates it belongs. `totalPages` is 0 on a person with no calls at all,
       so that case is the last page too. */
    last: calls.page >= calls.totalPages,
  });
  /* A call that booked or moved an appointment says so as its outcome, because "booked" is
     what that call came to and "completed" is merely how it ended. */
  const bookedOn = new Map<string, string>();
  for (const appointment of appointments) {
    if (appointment.callId !== null) bookedOn.set(appointment.callId, appointment.status);
  }
  const week = callsThisWeek(calls.items, calls.total, now);
  const sinceFirst = daysSince(contact.firstCallAt, now);
  const sinceLast = daysSince(contact.lastCallAt, now);

  return (
    <>
      <WidePage />

      {/* Not `PageHeader`: this one carries a face and a verdict, and the way back sits above
          the name rather than opposite it. A person is not a section of the console — the
          back link is where it is on a record you opened *from* somewhere. */}
      <header className="mb-6">
        <Link
          href="/contacts"
          className={cn(buttonClass("secondary", "sm"), "mb-4 inline-flex")}
        >
          ← All contacts
        </Link>

        <div className="flex items-start gap-3.5">
          <span
            aria-hidden
            className="mt-0.5 grid size-[42px] flex-none place-items-center rounded-full border border-[var(--hairline)] bg-[var(--surface-2)] font-mono text-[13px] font-semibold text-[var(--ink-2)]"
          >
            {initialsOf(contact)}
          </span>
          <div className="min-w-0 flex-1">
            <h1 className="m-0 text-[27px] leading-tight font-[680] tracking-[-0.025em]">
              {nameOf(contact)}
            </h1>
            <div className="mt-1 flex flex-wrap items-center gap-x-2.5 gap-y-1 text-[13px] text-[var(--ink-3)]">
              <span className="font-mono text-[12.5px]">{phone(contact.phone)}</span>
              <span aria-hidden>·</span>
              <span>
                {contact.callCount} call{contact.callCount === 1 ? "" : "s"}
              </span>
              {contact.firstCallAt !== null && (
                <>
                  <span aria-hidden>·</span>
                  <span>first heard from {when(contact.firstCallAt)}</span>
                </>
              )}
              {/* The verdict, where the name is. Whether you may ring somebody is the first
                  thing you want to know about them and the rail is a scroll away. */}
              <span
                className={
                  consent.allowed
                    ? "inline-flex items-center rounded-[4px] border border-[color-mix(in_srgb,var(--ok)_34%,transparent)] bg-[color-mix(in_srgb,var(--ok)_12%,transparent)] px-1.5 py-px text-[11.5px] font-medium text-[var(--ok)]"
                    : "inline-flex items-center rounded-[4px] border border-[color-mix(in_srgb,var(--bad)_34%,transparent)] bg-[color-mix(in_srgb,var(--bad)_12%,transparent)] px-1.5 py-px text-[11.5px] font-medium text-[var(--bad)]"
                }
              >
                {consent.allowed ? "may call" : "may not call"}
              </span>
            </div>
          </div>
        </div>
      </header>

      {/* The spine gets the width; what we know sits beside it. Below the breakpoint they
          stack, so the rail lands under the timeline rather than beside a squeezed one. */}
      <div className="grid items-start gap-3.5 lg:grid-cols-[minmax(0,1fr)_20rem]">
        <div className="flex flex-col gap-3.5">
          <Card
            title="Everything that has happened"
            actions={
              <span className="text-[12px] text-[var(--ink-3)]">
                Calls, values, appointments, consent
              </span>
            }
          >
            {entries.length === 0 ? (
              <p className="text-[13px] text-[var(--ink-3)]">
                Nothing yet. This person was added before anybody rang them.
              </p>
            ) : (
              /* The rule is drawn on the list rather than per row, so it runs unbroken behind
                 every marker instead of restarting at each one. */
              <ol className="relative m-0 list-none p-0 pl-5 before:absolute before:top-2 before:bottom-2 before:left-[5px] before:w-px before:bg-[var(--surface-line)] before:content-['']">
                {entries.map((entry) =>
                  entry.kind === "call" ? (
                    <li key={`call-${entry.call.callId}`} className="relative py-1">
                      <Marker kind="call" />
                      <Link
                        href={`/calls/${entry.call.callId}`}
                        className="-mx-2 flex flex-wrap items-start gap-x-3 gap-y-0.5 rounded-lg px-2 py-1.5 hover:bg-[var(--surface-2)]"
                      >
                        <span className="w-[8.5rem] flex-none pt-px text-[11.5px] tabular-nums text-[var(--ink-3)]">
                          <Moment at={entry.call.calledAt} />
                        </span>
                        <span className="min-w-0 flex-1">
                          <span className="block text-[13px]">
                            <b className="font-medium">{directionLabel(entry.call.direction)} call</b>
                            <span className="text-[var(--ink-3)]">
                              {entry.call.durationSeconds === null
                                ? ""
                                : ` · ${duration(entry.call.durationSeconds)}`}
                            </span>
                          </span>
                          {/* What it was about — the line somebody actually reads. The first
                              sentence of the grounded summary, so it is something the call
                              can be held to rather than a paraphrase of a paraphrase. */}
                          {firstSentence(entry.call.summary) !== null && (
                            <span className="mt-0.5 block text-[12px] leading-snug text-[var(--ink-3)]">
                              {firstSentence(entry.call.summary)}
                            </span>
                          )}
                        </span>
                        <CallOutcome call={entry.call} bookedOn={bookedOn} />
                      </Link>
                    </li>
                  ) : entry.kind === "appointment" ? (
                    <li key={`appointment-${entry.appointment.id}`} className="relative py-1">
                      <Marker kind="value" />
                      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5 py-1.5">
                        <span className="w-[8.5rem] flex-none text-[11.5px] tabular-nums text-[var(--ink-3)]">
                          <Moment at={entry.appointment.bookedAt} />
                        </span>
                        <span className="min-w-0 flex-1 text-[13px] text-[var(--ink-2)]">
                          <b className="font-medium text-[var(--ink)]">
                            {humanise(entry.appointment.status)}
                          </b>
                          {entry.appointment.title === null ? "" : ` — ${entry.appointment.title}`}
                          {/* What it is for, which is the part somebody reads. The entry itself
                              sits at the moment it was arranged. */}
                          <span className="block text-[12px] text-[var(--ink-3)]">
                            for {when(entry.appointment.startsAt)}
                          </span>
                        </span>
                      </div>
                    </li>
                  ) : entry.kind === "consent" ? (
                    <li key={`consent-${entry.at}-${entry.consent.kind}`} className="relative py-1">
                      <Marker kind="value" />
                      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5 py-1.5">
                        <span className="w-[8.5rem] flex-none text-[11.5px] tabular-nums text-[var(--ink-3)]">
                          <Moment at={entry.at} />
                        </span>
                        <span className="min-w-0 flex-1 text-[13px] text-[var(--ink-2)]">
                          <b className="font-medium text-[var(--ink)]">
                            {entry.consent.kind === "granted"
                              ? "Consent recorded"
                              : "Consent withdrawn"}
                          </b>
                          {entry.consent.basis === null ? "" : ` — ${entry.consent.basis}`}
                        </span>
                      </div>
                    </li>
                  ) : (
                    <li key={`value-${entry.value.fieldKey}`} className="relative py-1">
                      <Marker kind="value" />
                      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5 py-1.5">
                        <span className="w-[8.5rem] flex-none text-[11.5px] tabular-nums text-[var(--ink-3)]">
                          <Moment at={entry.value.updatedAt} />
                        </span>
                        <span className="min-w-0 flex-1 text-[13px] text-[var(--ink-2)]">
                          Confirmed{" "}
                          <b className="font-medium text-[var(--ink)]">{humanise(entry.value.fieldKey)}</b>
                          {" — "}
                          <span className="text-[var(--ink)]">{entry.value.value}</span>
                        </span>
                      </div>
                    </li>
                  ),
                )}
              </ol>
            )}
          </Card>

          {/* Outside the card, like every other list in the console, so the control that moves
              between pages is not inside the thing it is paging. */}
          <Pagination
            basePath={`/contacts/${contactId}`}
            page={calls.page}
            perPage={calls.perPage}
            totalPages={calls.totalPages}
            total={calls.total}
            params={search}
            unit="calls"
          />
        </div>

        <div className="flex flex-col gap-3.5">
          <Card
            title="What we know"
            description="What this person has told an agent, and which call it came from."
          >
            {contact.values.length === 0 ? (
              <p className="text-[13px] text-[var(--ink-3)]">
                Nothing confirmed yet. A value appears here the first time an agent reads one
                back and the caller agrees.
              </p>
            ) : (
              <dl className="m-0">
                {contact.values.map((value) => (
                  <div
                    key={value.fieldKey}
                    className="grid grid-cols-[6rem_minmax(0,1fr)] gap-x-3 gap-y-1 border-t border-[var(--surface-line)] py-2 first:border-t-0 first:pt-0"
                  >
                    <dt className="text-[12px] text-[var(--ink-3)]">{humanise(value.fieldKey)}</dt>
                    <dd className="m-0 text-[13px]">
                      {value.value}
                      {/* Provenance is why this is worth rendering twice: the table on
                          Collected data cannot say which call put the value there. */}
                      <span className="mt-0.5 block text-[11.5px] text-[var(--ink-3)]">
                        {value.sourceCallId === null ? (
                          <>heard {when(value.updatedAt)}</>
                        ) : (
                          <Link
                            href={`/calls/${value.sourceCallId}`}
                            className="hover:text-[var(--accent)] hover:underline"
                          >
                            heard on the call of {when(value.updatedAt)}
                          </Link>
                        )}
                      </span>
                    </dd>
                  </div>
                ))}
              </dl>
            )}
          </Card>

          <ContactConsent contactId={contactId} consent={consent} />

          <Card title="Pattern" description="What their calling looks like from a distance.">
            <Stack gap="sm">
              <div className="flex flex-wrap gap-x-7 gap-y-3">
                <Figure value={contact.callCount} label="calls in all" />
                {week !== null && <Figure value={week} label="in the last week" />}
                {sinceLast !== null && <Figure value={sinceLast} label="days since the last" />}
                {sinceFirst !== null && <Figure value={sinceFirst} label="days since the first" />}
                <Figure value={handedToHuman} label="handed to a human" />
              </div>
              {week === null && (
                <p className="text-[11.5px] text-[var(--ink-3)]">
                  A weekly count is shown only when this page holds their whole history — with
                  more calls than fit, it could be wrong without saying so.
                </p>
              )}
            </Stack>
          </Card>
        </div>
      </div>
    </>
  );
};

/**
 * A moment on the spine: "Today 14:12", "23 August 22:40".
 *
 * Shorter than `when()` because the column is narrow and the year is nearly always this one;
 * the day label already says "Today" and "Yesterday", which is what somebody scanning a
 * timeline is actually asking.
 */
const Moment = ({ at }: { readonly at: string }) => (
  <>
    {dayLabel(at)} {timeOfDay(at)}
  </>
);

/** The first sentence of a summary, or null when there is no summary to take one from. */
const firstSentence = (summary: string | null): string | null => {
  if (summary === null) return null;
  const sentence = summary.split(/(?<=[.!?])\s+/)[0]?.trim() ?? "";
  return sentence === "" ? null : sentence;
};

/**
 * What a call on the spine came to.
 *
 * Booking something outranks how the socket closed: a call that made an appointment is
 * "booked" whether it then ended by hangup, by transfer or by the carrier sending stop. For
 * everything else it is the console's one reading of `end_reason` — see `outcomeOf` — so the
 * transport's exit codes never appear here either.
 */
const CallOutcome = ({
  call,
  bookedOn,
}: {
  readonly call: { readonly callId: string; readonly endReason: string | null; readonly endedAt: string | null };
  readonly bookedOn: ReadonlyMap<string, string>;
}) => {
  const booked = bookedOn.get(call.callId);
  if (booked !== undefined) return <Tag tone="ok">{humanise(booked)}</Tag>;
  const outcome = outcomeOf(call.endReason, call.endedAt !== null);
  return <Tag tone={outcome.tone}>{outcome.label}</Tag>;
};

/**
 * The dot on the spine. A call is the accent and filled; anything else is hollow — the
 * difference says "this one opens" before the cursor gets there.
 */
const Marker = ({ kind }: { readonly kind: "call" | "value" }) => (
  <span
    aria-hidden
    className={cn(
      "absolute top-[1.05rem] -left-[1.03rem] size-[7px] rounded-full border-[1.5px]",
      kind === "call"
        ? "border-[var(--accent)] bg-[var(--accent)]"
        : "border-[var(--ink-3)] bg-[var(--surface-solid)]",
    )}
  />
);

const Figure = ({ value, label }: { readonly value: number; readonly label: string }) => (
  <div>
    <div className="text-[20px] leading-none font-medium tabular-nums text-[var(--ink)]">{value}</div>
    <div className="mt-1 text-[11.5px] text-[var(--ink-3)]">{label}</div>
  </div>
);

export default ContactPage;
