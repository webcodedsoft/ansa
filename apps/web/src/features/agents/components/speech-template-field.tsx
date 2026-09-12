"use client";

import { useEffect, useRef, useState, type KeyboardEvent } from "react";

import { TextAreaField } from "@/components/ui";
import { cn } from "@/lib/cn";

/** One path into the response the sample fetch found, with what was there. */
export interface ResponseField {
  readonly path: string;
  readonly sample: string;
}

/**
 * The sentence the agent speaks, written against the response that was fetched.
 *
 * Two things a plain textarea could not do. Typing `{` offers the response's fields as
 * you write, filtered by what follows the brace, so the placeholder names come from the
 * response rather than from memory — the whole reason the sample step exists. And clicking
 * a field puts it where the cursor is, or over what is selected, instead of on the end of
 * the sentence; a placeholder belongs mid-sentence far more often than after the full stop.
 *
 * The caret is tracked from the textarea's own events rather than guessed, and restored
 * after every insertion so the person keeps writing from where the field landed.
 */

const MAX_SUGGESTIONS = 8;

/** The placeholder being typed at the caret, if any: where its brace is and what follows. */
const openPlaceholder = (value: string, caret: number): { readonly start: number; readonly query: string } | null => {
  const before = value.slice(0, caret);
  const start = before.lastIndexOf("{");
  if (start < 0) return null;
  const query = before.slice(start + 1);
  // A closed brace or a space after it means the brace is not a placeholder being typed.
  if (query.includes("}") || /\s/.test(query)) return null;
  return { start, query };
};

const matching = (fields: readonly ResponseField[], query: string): readonly ResponseField[] => {
  const needle = query.toLowerCase();
  const hit = fields.filter((field) => field.path.toLowerCase().includes(needle));
  // Names that start with what was typed come first; a person types from the left.
  return [...hit]
    .sort((a, b) => Number(b.path.toLowerCase().startsWith(needle)) - Number(a.path.toLowerCase().startsWith(needle)))
    .slice(0, MAX_SUGGESTIONS);
};

const shortSample = (sample: string): string => (sample.length > 40 ? `${sample.slice(0, 40)}…` : sample);

export const SpeechTemplateField = ({
  label,
  value,
  onChange,
  fields,
  error,
  hint,
  placeholder,
  rows = 3,
}: {
  readonly label: string;
  readonly value: string;
  readonly onChange: (next: string) => void;
  readonly fields: readonly ResponseField[];
  readonly error?: string;
  readonly hint?: string;
  readonly placeholder?: string;
  readonly rows?: number;
}) => {
  const box = useRef<HTMLTextAreaElement>(null);
  const [caret, setCaret] = useState(0);
  const [dismissed, setDismissed] = useState(false);
  const [active, setActive] = useState(0);
  /* Where the caret should land after React has written the new value into the textarea.
     Set synchronously in the insert, applied in an effect: setting the selection before
     the value has changed puts it in the old text. */
  const landing = useRef<number | null>(null);

  useEffect(() => {
    const el = box.current;
    if (el === null || landing.current === null) return;
    el.focus();
    el.setSelectionRange(landing.current, landing.current);
    setCaret(landing.current);
    landing.current = null;
  }, [value]);

  const typing = dismissed ? null : openPlaceholder(value, caret);
  const suggestions = typing === null || fields.length === 0 ? [] : matching(fields, typing.query);
  const showing = suggestions.length > 0;

  /** Put `{path}` between `from` and `to`, and carry on writing after it. */
  const insert = (path: string, from: number, to: number): void => {
    const token = `{${path}}`;
    onChange(`${value.slice(0, from)}${token}${value.slice(to)}`);
    landing.current = from + token.length;
    setDismissed(false);
  };

  const accept = (field: ResponseField): void => {
    if (typing === null) return;
    insert(field.path, typing.start, caret);
  };

  const insertAtCursor = (field: ResponseField): void => {
    const el = box.current;
    const from = el?.selectionStart ?? value.length;
    const to = el?.selectionEnd ?? from;
    insert(field.path, from, to);
  };

  const track = (): void => {
    const el = box.current;
    if (el !== null) setCaret(el.selectionStart);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>): void => {
    if (!showing) return;
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setActive((current) => (current + 1) % suggestions.length);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setActive((current) => (current - 1 + suggestions.length) % suggestions.length);
    } else if (event.key === "Enter" || event.key === "Tab") {
      event.preventDefault();
      const chosen = suggestions[Math.min(active, suggestions.length - 1)];
      if (chosen !== undefined) accept(chosen);
    } else if (event.key === "Escape") {
      event.preventDefault();
      setDismissed(true);
    }
  };

  return (
    <div className="flex flex-col gap-2">
      <TextAreaField
        ref={box}
        label={label}
        value={value}
        rows={rows}
        placeholder={placeholder}
        error={error}
        hint={fields.length > 0 ? `Type { to pick a field from the response. ${hint ?? ""}`.trim() : hint}
        onChange={(event) => {
          onChange(event.target.value);
          setCaret(event.target.selectionStart);
          setDismissed(false);
          setActive(0);
        }}
        onSelect={track}
        onClick={track}
        onKeyUp={track}
        onKeyDown={onKeyDown}
        aria-autocomplete={fields.length > 0 ? "list" : undefined}
        aria-expanded={showing}
      />

      {showing && (
        <ul
          role="listbox"
          aria-label="Fields from the response"
          className="overflow-hidden rounded-lg border border-[var(--hairline)] bg-[var(--surface-solid)] shadow-[var(--shadow-m)]"
        >
          {suggestions.map((field, index) => (
            <li key={field.path} role="option" aria-selected={index === active}>
              <button
                type="button"
                /* Mouse down, not click: a click would blur the textarea first and the
                   caret this inserts at would be gone. */
                onMouseDown={(event) => {
                  event.preventDefault();
                  accept(field);
                }}
                onMouseEnter={() => setActive(index)}
                className={cn(
                  "flex w-full items-baseline gap-3 px-3 py-1.5 text-left text-[12.5px]",
                  index === active ? "bg-[var(--accent-soft)] text-[var(--accent)]" : "text-[var(--ink-2)]",
                )}
              >
                <span className="font-mono">{field.path}</span>
                <span className="min-w-0 flex-1 truncate text-[11.5px] text-[var(--ink-3)]">{shortSample(field.sample)}</span>
              </button>
            </li>
          ))}
        </ul>
      )}

      {fields.length > 0 && (
        <div>
          <span className="text-[12px] font-semibold uppercase tracking-[0.09em] text-[var(--ink-3)]">
            From the response you fetched
          </span>
          <p className="mt-1 text-[12px] text-[var(--ink-3)]">
            Click one to put it where the cursor is. These are the paths that will resolve &mdash;
            anything else falls through to the no-record sentence.
          </p>
          <div className="mt-2 flex flex-wrap gap-1.5">
            {fields.map((field) => (
              <button
                key={field.path}
                type="button"
                onMouseDown={(event) => {
                  event.preventDefault();
                  insertAtCursor(field);
                }}
                className="rounded-[4px] border border-[var(--surface-line)] px-2 py-1 font-mono text-[11.5px] text-[var(--ink-2)] transition hover:border-[var(--accent)] hover:text-[var(--accent)]"
                title={field.sample}
              >
                {field.path}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
};
