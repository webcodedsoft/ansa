import Link from "next/link";

import { Tag } from "@/components/ui";
import { when } from "@/lib/format";

import { campaignTone, windowSummary } from "../campaigns.display";
import type { CampaignSummary } from "../campaigns.service";

/**
 * How far through a campaign is, as a bar and a figure.
 *
 * "Done" is total minus pending rather than answered: a call that rang out, hit voicemail or
 * was suppressed is finished with, and counting only answers would leave a campaign that has
 * dialled everybody sitting at 40% forever. Answered is shown separately because it is the
 * number somebody actually cares about, and the two say different things.
 *
 * A campaign with nobody on it renders no bar at all. Zero of zero is not 0% or 100%, and
 * drawing either would be inventing a fact about an empty list.
 */
const Progress = ({ campaign }: { readonly campaign: CampaignSummary }) => {
  if (campaign.total === 0) {
    return (
      <p className="text-[12px] text-[var(--ink-3)]">
        Nobody on it yet — add contacts to give it something to dial.
      </p>
    );
  }

  const settled = campaign.total - campaign.pending;
  const percent = Math.round((settled / campaign.total) * 100);

  return (
    <div>
      <div className="mb-1.5 flex items-baseline justify-between gap-2">
        <span className="text-[12px] text-[var(--ink-3)]">
          {settled} of {campaign.total} called
        </span>
        <span className="text-[12px] tabular-nums text-[var(--ink-3)]">{percent}%</span>
      </div>
      <div
        /* `--hairline`, not `--surface-2`. The track has to stay visible against the card it
           sits on in both themes, and `--surface-2` is white at 60% in light mode — an
           invisible track on a white card, which reads as a bar that is always at 100%. */
        className="h-1.5 overflow-hidden rounded-full bg-[var(--hairline)]"
        role="progressbar"
        aria-valuenow={percent}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-label={`${settled} of ${campaign.total} called`}
      >
        <div
          className="h-full rounded-full bg-[var(--accent)] transition-[width]"
          style={{ width: `${percent}%` }}
        />
      </div>
    </div>
  );
};

const Figure = ({ label, value }: { readonly label: string; readonly value: number }) => (
  <div>
    <div className="text-[17px] leading-none font-medium tabular-nums text-[var(--ink)]">
      {value}
    </div>
    <div className="mt-1 text-[11px] tracking-[0.06em] text-[var(--ink-3)] uppercase">{label}</div>
  </div>
);

/**
 * One campaign, as a card.
 *
 * The table this replaced put six columns of equal weight side by side, which is the wrong
 * shape for the question people bring to this screen: not "what are the numbers" but "which
 * of these is running, and how far has it got". So the card leads with the name and the
 * state, gives the progress its own row, and demotes the counts to a footer.
 *
 * The whole card is one link rather than the name alone. A card that looks clickable and is
 * only clickable on six characters of text is the kind of thing people blame themselves for.
 */
export const CampaignCard = ({
  campaign,
  agentName,
}: {
  readonly campaign: CampaignSummary;
  readonly agentName: string;
}) => (
  <Link
    href={`/campaigns/${campaign.id}`}
    className="surface flex flex-col gap-3.5 rounded-xl p-4 transition-colors hover:border-[var(--ink-3)] focus-visible:border-[var(--accent)]"
  >
    <div className="flex items-start justify-between gap-3">
      <div className="min-w-0">
        <h3 className="truncate text-[14px] leading-snug font-medium text-[var(--ink)]">
          {campaign.name}
        </h3>
        <p className="mt-0.5 truncate text-[12px] text-[var(--ink-3)]">{agentName}</p>
      </div>
      <Tag tone={campaignTone[campaign.status]}>{campaign.status}</Tag>
    </div>

    <Progress campaign={campaign} />

    <p className="text-[12px] leading-relaxed text-[var(--ink-2)]">
      {windowSummary(campaign.callingWindow)}
    </p>

    <div className="mt-auto flex items-end justify-between gap-3 border-t border-[var(--hairline)] pt-3">
      <div className="flex gap-6">
        <Figure label="Pending" value={campaign.pending} />
        <Figure label="Answered" value={campaign.answered} />
      </div>
      <span className="text-[11.5px] whitespace-nowrap text-[var(--ink-3)]">
        {when(campaign.createdAt)}
      </span>
    </div>
  </Link>
);
