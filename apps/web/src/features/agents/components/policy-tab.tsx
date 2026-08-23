"use client";

import { useEffect, useRef, useState } from "react";
import type { ClipboardEvent } from "react";

import { Button, Card, FieldError, Notice, Stack, TextAreaField, TextField } from "@/components/ui";

import type { LiveConfiguration } from "../agents.service";
import {
  adviseLines,
  applySplit,
  countEntries,
  splitPasted,
  type LineAdvice,
} from "../policy-lines";
import { parsePolicies, renderPolicies } from "../policy-text";

/**
 * The organisation's own rules, in whichever of two views suits the person writing them.
 *
 * The API has accepted these since migration 0046 and nothing could set them: the console
 * published a whole configuration document with no policy editor in it, which is why
 * `publish_agent_config` coalesces a null `policy_blocks` to the stored value.
 *
 * **Two views of one thing, and a button between them.** The split view is fields with the whole
 * set visible on the left; the document view is the block the model receives. Neither is right
 * for everybody — somebody drafting a first policy wants the fields, somebody pasting three out
 * of an existing handbook wants the document — so the choice is theirs and it is remembered.
 *
 * **Structure stays canonical.** `policyBlocks` reaches the API as an array of objects, so the
 * document is a rendering of the data and never the reverse. Rendering is total; parsing is not,
 * which makes the two directions unequal and the swap the only dangerous moment. It is handled
 * by validating the headings and refusing: while a line sits somewhere the parser cannot place
 * it, the button back is disabled and the line is named. `policy-text.ts` holds the round-trip
 * contract and the tests that pin it.
 *
 * **A document that does not parse saves nothing.** The hidden field is not rendered at all in
 * that state, and an absent field means "leave the stored policies alone" — see
 * `agents.schema.ts`. The alternative, writing the half we understood, would delete the rest.
 */

export interface PolicyBlock {
  name: string;
  applies: string;
  canDo: string[];
  cannotDo: string[];
  escalateWhen: string[];
}

type View = "split" | "prompt";

/** Both ceilings match the API's, so the editor cannot compose a document it will refuse. */
const MAX_BLOCKS = 12;
const MAX_LINE = 300;

/** How somebody likes to work, not configuration. It never leaves the browser. */
const VIEW_KEY = "ansa.policies.view";

const emptyBlock = (): PolicyBlock => ({
  name: "",
  applies: "",
  canDo: [],
  cannotDo: [],
  escalateWhen: [],
});

const LIST_LABELS = {
  canDo: "What it can do",
  cannotDo: "What it must not do",
  escalateWhen: "When it hands over to a person",
} as const;

const LIST_KEYS = ["canDo", "cannotDo", "escalateWhen"] as const;

/**
 * Blank lines are dropped on the way out, not on the way in.
 *
 * Somebody who leaves a trailing newline while thinking should not have it deleted under the
 * cursor, and a block with no name was abandoned rather than written. Trimming at submit keeps
 * editing forgiving and the published document clean — different jobs, different rules.
 */
const cleaned = (blocks: readonly PolicyBlock[]): PolicyBlock[] =>
  blocks
    .map((block) => ({
      name: block.name.trim(),
      applies: block.applies.trim(),
      canDo: block.canDo.map((line) => line.trim()).filter((line) => line !== ""),
      cannotDo: block.cannotDo.map((line) => line.trim()).filter((line) => line !== ""),
      escalateWhen: block.escalateWhen.map((line) => line.trim()).filter((line) => line !== ""),
    }))
    .filter((block) => block.name !== "" && block.applies !== "");

/** Every line, whichever list it is in, so a length problem is reported once and in words. */
const tooLong = (blocks: readonly PolicyBlock[]): readonly string[] =>
  blocks.flatMap((block) =>
    LIST_KEYS.flatMap((key) =>
      block[key]
        .filter((line) => line.length > MAX_LINE)
        .map((line) => `“${line.slice(0, 40)}…” in ${block.name || "an unnamed policy"}`),
    ),
  );

/**
 * Words too common to mean anything when comparing two applies-clauses.
 *
 * "The caller wants" is in every one of them, so without this every pair looks like a clash and
 * the warning becomes noise somebody learns to ignore.
 */
const STOPWORDS = new Set([
  "the", "a", "an", "and", "or", "to", "for", "of", "is", "it", "they", "them", "their", "that",
  "this", "with", "on", "in", "at", "by", "has", "have", "been", "was", "were", "be", "caller",
  "customer", "wants", "want", "asks", "ask", "about", "something", "already", "not", "no",
]);

const significant = (text: string): ReadonlySet<string> =>
  new Set(
    text
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((word) => word.length > 3 && !STOPWORDS.has(word)),
  );

/**
 * Two policies that could both match the same caller.
 *
 * The prompt already forbids reasoning by analogy between blocks, and nothing stops an author
 * writing two that genuinely both apply — a refund rule reached for a cancellation. Two shared
 * significant words is a low bar deliberately: this warns, it does not refuse.
 */
const overlapping = (blocks: readonly PolicyBlock[]): ReadonlySet<number> => {
  const shared = new Set<number>();
  const words = blocks.map((block) => significant(block.applies));
  for (let left = 0; left < words.length; left += 1) {
    for (let right = left + 1; right < words.length; right += 1) {
      const both = [...(words[left] ?? [])].filter((word) => words[right]?.has(word));
      if (both.length >= 2) {
        shared.add(left);
        shared.add(right);
      }
    }
  }
  return shared;
};

interface PolicyTabProps {
  readonly config: LiveConfiguration["config"];
  readonly errors: Readonly<Record<string, string>>;
  readonly publishForm: string;
  readonly savingDraft: boolean;
}

/**
 * A list where "one per line" is true rather than requested.
 *
 * The hint under these boxes said it and nothing held it up. Three things now do, and the split
 * between them is the whole point: two are mechanical and one is a guess that is only ever
 * shown.
 *
 * - **The count is live.** A box reading "1 entry" when somebody meant three is the hint
 *   enforcing itself, and it costs a glance rather than a rejected save. This is the part that
 *   does most of the work, because the mistake becomes visible at the moment it is made.
 * - **Paste is normalised**, because a numbered list arriving from a handbook is unambiguous:
 *   the numbering is somebody else's formatting, not the words. A single-line paste is left to
 *   the browser so the undo stack survives ordinary editing.
 * - **A line that looks like several is reported with the parts it would become**, and splits
 *   only when pressed. `policy-lines.ts` explains why guessing here cannot be automatic.
 *
 * Typing stays untouched. Nothing rewrites the box under the cursor, so a trailing newline left
 * mid-thought is still there when the thought finishes.
 */
const LineListField = ({
  label,
  value,
  onChange,
}: {
  readonly label: string;
  readonly value: string;
  readonly onChange: (next: string) => void;
}) => {
  const box = useRef<HTMLTextAreaElement>(null);
  const [caret, setCaret] = useState<number | null>(null);

  useEffect(() => {
    if (caret === null) return;
    box.current?.setSelectionRange(caret, caret);
    setCaret(null);
  }, [caret]);

  const paste = (event: ClipboardEvent<HTMLTextAreaElement>): void => {
    const entries = splitPasted(event.clipboardData.getData("text/plain"));
    if (entries.length === 0) return;

    /* One line that needed no tidying is an ordinary paste. Handling it here would cost the
       browser's undo entry and gain nothing. */
    const several = entries.length > 1;
    if (!several && entries[0] === event.clipboardData.getData("text/plain").trim()) return;

    event.preventDefault();
    const area = event.currentTarget;
    const before = value.slice(0, area.selectionStart);
    const after = value.slice(area.selectionEnd);
    const lead = several && before !== "" && !before.endsWith("\n") ? "\n" : "";
    const trail = several && after !== "" && !after.startsWith("\n") ? "\n" : "";
    const insert = `${lead}${entries.join("\n")}${trail}`;

    onChange(`${before}${insert}${after}`);
    setCaret(before.length + insert.length);
  };

  const entries = countEntries(value);
  const advice = adviseLines(value, MAX_LINE);

  const take = (item: LineAdvice): void => {
    onChange(applySplit(value, item));
  };

  return (
    <Stack gap="sm">
      <TextAreaField
        ref={box}
        label={label}
        rows={4}
        hint={entries === 0 ? "One per line." : `One per line. ${entries} so far.`}
        value={value}
        onPaste={paste}
        onChange={(event: { target: { value: string } }) => onChange(event.target.value)}
      />

      {advice.map((item) => (
        <div
          key={`${item.index}-${item.reason}`}
          className="rounded-lg border border-[var(--hairline)] bg-[var(--glass-hi)] px-2.5 py-2"
        >
          {item.reason === "too-long" ? (
            <p className="text-[11.5px] leading-relaxed text-[var(--ink-3)]">
              Line {item.index + 1} is longer than {MAX_LINE} characters, which the API refuses.
              Shorten it or break it into separate rules.
            </p>
          ) : (
            <>
              <p className="text-[11.5px] leading-relaxed text-[var(--ink-3)]">
                Line {item.index + 1} reads as {item.parts.length} rules. The agent takes each
                line as one instruction, so this arrives as a single long one.
              </p>
              <ul className="mt-1.5 space-y-0.5">
                {item.parts.map((part, at) => (
                  <li key={at} className="truncate font-mono text-[10.5px] text-[var(--ink-3)]">
                    {at + 1}. {part}
                  </li>
                ))}
              </ul>
              <div className="mt-2">
                <Button onClick={() => take(item)}>
                  Split into {item.parts.length} lines
                </Button>
              </div>
            </>
          )}
        </div>
      ))}
    </Stack>
  );
};

export const PolicyTab = ({ config, errors, publishForm, savingDraft }: PolicyTabProps) => {
  const [blocks, setBlocks] = useState<PolicyBlock[]>(() =>
    (config.policyBlocks ?? []).map((block) => ({
      name: block.name,
      applies: block.applies,
      canDo: [...block.canDo],
      cannotDo: [...block.cannotDo],
      escalateWhen: [...block.escalateWhen],
    })),
  );
  const [view, setView] = useState<View>("split");
  const [selected, setSelected] = useState(0);
  const [text, setText] = useState("");

  /* Read after mount rather than in the initialiser: the server renders this too, and reaching
     for `localStorage` during that render is a hydration mismatch rather than a preference. */
  useEffect(() => {
    const stored = window.localStorage.getItem(VIEW_KEY);
    if (stored === "prompt" || stored === "split") setView(stored);
  }, []);

  const parsed = view === "prompt" ? parsePolicies(text) : null;
  const problems = parsed?.problems ?? [];
  /* In the document view the text is the thing being edited, so the structure is derived from it
     on every keystroke — and only when it parses cleanly, so a half-typed heading never empties
     the set. */
  const live = parsed !== null && problems.length === 0 ? [...parsed.blocks] : blocks;
  const long = tooLong(live);
  const clashes = overlapping(live);

  const swapTo = (next: View): void => {
    if (next === "prompt") {
      setText(renderPolicies(blocks));
    } else {
      if (problems.length > 0) return;
      setBlocks(live);
      setSelected(0);
    }
    setView(next);
    window.localStorage.setItem(VIEW_KEY, next);
  };

  const update = (index: number, over: Partial<PolicyBlock>): void =>
    setBlocks((now) => now.map((block, at) => (at === index ? { ...block, ...over } : block)));

  const current = blocks[selected];

  return (
    <Stack>
      <Notice tone="ok">
        Rules the agent follows on top of its instructions, grouped so the model can tell which
        one applies. Each block is rendered under its own heading, and the agent is told never to
        reason by analogy from one to another — a refund rule is not a cancellation rule.
      </Notice>

      {/* Absent while the document does not parse, because an absent field means "leave the
          stored policies alone" and writing only the half we understood would delete the rest. */}
      {problems.length === 0 && long.length === 0 && (
        <input
          type="hidden"
          form={publishForm}
          name="policyBlocks"
          value={JSON.stringify(cleaned(live))}
        />
      )}

      {errors["policyBlocks"] !== undefined && <FieldError>{errors["policyBlocks"]}</FieldError>}

      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex gap-1.5">
          <Button
            variant={view === "split" ? "primary" : "secondary"}
            size="sm"
            onClick={() => swapTo("split")}
            disabled={view === "prompt" && problems.length > 0}
            aria-pressed={view === "split"}
          >
            Fields
          </Button>
          <Button
            variant={view === "prompt" ? "primary" : "secondary"}
            size="sm"
            onClick={() => swapTo("prompt")}
            aria-pressed={view === "prompt"}
          >
            Document
          </Button>
        </div>
        <p className="text-[12.5px] text-[var(--ink-3)]">
          {view === "split"
            ? "The same policies as one document, if you would rather write prose."
            : "This is what the model receives, heading for heading."}
        </p>
      </div>

      {problems.length > 0 && (
        <Notice tone="error">
          Nothing is saved while these lines have nowhere to go, and going back to the fields is
          held until they do — so none of it is lost.
          <ul className="mt-1.5 list-disc space-y-0.5 pl-5">
            {problems.slice(0, 5).map((problem) => (
              <li key={problem.line}>
                Line {problem.line}: {problem.message}
              </li>
            ))}
          </ul>
        </Notice>
      )}

      {long.length > 0 && (
        <Notice tone="error">
          A line is longer than {MAX_LINE} characters, which the API refuses: {long[0]}
        </Notice>
      )}

      {clashes.size > 0 && (
        <Notice tone="warn">
          Two policies could both match the same caller. The agent picks one and will not blend
          them, so make the “applies when” lines tell them apart.
        </Notice>
      )}

      {view === "prompt" ? (
        <Card
          title="Every policy, as one document"
          description="Start each with ## and a name. The four headings under it are fixed; everything else is yours."
        >
          <TextAreaField
            label="Policies"
            rows={22}
            value={text}
            onChange={(event: { target: { value: string } }) => setText(event.target.value)}
            placeholder={
              "## Refunds\n\nApplies when\nThe caller wants money back.\n\nCan\n- Issue a refund within 14 days"
            }
          />
        </Card>
      ) : (
        <div className="grid gap-3 md:grid-cols-[15rem_1fr]">
          <Stack gap="sm">
            {blocks.map((block, index) => (
              <button
                key={index}
                type="button"
                onClick={() => setSelected(index)}
                className={`rounded-lg border px-2.5 py-2 text-left ${
                  index === selected
                    ? "border-[var(--accent)] bg-[var(--glass-hi)]"
                    : "border-[var(--hairline)]"
                }`}
              >
                <span className="block text-[12.5px] font-semibold">
                  {block.name.trim() === "" ? `Policy ${index + 1}` : block.name}
                </span>
                <span className="mt-0.5 block truncate text-[11.5px] text-[var(--ink-3)]">
                  {block.applies.trim() === "" ? "no “applies when” yet" : block.applies}
                </span>
                <span className="mt-1 block font-mono text-[10.5px] text-[var(--ink-3)]">
                  {block.canDo.length} can · {block.cannotDo.length} must not ·{" "}
                  {block.escalateWhen.length} escalate
                  {clashes.has(index) ? " · overlaps" : ""}
                </span>
              </button>
            ))}
            {blocks.length < MAX_BLOCKS && (
              <div>
                <Button
                  onClick={() => {
                    setBlocks((now) => [...now, emptyBlock()]);
                    setSelected(blocks.length);
                  }}
                >
                  Add a policy
                </Button>
              </div>
            )}
          </Stack>

          {current === undefined ? (
            <Card
              title="No policies yet"
              description="Leave this empty if the agent's instructions already cover everything. Add one when a rule recurs often enough to deserve its own heading."
            >
              <p className="text-[12.5px] text-[var(--ink-3)]">
                Policies are for the rules that come up again and again — refunds, cancellations,
                a complaint that has to reach a person.
              </p>
            </Card>
          ) : (
            <Card
              title={current.name.trim() === "" ? `Policy ${selected + 1}` : current.name}
              description="A policy with no name, or no “applies when”, is dropped when you save — it reads as one somebody started and left."
            >
              <Stack>
                <TextField
                  label="Name"
                  value={current.name}
                  onChange={(event) => update(selected, { name: event.target.value })}
                  placeholder="Refunds"
                />
                <TextField
                  label="Applies when"
                  value={current.applies}
                  onChange={(event) => update(selected, { applies: event.target.value })}
                  placeholder="The caller wants money back for something they have already paid for."
                />

                {LIST_KEYS.map((key) => (
                  <LineListField
                    key={key}
                    label={LIST_LABELS[key]}
                    value={current[key].join("\n")}
                    onChange={(next) => update(selected, { [key]: next.split("\n") })}
                  />
                ))}

                <div>
                  <Button
                    onClick={() => {
                      setBlocks((now) => now.filter((_, at) => at !== selected));
                      setSelected(0);
                    }}
                    disabled={savingDraft}
                  >
                    Remove this policy
                  </Button>
                </div>
              </Stack>
            </Card>
          )}
        </div>
      )}
    </Stack>
  );
};
