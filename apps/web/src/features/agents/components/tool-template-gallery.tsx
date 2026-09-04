"use client";

import { Check, Search } from "lucide-react";
import { useMemo, useState } from "react";

import { Button, CONTROL, Modal, Tag, type Tone } from "@/components/ui";
import { cn } from "@/lib/cn";

import { TOOL_CATALOGUE, TOOL_SECTORS } from "../tool-catalogue";
import type { ToolTemplate } from "../tool-templates";

/**
 * The tool gallery, opened from the first step of adding a tool.
 *
 * Every card is a complete tool — what it does, what it needs, how it speaks — that only
 * lacks the organisation's own address. Picking one fills the whole form; the person then
 * changes the host, chooses a credential, and tests it on step five against their system.
 */
const TIER: Record<ToolTemplate["draft"]["riskTier"], { readonly label: string; readonly tone: Tone }> = {
  read: { label: "looks up", tone: "ok" },
  write: { label: "changes something — read back first", tone: "warn" },
  irreversible: { label: "hands over to a person", tone: "bad" },
};

export const ToolTemplateGallery = ({
  open,
  onClose,
  onPick,
  taken,
}: {
  readonly open: boolean;
  readonly onClose: () => void;
  readonly onPick: (template: ToolTemplate) => void;
  /** Names already in the registry, so a card says so rather than failing on save. */
  readonly taken: readonly string[];
}) => {
  const [query, setQuery] = useState("");
  const [sector, setSector] = useState<string | null>(null);

  const shown = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return TOOL_CATALOGUE.filter((tool) => {
      if (sector !== null && tool.sector !== sector) return false;
      if (needle === "") return true;
      return `${tool.name} ${tool.draft.name} ${tool.sector} ${tool.summary}`.toLowerCase().includes(needle);
    });
  }, [query, sector]);

  return (
    <Modal
      open={open}
      onClose={onClose}
      size="wide"
      title="Start from a tool template"
      description="A complete tool for something a business like yours looks up or does on a call. Pick one, replace the host with your system's address, choose a credential, and test it."
    >
      <div className="flex flex-col gap-3">
        <label className="relative block">
          <Search aria-hidden className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-[var(--ink-3)]" />
          <input
            autoFocus
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search — booking, claim, stock, outage…"
            aria-label="Search tool templates"
            className={cn(CONTROL, "pl-9")}
          />
        </label>

        <div className="flex flex-wrap gap-1.5" role="group" aria-label="Kind of business">
          <Chip on={sector === null} onClick={() => setSector(null)}>All</Chip>
          {TOOL_SECTORS.map((one) => (
            <Chip key={one} on={sector === one} onClick={() => setSector(sector === one ? null : one)}>{one}</Chip>
          ))}
        </div>

        <div className="max-h-[56vh] overflow-y-auto pr-1">
          {shown.length === 0 ? (
            <p className="py-10 text-center text-[13px] text-[var(--ink-3)]">Nothing matches that.</p>
          ) : (
            <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2 lg:grid-cols-3">
              {shown.map((tool) => {
                const exists = taken.includes(tool.draft.name);
                const tier = TIER[tool.draft.riskTier];
                return (
                  <button
                    key={tool.id}
                    type="button"
                    onClick={() => {
                      onPick(tool);
                      onClose();
                    }}
                    className="surface flex h-full flex-col items-start gap-1.5 rounded-xl border border-[var(--hairline)] p-3.5 text-left transition-colors hover:border-[var(--ink-3)]"
                  >
                    <span className="flex w-full items-start gap-2">
                      <span className="flex-1 font-mono text-[12.5px] font-semibold">{tool.draft.name}</span>
                      {exists && <Check aria-hidden className="mt-0.5 size-4 flex-none text-[var(--ink-3)]" />}
                    </span>
                    <span className="text-[11px] text-[var(--ink-3)]">{tool.sector}</span>
                    <span className="text-[12.5px] leading-snug text-[var(--ink-2)]">{tool.summary}</span>
                    <span className="mt-auto flex flex-wrap gap-1.5 pt-1">
                      <Tag tone={tier.tone}>{tier.label}</Tag>
                      {tool.draft.params.length > 0 && (
                        <Tag>
                          {tool.draft.params.length} {tool.draft.params.length === 1 ? "argument" : "arguments"}
                        </Tag>
                      )}
                      {exists && <Tag>already registered</Tag>}
                    </span>
                  </button>
                );
              })}
            </div>
          )}
        </div>

        <p className="text-[12px] text-[var(--ink-3)]">
          {shown.length} of {TOOL_CATALOGUE.length} tools
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
      on ? "border-transparent bg-[var(--accent)] text-[var(--accent-on)]" : "border-[var(--hairline)] text-[var(--ink-2)] hover:border-[var(--ink-3)]",
    )}
  >
    {children}
  </button>
);

export const BrowseToolTemplatesButton = ({ onClick }: { readonly onClick: () => void }) => (
  <Button variant="secondary" onClick={onClick}>
    <Search className="size-3.5" />
    Browse {TOOL_CATALOGUE.length} tool templates
  </Button>
);
