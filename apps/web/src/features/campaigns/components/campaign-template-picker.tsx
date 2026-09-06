"use client";

import { Check } from "lucide-react";
import { useMemo, useState } from "react";

import { CONTROL } from "@/components/ui";
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

/**
 * Pick a campaign to start from, or none.
 *
 * Inline rather than behind a modal, because seventeen cards is a choice and not a page —
 * the agent gallery hides seventy behind a button for the opposite reason. The cards are
 * deliberately dense: name, one line, and three facts that decide whether it fits (how many
 * tries, what hours, whether it leaves a message). The reasoning behind each is on the
 * chosen card only, so it reads as the explanation of a decision rather than as seventeen
 * paragraphs competing for attention.
 *
 * "Start from scratch" is a real card and the first one, so the blank path is a choice made
 * rather than the absence of one.
 */
export const CampaignTemplatePicker = ({
  selectedId,
  onSelect,
}: {
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

  const chosen = CAMPAIGN_TEMPLATES.find((template) => template.id === selectedId) ?? null;

  const chip = (on: boolean): string =>
    cn(
      "rounded-full border px-3 py-1 text-[12px] whitespace-nowrap transition-colors",
      on
        ? "border-[var(--accent)] bg-[var(--accent-soft)] text-[var(--ink)]"
        : "border-[var(--hairline)] text-[var(--ink-3)] hover:border-[var(--ink-3)]",
    );

  return (
    <div className="flex flex-col gap-3.5">
      {/* The pick, carried to the action under its own name. */}
      <input type="hidden" name="templateId" value={selectedId} />

      <div className="flex flex-wrap items-center gap-2">
        <input
          type="search"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Search — rent, appointment, delivery…"
          aria-label="Search templates"
          className={cn(CONTROL, "max-w-[18rem]")}
        />
        <div className="flex flex-wrap gap-1.5">
          <button type="button" className={chip(sector === null)} onClick={() => setSector(null)}>
            All
          </button>
          {CAMPAIGN_SECTORS.map((one) => (
            <button
              key={one}
              type="button"
              className={chip(sector === one)}
              onClick={() => setSector(sector === one ? null : one)}
            >
              {one}
            </button>
          ))}
        </div>
      </div>

      <div className="grid gap-2.5 sm:grid-cols-2 xl:grid-cols-3" role="radiogroup" aria-label="Template">
        {sector === null && query.trim() === "" && (
          <TemplateCard
            selected={selectedId === ""}
            onSelect={() => onSelect("")}
            name="Start from scratch"
            sector="Blank"
            summary="A name and an agent, nothing filled in. Write the brief yourself on the next screen."
          />
        )}
        {shown.map((template) => (
          <TemplateCard
            key={template.id}
            selected={selectedId === template.id}
            onSelect={() => onSelect(template.id)}
            name={template.name}
            sector={template.sector}
            summary={template.summary}
            facts={[
              policy(template),
              `${hours(template)} WAT`,
              template.voicemail === "hang_up" ? "no voicemail" : "leaves a message",
            ]}
          />
        ))}
        {shown.length === 0 && (
          <p className="col-span-full py-6 text-center text-[12.5px] text-[var(--ink-3)]">
            Nothing matches. Try a different word, or start from scratch.
          </p>
        )}
      </div>

      {chosen !== null && (
        /* The chosen one, opened up: what the agent will say, what it records, what the list
           has to carry, and why it is shaped this way. This is where the template teaches. */
        <div className="rounded-lg border border-[var(--accent)] bg-[var(--accent-soft)] p-4">
          <div className="grid gap-x-8 gap-y-4 lg:grid-cols-2">
            <div>
              <div className="text-[11px] tracking-[0.06em] text-[var(--ink-3)] uppercase">
                It opens by saying it is calling
              </div>
              <p className="mt-1 text-[14px] leading-relaxed text-[var(--ink)]">…{chosen.purpose}</p>
              {chosen.facts.length > 0 && (
                <div className="mt-3">
                  <div className="text-[11px] tracking-[0.06em] text-[var(--ink-3)] uppercase">
                    Each contact needs
                  </div>
                  <ul className="mt-1 flex flex-col gap-0.5 text-[12.5px] text-[var(--ink-2)]">
                    {chosen.facts.map((fact) => (
                      <li key={fact.key}>
                        <code className="rounded bg-[var(--surface)] px-1 py-0.5 text-[11.5px] text-[var(--accent)]">
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
              <p className="mt-1 text-[12.5px] leading-relaxed text-[var(--ink-2)]">
                {chosen.outcomes.join(" · ")}
              </p>
              <div className="mt-3 text-[11px] tracking-[0.06em] text-[var(--ink-3)] uppercase">
                Why it is shaped this way
              </div>
              <p className="mt-1 text-[12.5px] leading-relaxed text-[var(--ink-2)]">{chosen.rationale}</p>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

const TemplateCard = ({
  selected,
  onSelect,
  name,
  sector,
  summary,
  facts = [],
}: {
  readonly selected: boolean;
  readonly onSelect: () => void;
  readonly name: string;
  readonly sector: string;
  readonly summary: string;
  readonly facts?: readonly string[];
}) => (
  <button
    type="button"
    role="radio"
    aria-checked={selected}
    onClick={onSelect}
    className={cn(
      "flex flex-col gap-2 rounded-lg border p-3.5 text-left transition-colors",
      selected
        ? "border-[var(--accent)] bg-[var(--accent-soft)]"
        : "border-[var(--hairline)] hover:border-[var(--ink-3)]",
    )}
  >
    <div className="flex items-start justify-between gap-2">
      <div className="min-w-0">
        <div className="text-[13.5px] leading-tight font-medium text-[var(--ink)]">{name}</div>
        <div className="mt-0.5 text-[11px] text-[var(--ink-3)]">{sector}</div>
      </div>
      {selected && <Check className="size-4 flex-none text-[var(--accent)]" aria-hidden />}
    </div>
    <p className="text-[12px] leading-relaxed text-[var(--ink-2)]">{summary}</p>
    {facts.length > 0 && (
      <p className="mt-auto text-[11px] tabular-nums text-[var(--ink-3)]">{facts.join(" · ")}</p>
    )}
  </button>
);
