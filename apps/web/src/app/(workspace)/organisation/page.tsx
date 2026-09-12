import {
  Building2,
  Clock,
  Database,
  Mic,
  ScrollText,
  ShieldCheck,
  Users,
  type LucideIcon,
} from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";

import { Card, PageHeader, Tag } from "@/components/ui";
import { currentPrincipal } from "@/features/auth/auth.service";
import { HoursForm } from "@/features/org/components/hours-form";
import { NameForm } from "@/features/org/components/name-form";
import { RecordingForm } from "@/features/org/components/recording-form";
import { daysLabel, hourLabel, nowInWat, openNow } from "@/features/org/org.display";
import { listMembers, organisation } from "@/features/org/org.service";
import { cn } from "@/lib/cn";
import { humanise } from "@/lib/format";

export const metadata: Metadata = { title: "Organisation · Ansa" };
export const dynamic = "force-dynamic";

/**
 * The company, as against its agents — one page, a rail of sections, and the state of all of
 * them readable before a single click.
 *
 * This is design A with E's facts list: a section list on the left, the chosen section on
 * the right, and the landing section an overview where every fact has one control that
 * jumps to the section that changes it. The section is the URL (`?s=hours`), like every
 * other filter in the console, so a section is a link somebody can send.
 *
 * Consent and do-not-call moved in here from their own page. They were read-only there and
 * are read-only here — operator-set, enforced in code — but "how may we ring people" is a
 * fact about the organisation, and it belongs beside the hours and the recording switch
 * rather than on a page of its own that said nothing could be changed.
 */
const SECTIONS = ["overview", "general", "hours", "consent", "recording", "retention"] as const;
type Section = (typeof SECTIONS)[number];

const RAIL: readonly { readonly id: Section; readonly label: string; readonly Icon: LucideIcon }[] = [
  { id: "overview", label: "Overview", Icon: Building2 },
  { id: "general", label: "General", Icon: Building2 },
  { id: "hours", label: "Hours", Icon: Clock },
  { id: "consent", label: "Consent & calling", Icon: ShieldCheck },
  { id: "recording", label: "Recording", Icon: Mic },
  { id: "retention", label: "Retention", Icon: Database },
];

const OrganisationPage = async ({
  searchParams,
}: {
  readonly searchParams: Promise<{ readonly s?: string }>;
}) => {
  const { s } = await searchParams;
  const section: Section = SECTIONS.includes(s as Section) ? (s as Section) : "overview";

  const [org, principal, members] = await Promise.all([
    organisation(),
    currentPrincipal(),
    listMembers(1, 1),
  ]);
  const canWrite = principal.capabilities.includes("config:write");
  const now = new Date();
  const open = openNow(org.businessHours, now);

  return (
    <>
      <PageHeader
        eyebrow="Organisation"
        title={org.name}
        meta={
          <span className="inline-flex flex-wrap items-center gap-x-2.5 gap-y-1">
            <Tag tone={open ? "ok" : "neutral"}>
              {open ? `open now · ${nowInWat(now)} WAT` : `closed now · ${nowInWat(now)} WAT`}
            </Tag>
            <span>Everything that belongs to the company rather than to any one agent.</span>
          </span>
        }
      />

      <div className="grid items-start gap-6 lg:grid-cols-[13rem_minmax(0,1fr)]">
        <nav aria-label="Sections" className="flex flex-col gap-0.5 lg:sticky lg:top-6">
          <span className="px-2.5 pt-1 pb-1.5 font-mono text-[10px] font-semibold tracking-[0.12em] text-[var(--ink-3)] uppercase">
            Organisation
          </span>
          {RAIL.map(({ id, label, Icon }) => (
            <Link
              key={id}
              href={id === "overview" ? "/organisation" : `/organisation?s=${id}`}
              aria-current={section === id ? "page" : undefined}
              className={cn(
                "flex items-center gap-2.5 rounded-md px-2.5 py-1.5 text-[13.5px] text-[var(--ink-2)] hover:bg-[var(--surface-2)]",
                section === id && "bg-[var(--surface-2)] font-medium text-[var(--ink)] shadow-[inset_2px_0_0_var(--accent)]",
              )}
            >
              <Icon aria-hidden className="size-4 text-[var(--ink-3)]" />
              {label}
              {id === "recording" && (
                <Tag tone={org.recordCalls ? "ok" : "warn"}>{org.recordCalls ? "on" : "off"}</Tag>
              )}
            </Link>
          ))}
          <span className="px-2.5 pt-4 pb-1.5 font-mono text-[10px] font-semibold tracking-[0.12em] text-[var(--ink-3)] uppercase">
            People
          </span>
          <Link href="/members" className="flex items-center gap-2.5 rounded-md px-2.5 py-1.5 text-[13.5px] text-[var(--ink-2)] hover:bg-[var(--surface-2)]">
            <Users aria-hidden className="size-4 text-[var(--ink-3)]" />
            Members
            <span className="ml-auto font-mono text-[11px] text-[var(--ink-3)]">{members.total}</span>
          </Link>
          <Link href="/audit" className="flex items-center gap-2.5 rounded-md px-2.5 py-1.5 text-[13.5px] text-[var(--ink-2)] hover:bg-[var(--surface-2)]">
            <ScrollText aria-hidden className="size-4 text-[var(--ink-3)]" />
            Audit log
          </Link>
        </nav>

        <div className="flex min-w-0 flex-col gap-3.5">
          {section === "overview" && (
            <Card
              title="This organisation"
              description="The state of everything on this page, in one place. Each line opens the section that changes it."
            >
              <dl className="m-0 -mx-4 -mb-4 divide-y divide-[var(--surface-line)]">
                <Fact
                  Icon={Clock}
                  label="Hours"
                  value={
                    org.businessHours === null
                      ? "Always open"
                      : `${hourLabel(org.businessHours.opensAtHour)} – ${hourLabel(org.businessHours.closesAtHour)} · ${daysLabel(org.businessHours.openDays)}`
                  }
                  state={<Tag tone={open ? "ok" : "neutral"}>{open ? "open now" : "closed now"}</Tag>}
                  href="/organisation?s=hours"
                  action={canWrite ? "Change" : "View"}
                />
                <Fact
                  Icon={ShieldCheck}
                  label="May call because"
                  value={`${humanise(org.consent.policy)} · ${hourLabel(org.consent.callingEarliestHour)} – ${hourLabel(org.consent.callingLatestHour)} WAT`}
                  state={<Tag>operator-set</Tag>}
                  href="/organisation?s=consent"
                  action="View"
                />
                <Fact
                  Icon={Mic}
                  label="Recording"
                  value={org.recordCalls ? "On — every caller is told in the first sentence" : "Off — nothing is kept as audio"}
                  state={<Tag tone={org.recordCalls ? "ok" : "warn"}>{org.recordCalls ? "on" : "off"}</Tag>}
                  href="/organisation?s=recording"
                  action={canWrite ? (org.recordCalls ? "Change" : "Turn on") : "View"}
                />
                <Fact
                  Icon={Database}
                  label="Retention"
                  value={`${org.audioRetentionDays} d audio · ${org.transcriptRetentionDays} d words`}
                  state={<Tag>operator-set</Tag>}
                  href="/organisation?s=retention"
                  action="View"
                />
                <Fact
                  Icon={Users}
                  label="People"
                  value={`${members.total} ${members.total === 1 ? "person" : "people"}`}
                  href="/members"
                  action="Manage"
                />
              </dl>
            </Card>
          )}

          {section === "general" && <NameForm name={org.name} />}

          {section === "hours" && <HoursForm organisation={org} />}

          {section === "consent" && (
            <Card
              title={
                <span className="inline-flex items-center gap-2">
                  <ShieldCheck aria-hidden className="size-4 text-[var(--ink-3)]" />
                  Consent &amp; calling window
                </span>
              }
              description="How this organisation is permitted to ring somebody, and when. Set by the platform operator and enforced in code before a number is dialled — nothing on this dashboard can loosen it."
              actions={<Tag>operator-set</Tag>}
            >
              <dl className="m-0 grid gap-x-6 gap-y-4 sm:grid-cols-2">
                <div>
                  <dt className="text-[12px] text-[var(--ink-3)]">Legal basis</dt>
                  <dd className="m-0 mt-0.5 text-[15px] font-medium">{humanise(org.consent.policy)}</dd>
                  <dd className="m-0 mt-1 text-[12.5px] text-[var(--ink-3)]">
                    An existing relationship is your own customers about their own business with you. A bought list needs consent per number.
                  </dd>
                </div>
                <div>
                  <dt className="text-[12px] text-[var(--ink-3)]">Recorded basis</dt>
                  <dd className="m-0 mt-0.5 text-[13.5px] leading-relaxed">{org.consent.basis ?? "None recorded"}</dd>
                </div>
                <div>
                  <dt className="text-[12px] text-[var(--ink-3)]">May call from</dt>
                  <dd className="m-0 mt-0.5 font-mono text-[15px] font-medium">{hourLabel(org.consent.callingEarliestHour)}</dd>
                </div>
                <div>
                  <dt className="text-[12px] text-[var(--ink-3)]">Until</dt>
                  <dd className="m-0 mt-0.5 font-mono text-[15px] font-medium">{hourLabel(org.consent.callingLatestHour)}</dd>
                  <dd className="m-0 mt-1 text-[12.5px] text-[var(--ink-3)]">The platform's outer bound is 08:00–20:00 WAT. An organisation may narrow it, never widen it.</dd>
                </div>
              </dl>
              <p className="mt-4 mb-0 border-t border-[var(--surface-line)] pt-3.5 text-[12.5px] leading-relaxed text-[var(--ink-3)]">
                Do-not-call outranks everything above: a number on the list cannot be rung whatever the basis. Numbers are added from a contact&apos;s record, and the check runs on every outbound call.
              </p>
            </Card>
          )}

          {section === "recording" && (
            <RecordingForm organisationName={org.name} recordCalls={org.recordCalls} />
          )}

          {section === "retention" && (
            <Card
              title={
                <span className="inline-flex items-center gap-2">
                  <Database aria-hidden className="size-4 text-[var(--ink-3)]" />
                  Retention
                </span>
              }
              description="How long a call is kept. Set by the platform operator: shortening it deletes evidence you may be asked for, lengthening it holds a caller's data past the basis it was collected on."
              actions={<Tag>operator-set</Tag>}
            >
              <div className="grid gap-3.5 sm:grid-cols-2">
                <div className="rounded-lg border border-[var(--hairline)] bg-[var(--surface-2)] px-4 py-3.5">
                  <div className="text-[12px] text-[var(--ink-3)]">The caller&apos;s voice</div>
                  <div className="mt-1 text-[28px] leading-none font-[680] tracking-[-0.03em] tabular-nums">
                    {org.audioRetentionDays}
                    <span className="ml-1 text-[13px] font-medium text-[var(--ink-3)]">days</span>
                  </div>
                  <div className="mt-2 text-[12.5px] text-[var(--ink-3)]">Then the recording is deleted.</div>
                </div>
                <div className="rounded-lg border border-[var(--hairline)] bg-[var(--surface-2)] px-4 py-3.5">
                  <div className="text-[12px] text-[var(--ink-3)]">What was said</div>
                  <div className="mt-1 text-[28px] leading-none font-[680] tracking-[-0.03em] tabular-nums">
                    {org.transcriptRetentionDays}
                    <span className="ml-1 text-[13px] font-medium text-[var(--ink-3)]">days</span>
                  </div>
                  {/* The words outlive the audio on purpose: the review loop corrects transcripts
                      and the eval corpus is built from those corrections. */}
                  <div className="mt-2 text-[12.5px] text-[var(--ink-3)]">Transcripts, events, tool arguments and summaries.</div>
                </div>
              </div>
            </Card>
          )}
        </div>
      </div>
    </>
  );
};

/** One line of the overview: what it is, what it is now, and the one control that changes it. */
const Fact = ({
  Icon,
  label,
  value,
  state,
  href,
  action,
}: {
  readonly Icon: LucideIcon;
  readonly label: string;
  readonly value: string;
  readonly state?: React.ReactNode;
  readonly href: string;
  readonly action: string;
}) => (
  <div className="grid grid-cols-[1.25rem_minmax(0,1fr)_auto] items-center gap-3.5 px-4 py-3">
    <Icon aria-hidden className="size-4 text-[var(--ink-3)]" />
    <div className="min-w-0">
      <dt className="text-[12px] text-[var(--ink-3)]">{label}</dt>
      <dd className="m-0 mt-0.5 flex flex-wrap items-center gap-2 text-[13.5px]">
        <span>{value}</span>
        {state}
      </dd>
    </div>
    <Link
      href={href}
      className="rounded-md border border-[var(--hairline)] bg-[var(--surface-solid)] px-2.5 py-1 text-[12px] font-medium shadow-[var(--shadow-s)] hover:border-[var(--ink-3)]"
    >
      {action}
    </Link>
  </div>
);

export default OrganisationPage;
