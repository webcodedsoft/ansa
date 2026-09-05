"use client";

import { Check, GitBranch, PhoneOutgoing, Search } from "lucide-react";
import { useMemo, useState } from "react";

import { Button, CONTROL, Modal, Tag } from "@/components/ui";
import { cn } from "@/lib/cn";

import { AGENT_TEMPLATES, allFields, servicesOf, TEMPLATE_SECTORS, type AgentTemplate } from "../templates";

/**
 * The template gallery: every complete agent, by the kind of business it is for.
 *
 * A modal rather than a wall of cards on the create screen, because seventy cards is not a
 * choice, it is a page. The gallery is searched and filtered; the create screen shows the
 * one that was chosen. Picking closes it — the pick is the act, and a second button would
 * make the card an inert border around a footer.
 */
export const TemplateGallery = ({
  open,
  onClose,
  selectedId,
  onSelect,
  mode,
}: {
  readonly open: boolean;
  readonly onClose: () => void;
  readonly selectedId: string;
  readonly onSelect: (id: string) => void;
  readonly mode: "form" | "flow";
}) => {
  const [query, setQuery] = useState("");
  const [sector, setSector] = useState<string | null>(null);

  const shown = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return AGENT_TEMPLATES.filter((template) => {
      if (sector !== null && template.sector !== sector) return false;
      if (needle === "") return true;
      return `${template.name} ${template.sector} ${template.summary}`.toLowerCase().includes(needle);
    });
  }, [query, sector]);

  return (
    <Modal
      open={open}
      onClose={onClose}
      size="wide"
      title="Choose a starting point"
      description={
        mode === "flow"
          ? "Every template is one organisation's whole front desk — each service it is rung about, its policies, and the words callers use. Pick one and it is drawn on the canvas, every fork and hand-over included; give the agent a name and it can go live."
          : "Every template is one organisation's whole front desk — each service it is rung about, its policies, and the words callers use. Pick one and its questions, greeting, rules and vocabulary are set; give the agent a name and it can go live."
      }
    >
      <div className="flex flex-col gap-3">
        <label className="relative block">
          <Search aria-hidden className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-[var(--ink-3)]" />
          <input
            autoFocus
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search — hospital, estate, bank, school, courier…"
            aria-label="Search templates"
            className={cn(CONTROL, "pl-9")}
          />
        </label>

        <div className="flex flex-wrap gap-1.5" role="group" aria-label="Kind of business">
          <Chip on={sector === null} onClick={() => setSector(null)}>
            All
          </Chip>
          {TEMPLATE_SECTORS.map((one) => (
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
                  mode={mode}
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
          {shown.length} of {AGENT_TEMPLATES.length} templates
        </p>
      </div>
    </Modal>
  );
};

const Chip = ({ on, onClick, children }: { readonly on: boolean; readonly onClick: () => void; readonly children: string }) => (
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

/** What a template does, on a card: the name, the sector, one line, and how much it asks. */
export const TemplateCard = ({
  template,
  mode,
  selected,
  onPick,
}: {
  readonly template: AgentTemplate;
  readonly mode: "form" | "flow";
  readonly selected: boolean;
  readonly onPick: () => void;
}) => {
  const questions = allFields(template).length;
  const services = servicesOf(template).length;
  return (
    <button
      type="button"
      onClick={onPick}
      aria-pressed={selected}
      className={cn(
        "surface flex h-full flex-col items-start gap-1.5 rounded-xl border p-3.5 text-left transition-colors",
        selected
          ? "border-[color-mix(in_srgb,var(--accent)_42%,transparent)] bg-[var(--accent-soft)]"
          : "border-[var(--hairline)] hover:border-[var(--ink-3)]",
      )}
    >
      <span className="flex w-full items-start gap-2">
        <span className="flex-1 text-[13.5px] font-semibold tracking-[-0.012em]">{template.name}</span>
        {selected && <Check aria-hidden className="mt-0.5 size-4 flex-none text-[var(--accent)]" />}
      </span>
      <span className="text-[11px] text-[var(--ink-3)]">{template.sector}</span>
      <span className="text-[12.5px] leading-snug text-[var(--ink-2)]">{template.summary}</span>
      <span className="mt-auto flex flex-wrap gap-1.5 pt-1">
        {questions > 0 && (
          <Tag>
            {questions} {questions === 1 ? "question" : "questions"}
          </Tag>
        )}
        {services > 0 && (
          <Tag tone="accent">
            <GitBranch aria-hidden className="size-3" />
            {services} services{mode === "form" ? ", as a form" : ""}
          </Tag>
        )}
        {template.answeringMachineDetection && (
          <Tag tone="warn">
            <PhoneOutgoing aria-hidden className="size-3" />
            outbound
          </Tag>
        )}
      </span>
    </button>
  );
};

/** The create screen's one-line way in, when nothing else about the gallery is showing. */
export const BrowseTemplatesButton = ({ onClick }: { readonly onClick: () => void }) => (
  <Button variant="secondary" onClick={onClick}>
    <Search className="size-3.5" />
    Browse {AGENT_TEMPLATES.length} templates
  </Button>
);
