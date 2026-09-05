"use client";

import { GripVertical, Plus } from "lucide-react";
import { useState, useTransition } from "react";

import {
  Button,
  CONTROL,
  Notice,
  Panel,
  PanelBody,
  Segmented,
  SettingRow,
  Tag,
  Toggle,
} from "@/components/ui";
import { cn } from "@/lib/cn";

import { saveCapturedFields } from "../agents.actions";
import {
  FIELD_TYPES,
  heardAs,
  readBackOf,
  PROMPT_EXAMPLE,
  RISKY_UNCONFIRMED,
  spokenValue,
} from "../capture-vocabulary";
import type { CapturedField } from "../agents.schema";

/**
 * The voice form this agent conducts.
 *
 * Three panes, and the third is the point of the screen: a field definition is a set of
 * dropdowns, and what it *sounds like* is the thing actually being designed. The preview is
 * generated from the settings, so choosing "keypad" and "spell back" shows you an agent
 * asking a caller to spell out digits they already typed — which is how you notice.
 *
 * Order is meaning. A caller asked for a date of birth before a policy number is having a
 * different conversation, so the list reorders and the whole array saves together: there is
 * no per-field endpoint, and a patch protocol over an ordered array would be a reorder API
 * nobody asked for.
 */

const CAPTURE = ["speech", "keypad", "either"] as const;
const CONFIRM = ["none", "readback", "spellback"] as const;

const CAPTURE_LABEL: Record<(typeof CAPTURE)[number], string> = {
  speech: "Speech",
  keypad: "Keypad",
  either: "Either",
};

const CONFIRM_LABEL: Record<(typeof CONFIRM)[number], string> = {
  none: "None",
  readback: "Read back",
  spellback: "Spell back",
};

/** And what the list under each name says, which is terser than the control's wording. */
const CONFIRM_SHORT: Record<(typeof CONFIRM)[number], string> = {
  none: "unconfirmed",
  readback: "read-back",
  spellback: "spell-back",
};

/** The line under each name: what it is, and how it is pinned down. */
const summarise = (field: CapturedField): string =>
  `${field.type} · ${field.confirm === "none" ? field.capture : CONFIRM_SHORT[field.confirm]}`;

const blankField = (index: number): CapturedField => ({
  key: `field${index + 1}`,
  type: "text",
  prompt: "",
  capture: "speech",
  confirm: "none",
  pattern: "",
  attempts: 3,
  required: true,
  options: [],
});



const Line = ({ who, text }: { readonly who: "agent" | "caller"; readonly text: string }) => (
  <div>
    <p className="mb-1 font-mono text-[9.5px] tracking-[0.13em] text-[var(--ink-3)] uppercase">
      {who}
    </p>
    <p
      className={cn(
        "rounded-[10px] border px-3 py-2 text-[12.5px]",
        who === "agent"
          ? "border-[var(--hairline)] bg-[var(--surface-2)] text-[var(--ink)]"
          : "border-[color-mix(in_srgb,var(--accent)_26%,transparent)] bg-[var(--accent-soft)] text-[var(--ink)]",
      )}
    >
      {text}
    </p>
  </div>
);

export const FieldBuilder = ({
  agentId,
  initial,
}: {
  readonly agentId: string;
  readonly initial: readonly CapturedField[];
}) => {
  const [fields, setFields] = useState<readonly CapturedField[]>(initial);
  const [selected, setSelected] = useState(0);
  const [dragging, setDragging] = useState<number | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [saving, startSaving] = useTransition();

  const current = fields[selected];

  const edit = (change: Partial<CapturedField>): void => {
    setSaved(false);
    setFields((all) => all.map((field, i) => (i === selected ? { ...field, ...change } : field)));
  };

  const add = (): void => {
    setSaved(false);
    setSelected(fields.length);
    setFields((all) => [...all, blankField(all.length)]);
  };

  const remove = (): void => {
    setSaved(false);
    setFields((all) => all.filter((_, i) => i !== selected));
    setSelected((index) => Math.max(0, index - 1));
  };

  const moveTo = (to: number): void => {
    if (dragging === null || dragging === to) return;
    setSaved(false);
    setFields((all) => {
      const next = [...all];
      const [moved] = next.splice(dragging, 1);
      if (moved !== undefined) next.splice(to, 0, moved);
      return next;
    });
    setSelected(to);
    setDragging(null);
  };

  const save = (): void => {
    setFailure(null);
    startSaving(async () => {
      const result = await saveCapturedFields(agentId, fields);
      if (result.ok) setSaved(true);
      else setFailure(result.message);
    });
  };

  // Chosen once, so the answer and the read-back are the same value. Two calls to the
  // sampler is how a preview ends up with an agent repeating something the caller
  // never said.
  const sample = current === undefined ? "" : spokenValue(current);

  return (
    <div className="flex flex-col gap-3.5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-[17px] font-semibold tracking-[-0.018em]">
            What this agent collects
          </h2>
          <p className="mt-1 max-w-[62ch] text-[13.5px] text-[var(--ink-3)]">
            A form conducted by voice. Each field says how it is asked for and — the part
            that matters — how it is confirmed before anything acts on it.
          </p>
        </div>
        <div className="flex flex-none items-center gap-2">
          {saved && !saving && <Tag tone="ok">Saved</Tag>}
          <Button type="button" onClick={save} disabled={saving}>
            {saving ? "Saving…" : "Save form"}
          </Button>
        </div>
      </div>

      {failure !== null && <Notice tone="error">{failure}</Notice>}

      <div className="grid grid-cols-1 gap-3.5 lg:grid-cols-[230px_minmax(0,1fr)_290px]">
        {/* The order of this list is the order the caller is asked. */}
        <Panel className="self-start">
          <div className="flex flex-col p-1.5">
            {fields.map((field, index) => (
              <button
                key={`${field.key}-${index}`}
                type="button"
                draggable
                onDragStart={() => setDragging(index)}
                onDragOver={(event) => event.preventDefault()}
                onDrop={() => moveTo(index)}
                onClick={() => setSelected(index)}
                className={cn(
                  "flex items-center gap-2 rounded-[10px] border px-2.5 py-2 text-left transition-colors",
                  index === selected
                    ? "border-[color-mix(in_srgb,var(--accent)_38%,transparent)] bg-[var(--accent-soft)]"
                    : "border-transparent hover:bg-[var(--surface-2)]",
                )}
              >
                <GripVertical aria-hidden className="size-3.5 flex-none text-[var(--ink-3)]" />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[13px] font-semibold">
                    {field.key === "" ? "Untitled field" : field.key}
                  </span>
                  <span className="block truncate font-mono text-[11px] text-[var(--ink-3)]">
                    {summarise(field)}
                  </span>
                </span>
                {field.required && (
                  <span
                    aria-label="Required"
                    title="Required"
                    className="size-[5px] flex-none rounded-full bg-[var(--warn)]"
                  />
                )}
              </button>
            ))}
            <Button type="button" size="sm" onClick={add} className="mt-1">
              <Plus aria-hidden className="size-3.5" />
              Add field
            </Button>
          </div>
        </Panel>

        {current === undefined ? (
          <Panel>
            <PanelBody>
              <p className="text-[13.5px] text-[var(--ink-3)]">
                No fields yet. Add one and the agent will ask for it, in the order this list
                puts them.
              </p>
            </PanelBody>
          </Panel>
        ) : (
          <Panel>
            <PanelBody>
              <div className="mb-4 flex items-start justify-between gap-3">
                <div>
                  <p className="font-mono text-[10px] tracking-[0.13em] text-[var(--ink-3)] uppercase">
                    Field {selected + 1} of {fields.length}
                  </p>
                  <h3 className="mt-1 text-[17px] font-semibold tracking-[-0.018em]">
                    {current.key === "" ? "Untitled field" : current.key}
                  </h3>
                </div>
                <Button type="button" size="sm" variant="danger" onClick={remove} className="flex-none">
                  Remove
                </Button>
              </div>

              <div className="flex flex-col gap-4">
                <div className="grid grid-cols-1 gap-3.5 sm:grid-cols-2">
                  <label className="block">
                    <span className="mb-1.5 block text-[13px] font-medium">Field name</span>
                    <input
                      value={current.key}
                      onChange={(event) => edit({ key: event.target.value })}
                      className={CONTROL}
                    />
                    <span className="mt-1.5 block text-[12.5px] text-[var(--ink-3)]">
                      How tools receive it.
                    </span>
                  </label>
                  <label className="block">
                    <span className="mb-1.5 block text-[13px] font-medium">Type</span>
                    <select
                      value={current.type}
                      onChange={(event) =>
                        edit({ type: event.target.value as CapturedField["type"] })
                      }
                      className={CONTROL}
                    >
                      {FIELD_TYPES.map((type) => (
                        <option key={type.value} value={type.value}>
                          {type.label}
                        </option>
                      ))}
                    </select>
                  </label>
                </div>

                <label className="block">
                  <span className="mb-1.5 block text-[13px] font-medium">How the agent asks</span>
                  <input
                    value={current.prompt}
                    onChange={(event) => edit({ prompt: event.target.value })}
                    placeholder={PROMPT_EXAMPLE[current.type]}
                    className={CONTROL}
                  />
                  <span className="mt-1.5 block text-[12.5px] text-[var(--ink-3)]">
                    Written as speech, not as a form label. It goes through the normalizer
                    before it is spoken.
                  </span>
                </label>

                <div>
                  <span className="mb-1.5 block text-[13px] font-medium">How it is captured</span>
                  <Segmented
                    options={CAPTURE}
                    value={current.capture}
                    label="How it is captured"
                    labels={CAPTURE_LABEL}
                    onChange={(next) => edit({ capture: next })}
                  />
                  <span className="mt-1.5 block text-[12.5px] text-[var(--ink-3)]">
                    Keypad tones survive an 8 kHz line intact. For anything with a checkable
                    structure, prefer it — it is the difference between a guess and a fact.
                  </span>
                </div>

                <div>
                  <span className="mb-1.5 block text-[13px] font-medium">How it is confirmed</span>
                  <Segmented
                    options={CONFIRM}
                    value={current.confirm}
                    label="How it is confirmed"
                    labels={CONFIRM_LABEL}
                    onChange={(next) => edit({ confirm: next })}
                  />
                  <span className="mt-1.5 block text-[12.5px] text-[var(--ink-3)]">
                    {current.confirm === "none" && RISKY_UNCONFIRMED.has(current.type)
                      ? "Taken as heard. On an 8 kHz line the transcriber is confident and wrong often enough that this can fetch the wrong record — and a write-tier tool naming this field will still refuse to fire on a value nothing confirmed."
                      : "Enforced in the dispatch path, not asked of the model. A write-tier tool will not fire on an unconfirmed value however confident the transcriber was."}
                  </span>
                </div>

                <div className="grid grid-cols-1 gap-3.5 sm:grid-cols-2">
                  <label className="block">
                    <span className="mb-1.5 block text-[13px] font-medium">Must match</span>
                    <input
                      value={current.pattern}
                      onChange={(event) => edit({ pattern: event.target.value })}
                      placeholder="^[A-Z]{2}[0-9]{7}$"
                      className={cn(CONTROL, "font-mono text-[13px]")}
                    />
                    <span className="mt-1.5 block text-[12.5px] text-[var(--ink-3)]">
                      Rejected values are re-asked, not passed on.
                    </span>
                  </label>
                  <label className="block">
                    <span className="mb-1.5 block text-[13px] font-medium">
                      Attempts before escalating
                    </span>
                    <input
                      type="number"
                      min={1}
                      max={10}
                      value={current.attempts}
                      onChange={(event) => edit({ attempts: Number(event.target.value) })}
                      className={CONTROL}
                    />
                    <span className="mt-1.5 block text-[12.5px] text-[var(--ink-3)]">
                      Then it transfers to a person.
                    </span>
                  </label>
                </div>

                <div>
                  <SettingRow
                    title="Required"
                    description="The agent will not move on without it."
                    control={
                      <Toggle
                        checked={current.required}
                        label="Required"
                        onChange={(next) => edit({ required: next })}
                      />
                    }
                  />
                </div>
              </div>
            </PanelBody>
          </Panel>
        )}

        {/* Generated from the settings rather than written by hand: the exchange is what is
            being designed, and seeing it is how somebody notices that "keypad" plus "spell
            back" asks a caller to spell out digits they already typed. */}
        <div className="glass self-start rounded-xl p-4">
          <h3 className="text-[13.5px] font-semibold">How this will sound</h3>
          <p className="mt-1 text-[12.5px] text-[var(--ink-3)]">
            Generated from the settings on the left. This is the exchange the caller hears.
          </p>

          {current === undefined ? (
            <p className="mt-3 text-[12.5px] text-[var(--ink-3)]">Nothing to preview yet.</p>
          ) : (
            <div className="mt-3.5 flex flex-col gap-2.5">
              <Line who="agent" text={current.prompt === "" ? "…" : current.prompt} />
              <Line
                who="caller"
                text={heardAs(current, sample)}
              />
              {current.confirm !== "none" && (
                <>
                  <Line who="agent" text={readBackOf(current, sample)} />
                  <Line who="caller" text="Yes." />
                </>
              )}
              <div className="mt-1 flex flex-wrap items-center gap-1.5">
                {current.confirm === "none" ? (
                  <Tag tone="warn">not confirmed</Tag>
                ) : (
                  <Tag tone="ok">confirmed</Tag>
                )}
                <Tag>
                  {current.confirm === "none"
                    ? "write-tier tools will refuse it"
                    : "tools may now use it"}
                </Tag>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
