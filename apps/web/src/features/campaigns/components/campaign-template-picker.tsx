"use client";

import { Check, Search } from "lucide-react";
import { useMemo, useState } from "react";

import { Button, Modal, SearchField } from "@/components/ui";
import { cn } from "@/lib/cn";

import { CAMPAIGN_SECTORS, CAMPAIGN_TEMPLATES, type CampaignTemplate } from "../campaign-templates";

const pad = (n: number): string => String(n).padStart(2, "0");

/** A retry policy as one short phrase: "3× · 4h apart". */
const policy = (template: CampaignTemplate): string => {
  const gap =
    template.retryAfterMinutes >= 1440
      ? `${Math.round(template.retryAfterMinutes / 1440)}d`
      : template.retryAfterMinutes >= 60
        ? `${Math.round(template.retryAfterMinutes / 60)}h`
        : `${template.retryAfterMinutes}m`;
  return template.maxAttempts === 1 ? "once" : `${template.maxAttempts}× · ${gap} apart`;
};

const hours = (template: CampaignTemplate): string =>
  template.callingWindow === null
    ? "08–20"
    : `${pad(template.callingWindow.startHour)}–${pad(template.callingWindow.endHour)}`;

const facts = (template: CampaignTemplate): readonly string[] => [
  policy(template),
  `${hours(template)} WAT`,
  template.voicemail === "hang_up" ? "no voicemail" : "leaves a message",
];

/**
 * The template gallery, in the same modal the agent gallery uses.
 *
 * The same shape on purpose — search, sector chips, a scrolling grid, pick-closes — so
 * somebody who has built an agent already knows how to start a campaign. Picking closes:
 * the pick is the act, and a second button would make the card an inert border around a
 * footer.
 */
export const CampaignTemplateGallery = ({
  open,
  onClose,
  selectedId,
  onSelect,
}: {
  readonly open: boolean;
  readonly onClose: () => void;
  readonly selectedId: string;
  readonly onSelect: (id: string) => void;
}) => {
  const [query, setQuery] = useState("");
  const [sector, setSector] = useState<string | null>(null);

  const shown = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return CAMPAIGN_TEMPLATES.filter((template) => {
      if (sector !== null && template.sector !== sector) return false;
      if (needle === "") return true;
      return `${template.name} ${template.sector} ${template.summary} ${template.purpose}`
        .toLowerCase()
        .includes(needle);
    });
  }, [query, sector]);

  return (
    <Modal
      open={open}
      onClose={onClose}
      size="wide"
      title="Choose a starting point"
      description="Every template is a campaign somebody actually runs — the reason the agent opens with, the verdicts it records, the conversation it has when the person says something back, and a retry policy that suits the subject. Pick one, give it a name, add the people, and it can start."
    >
      <div className="flex flex-col gap-3">
        <SearchField
          label="Search templates"
          autoFocus
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Search — rent, appointment, delivery, fees…"
        />

        <div className="flex flex-wrap gap-1.5" role="group" aria-label="Kind of organisation">
          <Chip on={sector === null} onClick={() => setSector(null)}>
            All
          </Chip>
          {CAMPAIGN_SECTORS.map((one) => (
            <Chip key={one} on={sector === one} onClick={() => setSector(sector === one ? null : one)}>
              {one}
            </Chip>
          ))}
        </div>

        <div className="max-h-[56vh] overflow-y-auto pr-1">
          {shown.length === 0 ? (
            <p className="py-10 text-center text-[13px] text-[var(--ink-3)]">Nothing matches that.</p>
          ) : (
            <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2 lg:grid-cols-3">
              {shown.map((template) => (
                <TemplateCard
                  key={template.id}
                  template={template}
                  selected={template.id === selectedId}
                  onPick={() => {
                    onSelect(template.id);
                    onClose();
                  }}
                />
              ))}
            </div>
          )}
        </div>

        <p className="text-[12px] text-[var(--ink-3)]">
          {shown.length} of {CAMPAIGN_TEMPLATES.length} templates
        </p>
      </div>
    </Modal>
  );
};

const Chip = ({
  on,
  onClick,
  children,
}: {
  readonly on: boolean;
  readonly onClick: () => void;
  readonly children: string;
}) => (
  <button
    type="button"
    aria-pressed={on}
    onClick={onClick}
    className={cn(
      "rounded-full border px-2.5 py-1 text-[12px] transition-colors",
      on
        ? "border-transparent bg-[var(--accent)] text-[var(--accent-on)]"
        : "border-[var(--hairline)] text-[var(--ink-2)] hover:border-[var(--ink-3)]",
    )}
  >
    {children}
  </button>
);

/**
 * What a template does, on a card: the name, the sector, one line, and the three facts that
 * decide whether it fits — how many tries, what hours, whether it leaves a message.
 */
export const TemplateCard = ({
  template,
  selected,
  onPick,
}: {
  readonly template: CampaignTemplate;
  readonly selected: boolean;
  readonly onPick: () => void;
}) => (
  <button
    type="button"
    aria-pressed={selected}
    onClick={onPick}
    className={cn(
      "flex h-full flex-col gap-2 rounded-lg border p-3.5 text-left transition-colors",
      selected
        ? "border-[var(--accent)] bg-[var(--accent-soft)]"
        : "border-[var(--hairline)] hover:border-[var(--ink-3)]",
    )}
  >
    <div className="flex items-start justify-between gap-2">
      <div className="min-w-0">
        <div className="text-[13.5px] leading-tight font-medium text-[var(--ink)]">{template.name}</div>
        <div className="mt-0.5 text-[11px] text-[var(--ink-3)]">{template.sector}</div>
      </div>
      {selected && <Check className="size-4 flex-none text-[var(--accent)]" aria-hidden />}
    </div>
    <p className="text-[12px] leading-relaxed text-[var(--ink-2)]">{template.summary}</p>
    <p className="mt-auto text-[11px] tabular-nums text-[var(--ink-3)]">{facts(template).join(" · ")}</p>
  </button>
);

export const BrowseTemplatesButton = ({ onClick }: { readonly onClick: () => void }) => (
  <Button variant="secondary" onClick={onClick}>
    <Search className="size-3.5" />
    Browse {CAMPAIGN_TEMPLATES.length} templates
  </Button>
);

/**
 * The chosen template, opened up: what the agent will say, what the list has to carry, what
 * it records, and why it is shaped this way. This is where a template teaches, and it is on
 * the page rather than in the modal because it is read *after* the pick, when the modal has
 * closed and the person is deciding whether they meant it.
 */
export const ChosenTemplate = ({ template }: { readonly template: CampaignTemplate }) => (
  <div className="rounded-lg border border-[var(--hairline)] p-4">
    <div className="grid gap-x-8 gap-y-4 lg:grid-cols-2">
      <div>
        <div className="text-[11px] tracking-[0.06em] text-[var(--ink-3)] uppercase">
          It opens by saying it is calling
        </div>
        <p className="mt-1 text-[14px] leading-relaxed text-[var(--ink)]">…{template.purpose}</p>
        {template.facts.length > 0 && (
          <div className="mt-3">
            <div className="text-[11px] tracking-[0.06em] text-[var(--ink-3)] uppercase">Each contact needs</div>
            <ul className="mt-1 flex flex-col gap-0.5 text-[12.5px] text-[var(--ink-2)]">
              {template.facts.map((fact) => (
                <li key={fact.key}>
                  <code className="rounded bg-[var(--accent-soft)] px-1 py-0.5 text-[11.5px] text-[var(--accent)]">
                    {`{${fact.key}}`}
                  </code>{" "}
                  <span className="text-[var(--ink-3)]">e.g. {fact.example}</span>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
      <div>
        <div className="text-[11px] tracking-[0.06em] text-[var(--ink-3)] uppercase">It records one of</div>
        <p className="mt-1 text-[12.5px] leading-relaxed text-[var(--ink-2)]">{template.outcomes.join(" · ")}</p>
        <div className="mt-3 text-[11px] tracking-[0.06em] text-[var(--ink-3)] uppercase">
          Why it is shaped this way
        </div>
        <p className="mt-1 text-[12.5px] leading-relaxed text-[var(--ink-2)]">{template.rationale}</p>
      </div>
    </div>
  </div>
);
