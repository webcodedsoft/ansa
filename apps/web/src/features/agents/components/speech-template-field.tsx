"use client";

import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent } from "react";

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

const shortSample = (sample: string): string => (sample.length > 28 ? `${sample.slice(0, 28)}…` : sample);

/** Everything that decides where a character lands in a textarea; the mirror copies these. */
const MIRROR_STYLES = [
  "fontFamily", "fontSize", "fontWeight", "fontStyle", "letterSpacing", "lineHeight", "textTransform",
  "paddingTop", "paddingRight", "paddingBottom", "paddingLeft", "borderTopWidth", "borderRightWidth",
  "borderBottomWidth", "borderLeftWidth", "boxSizing", "tabSize", "textIndent", "wordSpacing",
] as const;

/**
 * Where the caret is inside the textarea, in pixels from its top-left, and how tall a line
 * is there. A textarea does not say; a hidden copy of it with the same text and styles
 * does, with a marker where the caret would be. The copy lives for one measurement.
 */
const caretPlace = (el: HTMLTextAreaElement, index: number): { readonly top: number; readonly left: number; readonly line: number } => {
  const style = getComputedStyle(el);
  const mirror = document.createElement("div");
  for (const name of MIRROR_STYLES) mirror.style[name] = style[name];
  mirror.style.position = "absolute";
  mirror.style.top = "0";
  mirror.style.left = "-9999px";
  mirror.style.visibility = "hidden";
  mirror.style.whiteSpace = "pre-wrap";
  mirror.style.overflowWrap = "break-word";
  mirror.style.overflow = "hidden";
  mirror.style.width = `${el.clientWidth}px`;
  mirror.style.boxSizing = "border-box";
  mirror.textContent = el.value.slice(0, index);
  const marker = document.createElement("span");
  marker.textContent = el.value.slice(index) === "" ? "." : el.value.slice(index);
  mirror.appendChild(marker);
  document.body.appendChild(mirror);
  const line = Number.parseFloat(style.lineHeight) || Number.parseFloat(style.fontSize) * 1.5;
  const place = { top: marker.offsetTop - el.scrollTop, left: marker.offsetLeft, line };
  mirror.remove();
  return place;
};

const POPUP_WIDTH = 288;

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
  const wrap = useRef<HTMLDivElement>(null);
  /** Where the popup sits, relative to the wrapper: under the caret, kept inside the field. */
  const [place, setPlace] = useState<{ readonly top: number; readonly left: number } | null>(null);

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

  /* Measured after layout, so the popup is placed against the textarea as it is on screen.
     Anchored at the brace being typed rather than the caret, so it does not walk to the
     right as the name is typed. Clamped to the field's right edge. */
  const anchor = typing === null ? -1 : typing.start;
  useLayoutEffect(() => {
    const el = box.current;
    const outer = wrap.current;
    if (!showing || el === null || outer === null || anchor < 0) {
      setPlace((current) => (current === null ? current : null));
      return;
    }
    const at = caretPlace(el, anchor);
    const left = Math.min(el.offsetLeft + at.left, Math.max(0, outer.clientWidth - POPUP_WIDTH));
    const top = el.offsetTop + at.top + at.line + 2;
    // Same place, same object: a fresh object here would re-render and measure again, forever.
    setPlace((current) => (current !== null && current.top === top && current.left === left ? current : { top, left }));
  }, [showing, anchor, value]);

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
    <div ref={wrap} className="relative flex flex-col gap-2">
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

      {showing && place !== null && (
        <ul
          role="listbox"
          aria-label="Fields from the response"
          style={{ top: place.top, left: place.left, width: POPUP_WIDTH }}
          className="absolute z-20 max-h-56 overflow-y-auto rounded-lg border border-[var(--hairline)] bg-[var(--surface-solid)] py-1 shadow-[var(--shadow-l)]"
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
                  "flex w-full items-baseline gap-2 px-2.5 py-1 text-left text-[12px] leading-5",
                  index === active ? "bg-[var(--accent-soft)] text-[var(--accent)]" : "text-[var(--ink-2)]",
                )}
              >
                <span className="min-w-0 flex-1 truncate font-mono">{field.path}</span>
                {field.sample !== "" && (
                  <span className="max-w-[45%] flex-none truncate text-[11px] text-[var(--ink-3)]">{shortSample(field.sample)}</span>
                )}
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
