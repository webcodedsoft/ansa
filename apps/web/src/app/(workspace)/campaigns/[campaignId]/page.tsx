import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";

import { WidePage } from "@/components/shell/wide-page";
import { buttonClass, Card, PageHeader, Pagination, Tabs } from "@/components/ui";
import { currentPrincipal } from "@/features/auth/auth.service";
import { listAgents, readTools } from "@/features/agents/agents.service";
import { AutoRefresh } from "@/features/calls/components/auto-refresh";
import { listContacts } from "@/features/contacts/contacts.service";
import { AddContactsButton } from "@/features/campaigns/components/add-contacts-button";
import { CampaignBrief } from "@/features/campaigns/components/campaign-brief";
import { CampaignConversation } from "@/features/campaigns/components/campaign-conversation";
import { CallStatusFilter } from "@/features/campaigns/components/call-status-filter";
import { CampaignCallingWindow } from "@/features/campaigns/components/campaign-calling-window";
import { CampaignBreakdown } from "@/features/campaigns/components/campaign-breakdown";
import { CampaignProgress } from "@/features/campaigns/components/campaign-progress";
import { CampaignSchedule } from "@/features/campaigns/components/campaign-schedule";
import { CampaignStatusControl } from "@/features/campaigns/components/campaign-status-control";
import { DuplicateCampaignButton } from "@/features/campaigns/components/duplicate-campaign-button";
import { RecentCallsFeed } from "@/features/campaigns/components/recent-calls-feed";
import { RetryUnreachedButton } from "@/features/campaigns/components/retry-unreached-button";
import { ScheduledCallsTable } from "@/features/campaigns/components/scheduled-calls-table";
import { projectedFinish, windowSummary } from "@/features/campaigns/campaigns.display";
import {
  listCampaignCalls,
  readCampaign,
  readCampaignBreakdown,
  readRecentCalls,
  SCHEDULED_STATUSES,
  type CampaignDetail,
  type ScheduledCallStatus,
} from "@/features/campaigns/campaigns.service";
import { refusedWith } from "@/lib/api/server";
import { readPaging } from "@/lib/paging";

export const metadata: Metadata = { title: "Campaign · Ansa" };
export const dynamic = "force-dynamic";

/** How often a running campaign's page re-renders itself. */
const LIVE_REFRESH_MS = 15_000;

const Figure = ({ label, value }: { readonly label: string; readonly value: number }) => (
  <div>
    <div className="text-[22px] leading-none font-medium tabular-nums text-[var(--ink)]">{value}</div>
    <div className="mt-1.5 text-[11px] tracking-[0.06em] text-[var(--ink-3)] uppercase">{label}</div>
  </div>
);

/**
 * The reason it rings, with the parts that change per person marked.
 *
 * `{property}` and `{when}` are filled from what is already known about whoever is being
 * called, and on the brief form they are just braces in a text input. Shown here they are the
 * most useful thing on the page: one glance says which half of this sentence is fixed and
 * which half arrives per person, which is exactly the thing that goes wrong — a placeholder
 * nobody has a value for is read out with its braces on.
 *
 * Split rather than replaced, so an unmatched brace stays visible as text instead of being
 * silently swallowed.
 */
const Purpose = ({ text, size = "lg" }: { readonly text: string; readonly size?: "lg" | "sm" }) => (
  <p className={size === "lg" ? "text-[17px] leading-[1.45] text-[var(--ink)]" : "text-[13.5px] leading-relaxed text-[var(--ink)]"}>
    {text.split(/(\{[^{}]+\})/g).map((part, index) =>
      /^\{[^{}]+\}$/.test(part) ? (
        <span
          key={index}
          className={
            size === "lg"
              ? "rounded bg-[var(--accent-soft)] px-1 py-0.5 text-[15px] text-[var(--accent)]"
              : "rounded bg-[var(--accent-soft)] px-1 py-0.5 text-[12.5px] text-[var(--accent)]"
          }
        >
          {part.slice(1, -1)}
        </span>
      ) : (
        part
      ),
    )}
  </p>
);

/**
 * Which of the three jobs this page is doing.
 *
 * A campaign is set up, then watched, then read, and the page has to be composed for
 * whichever of those it is — the same set of cards at the same weight in every state was
 * why it never looked right. A draft wants the brief and the checklist; a running campaign
 * wants the numbers and the feed; a finished one wants the verdicts. What is *possible* on
 * each is the API's business; this only decides what is *prominent*.
 */
const phaseOf = (status: CampaignDetail["status"]): "setup" | "watching" | "reading" =>
  status === "draft" || status === "scheduled" ? "setup" : status === "done" ? "reading" : "watching";

/**
 * The three steps between a draft and a ringing phone, as one row.
 *
 * Nothing else in the product states them. Each is ticked from the campaign itself rather
 * than from anything remembered, so reopening the page a week later shows the truth.
 *
 * A stepper rather than a list: three titles with a paragraph each took a third of the
 * viewport to say "two things left", and this is a status somebody glances at, not a guide
 * they read. The connecting lines carry the order, the fill carries progress, and the one
 * sentence underneath says what the *next* thing is — which is the only paragraph anybody
 * actually needed. Titles stay short enough to sit on one line at the narrowest width the
 * card gets.
 */
const SetupChecklist = ({ campaign }: { readonly campaign: CampaignDetail }) => {
  const steps = [
    {
      done: campaign.purpose !== null && campaign.purpose.trim() !== "",
      title: "Say why it calls",
      next: "Write the reason in the brief below. The agent opens with it; without one it composes its own.",
    },
    {
      done: campaign.total > 0,
      title: "Add the people",
      next: "Add contacts and each becomes a pending call. Consent is still checked per number when it dials.",
    },
    {
      done: campaign.status !== "draft",
      title: "Start it",
      next: "Press Schedule to start it yourself, or give it a start time in the schedule and it runs on its own.",
    },
  ];
  const upcoming = steps.find((step) => !step.done) ?? null;

  return (
    <Card>
      <ol className="flex items-center">
        {steps.map((step, index) => {
          const current = upcoming !== null && step.title === upcoming.title;
          return (
            <li key={step.title} className="flex flex-1 items-center last:flex-none">
              <div className="flex items-center gap-2">
                <span
                  aria-hidden
                  className={
                    step.done
                      ? "flex size-6 flex-none items-center justify-center rounded-full bg-[var(--accent)] text-[11px] font-semibold text-[var(--accent-on)]"
                      : current
                        ? "flex size-6 flex-none items-center justify-center rounded-full border-2 border-[var(--accent)] text-[11px] font-semibold text-[var(--accent)]"
                        : "flex size-6 flex-none items-center justify-center rounded-full border border-[var(--hairline)] text-[11px] text-[var(--ink-3)]"
                  }
                >
                  {step.done ? "✓" : index + 1}
                </span>
                <span
                  className={
                    step.done
                      ? "text-[12.5px] whitespace-nowrap text-[var(--ink-3)]"
                      : current
                        ? "text-[12.5px] font-medium whitespace-nowrap text-[var(--ink)]"
                        : "text-[12.5px] whitespace-nowrap text-[var(--ink-3)]"
                  }
                >
                  {step.title}
                </span>
              </div>
              {index < steps.length - 1 && (
                <span
                  aria-hidden
                  className={
                    step.done
                      ? "mx-3 h-px flex-1 bg-[var(--accent)]"
                      : "mx-3 h-px flex-1 bg-[var(--hairline)]"
                  }
                />
              )}
            </li>
          );
        })}
      </ol>

      <p className="mt-3 text-[12px] leading-relaxed text-[var(--ink-3)]">
        {upcoming === null ? "Everything is in place." : upcoming.next}
      </p>
    </Card>
  );
};

/**
 * One campaign, composed for whatever it is doing right now.
 *
 * Three phases and three layouts. **Setting up** — a draft or a scheduled campaign — leads
 * with the brief and the conversation, because writing them is the work; the checklist says
 * what is left and the schedule sits beside it. **Watching** — running or paused — leads with
 * the live strip, the breakdown and a feed of what just happened, re-rendering itself every
 * fifteen seconds; the brief is frozen, so it drops to a read-only panel in the sidebar.
 * **Reading** — done — is the watching layout with the controls gone and the verdicts on top,
 * because the answer the campaign existed to produce is the first thing to show.
 *
 * The sidebar is constant across all three: the hours strip and the schedule are true of a
 * campaign whatever state it is in. What changes is what gets the width.
 */
const CampaignPage = async ({
  params,
  searchParams,
}: {
  readonly params: Promise<{ readonly campaignId: string }>;
  readonly searchParams: Promise<{
    readonly page?: string;
    readonly perPage?: string;
    readonly status?: string;
  }>;
}) => {
  const { campaignId } = await params;
  const search = await searchParams;
  const requested = readPaging(search);

  /* A status the API does not know is dropped rather than passed on and refused. Somebody
     editing the query by hand gets the whole list, which is the harmless reading. */
  const status = SCHEDULED_STATUSES.find((one) => one === search.status) ?? null;

  const campaign = await readCampaign(campaignId).catch((error: unknown) => {
    // Another organisation's campaign is a 404 here too, deliberately — it looks exactly like
    // one that does not exist, which is what the API intends.
    if (refusedWith(error, 404)) return null;
    throw error;
  });
  if (campaign === null) notFound();

  const phase = phaseOf(campaign.status);

  const [principal, calls, agentList, tools, breakdown, recent] = await Promise.all([
    currentPrincipal(),
    listCampaignCalls(campaignId, {
      ...requested,
      ...(status === null ? {} : { status: status as ScheduledCallStatus }),
    }),
    listAgents(),
    /* The organisation's tools, so a tool step can name one that exists. A campaign
       enables nothing of its own — the tools belong to the agent it uses. */
    readTools(),
    /* Counted rather than derived from `calls`, which is one page of a filtered list and
       would report "3 answered" on a campaign with four hundred. */
    readCampaignBreakdown(campaignId),
    /* Only when somebody is watching or reading. A draft has nothing to feed. */
    phase === "setup" ? Promise.resolve({ items: [] }) : readRecentCalls(campaignId),
  ]);
  const canWrite = principal.capabilities.includes("campaigns:write");

  const agentName =
    agentList.items.find((agent) => agent.agentId === campaign.agentId)?.name ?? "Unknown agent";

  // Only fetched when it can be acted on — the picker is the only thing that reads it.
  const contacts = canWrite
    ? (await listContacts(undefined, { perPage: 100 })).page.items.map((person) => ({
        id: person.id,
        displayName: person.displayName,
        phone: person.phone,
      }))
    : [];

  const unreached =
    (breakdown.byStatus["no_answer"] ?? 0) +
    (breakdown.byStatus["busy"] ?? 0) +
    (breakdown.byStatus["failed"] ?? 0);

  const hasPurpose = campaign.purpose !== null && campaign.purpose.trim() !== "";

  /* The strip at the top: status and its moves, the reason, the progress, the figures. The
     same in every phase, because it is what is true right now, and the actions beside it are
     whatever the API allows from here. */
  const liveStrip = (
    <Card>
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-3">
        <CampaignStatusControl
          campaignId={campaign.id}
          status={campaign.status}
          pauseReason={campaign.pauseReason}
          canWrite={canWrite}
        />
        <div className="flex flex-wrap gap-2">
          {canWrite && phase !== "reading" && (
            <AddContactsButton campaignId={campaign.id} contacts={contacts} />
          )}
          {canWrite && <DuplicateCampaignButton campaignId={campaign.id} name={campaign.name} />}
        </div>
      </div>

      <div className="mt-5 grid gap-6 lg:grid-cols-2">
        <div className="border-l-2 border-[var(--accent)] pl-3.5">
          <div className="mb-1.5 text-[11px] tracking-[0.06em] text-[var(--ink-3)] uppercase">Why it rings</div>
          {hasPurpose ? (
            <Purpose text={campaign.purpose ?? ""} />
          ) : (
            <p className="text-[14px] text-[var(--ink-3)]">
              No reason written yet. It is the first field in the brief below.
            </p>
          )}
        </div>

        <div>
          <CampaignProgress
            pending={campaign.pending}
            total={campaign.total}
            empty="Nobody on it yet. Add contacts and each one becomes a pending call."
          />
          <div className="mt-4 flex gap-8">
            <Figure label="Pending" value={campaign.pending} />
            <Figure label="Answered" value={campaign.answered} />
            <Figure label="On the campaign" value={campaign.total} />
          </div>
          {/* Two numbers turned into a sentence, only while there is something to project.
              Rough on purpose; the reasoning is on `projectedFinish`. */}
          {phase === "watching" && projectedFinish(campaign) !== null && (
            <p className="mt-3 text-[12px] text-[var(--ink-3)]">{projectedFinish(campaign)}</p>
          )}
        </div>
      </div>
    </Card>
  );

  /* The sidebar: true of a campaign in every phase. */
  /* The window and the run, side by side. They were a 310px sidebar, stacked, which meant
     the strip was drawn narrow and the two date pickers wrapped under their own labels.
     Given the whole width they sit as two columns and each gets room to be legible. */
  const scheduleTab = (
    <div className="grid items-start gap-3.5 lg:grid-cols-2">
      <Card title="Hours it may ring">
        <CampaignCallingWindow
          campaignId={campaign.id}
          window={campaign.callingWindow}
          canWrite={canWrite}
        />
      </Card>

      <Card title="When it runs">
        <CampaignSchedule
          campaignId={campaign.id}
          startsAt={campaign.startsAt}
          endsAt={campaign.endsAt}
          startEditable={campaign.briefEditable}
          canWrite={canWrite}
        />
      </Card>
    </div>
  );

  /* Frozen, so read-only, so a panel rather than a form. What it says is still the first
     thing to check when a call sounds wrong, and it lost its sidebar home when the sidebar
     went — so it is a tab of its own on a campaign that has started. */
  const saysTab = (
    <Card title="What it says">
      <div className="max-w-[70ch]">
        {hasPurpose ? (
          <Purpose text={campaign.purpose ?? ""} />
        ) : (
          <p className="text-[12.5px] text-[var(--ink-3)]">No purpose was written.</p>
        )}
        {campaign.opening !== null && campaign.opening.trim() !== "" && (
          <p className="mt-3.5 border-t border-[var(--hairline)] pt-3.5 text-[13px] leading-relaxed text-[var(--ink-2)]">
            <span className="text-[var(--ink-3)]">Opens with: </span>
            {campaign.opening}
          </p>
        )}
        {campaign.outcomes !== null && campaign.outcomes.length > 0 && (
          <p className="mt-3.5 border-t border-[var(--hairline)] pt-3.5 text-[12.5px] leading-relaxed text-[var(--ink-3)]">
            Records one of: {campaign.outcomes.join(", ")}.
          </p>
        )}
        <p className="mt-3.5 text-[11.5px] text-[var(--ink-3)]">
          Fixed since it started. To say something different, duplicate it.
        </p>
      </div>
    </Card>
  );

  const callsTab = (
    <>
      <div className="mb-3.5 flex flex-wrap items-center justify-between gap-3">
        <CallStatusFilter
          basePath={`/campaigns/${campaign.id}`}
          active={status as ScheduledCallStatus | null}
          byStatus={breakdown.byStatus}
          total={campaign.total}
        />
        {canWrite && phase === "watching" && (
          <RetryUnreachedButton campaignId={campaign.id} unreached={unreached} />
        )}
      </div>
      <ScheduledCallsTable calls={calls.items} />
      <Pagination
        basePath={`/campaigns/${campaign.id}`}
        /* Carried through every page link. Without it, page two of the failures is page two
           of everything, and the filter silently falls off. */
        {...(status === null ? {} : { params: { status } })}
        page={calls.page}
        perPage={calls.perPage}
        totalPages={calls.totalPages}
        total={calls.total}
        unit="calls"
      />
    </>
  );

  return (
    <>
      {/* The same 1600px the agent workspace takes: the conversation canvas is a drawing
          surface, and a drawing inside 1080 pixels is a drawing nobody can see. */}
      <WidePage />

      {/* A page somebody is watching has to move. `router.refresh()` re-runs this component
          in place, so the strip, the breakdown and the feed all advance together without a
          reload, and nothing is polled for a campaign that is not dialling. */}
      {phase === "watching" && <AutoRefresh intervalMs={LIVE_REFRESH_MS} />}

      <PageHeader
        eyebrow="Campaigns"
        title={campaign.name}
        meta={`${agentName} · ${windowSummary(campaign.callingWindow)}`}
        actions={
          <Link href="/campaigns" className={buttonClass()}>
            All campaigns
          </Link>
        }
      />

      <div className="flex flex-col gap-3.5">
          {liveStrip}

          {phase === "setup" ? (
            <>
              <SetupChecklist campaign={campaign} />
              <Tabs
                initial="brief"
                tabs={[
                  {
                    id: "brief",
                    label: "Brief",
                    panel: (
                      <CampaignBrief
                        campaignId={campaign.id}
                        editable={campaign.briefEditable}
                        canWrite={canWrite}
                        values={{
                          purpose: campaign.purpose,
                          opening: campaign.opening,
                          outcomes: campaign.outcomes,
                          voicemail: campaign.voicemail,
                          maxAttempts: campaign.maxAttempts,
                          retryAfterMinutes: campaign.retryAfterMinutes,
                        }}
                      />
                    ),
                  },
                  {
                    id: "conversation",
                    label: "Conversation",
                    panel: (
                      <CampaignConversation
                        campaignId={campaign.id}
                        flow={campaign.flow}
                        editable={campaign.briefEditable}
                        canWrite={canWrite}
                        tools={tools}
                        transferNumber={null}
                      />
                    ),
                  },
                  { id: "calls", label: "People", panel: callsTab },
                  { id: "schedule", label: "Schedule", panel: scheduleTab },
                ]}
              />
            </>
          ) : (
            <>
              {/* Reading leads with the verdicts, because that is the answer the campaign
                  existed to produce. Watching leads with the feed, because the question then
                  is whether it is working right now. Same cards, opposite order. */}
              {phase === "reading" ? (
                <>
                  <Card title="How it went">
                    <CampaignBreakdown byStatus={breakdown.byStatus} byOutcome={breakdown.byOutcome} />
                  </Card>
                  <Card title="The last calls">
                    <RecentCallsFeed calls={recent.items} />
                  </Card>
                </>
              ) : (
                <>
                  <Card
                    title="Happening now"
                    description="The last ten calls, newest first. This page refreshes itself every fifteen seconds while the campaign is running."
                  >
                    <RecentCallsFeed calls={recent.items} />
                  </Card>
                  <Card title="How it is going">
                    <CampaignBreakdown byStatus={breakdown.byStatus} byOutcome={breakdown.byOutcome} />
                  </Card>
                </>
              )}

              <Tabs
                initial="calls"
                tabs={[
                  { id: "calls", label: "Every call", panel: callsTab },
                  { id: "says", label: "What it says", panel: saysTab },
                  { id: "schedule", label: "Schedule", panel: scheduleTab },
                  {
                    id: "conversation",
                    label: "Conversation",
                    panel: (
                      <CampaignConversation
                        campaignId={campaign.id}
                        flow={campaign.flow}
                        editable={false}
                        canWrite={canWrite}
                        tools={tools}
                        transferNumber={null}
                      />
                    ),
                  },
                ]}
              />
            </>
          )}
      </div>
    </>
  );
};

export default CampaignPage;
