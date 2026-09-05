"use client";

import { useActionState, useMemo, useRef, useState } from "react";

import { Button, Notice, Stack, SubmitButton } from "@/components/ui";
import { CONTROL } from "@/components/ui";
import { cn } from "@/lib/cn";
import { idleForm } from "@/lib/form-state";

import { importContactsAction, type ImportContactsState } from "../contacts.actions";
import { MAX_IMPORT_ROWS, parseContactsCsv } from "../contacts.csv";

const START: ImportContactsState = idleForm();

/** A file with a null byte is not text we can read as a list — a spreadsheet, an image, a PDF. */
const looksBinary = (text: string): boolean => text.includes("\u0000");

/**
 * Bring in a list of people at once, parsed in the browser before anything is sent.
 *
 * The point of parsing here rather than on the server is the preview: the person sees exactly
 * what was read — how many rows carry a number, how many did not, whether the paste was longer
 * than a batch can hold — and only then sends it. Leniency is safe because of that preview; the
 * worst a wrong guess about a column does is show a value in a box the person can see.
 *
 * The counts the result reports are the API's own and honest: `added` is new people,
 * `alreadyKnown` were on the list already, `skipped` are numbers it could not read. A duplicate
 * inside the paste is folded there, which is why `received` can be larger than the three of them
 * summed against distinct numbers.
 */
export const ImportContactsForm = ({ onClose }: { readonly onClose: () => void }) => {
  const [state, action, pending] = useActionState(importContactsAction, START);
  const [text, setText] = useState("");
  const [sourceLabel, setSourceLabel] = useState("Pasted");
  const [fileError, setFileError] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const parsed = useMemo(() => parseContactsCsv(text), [text]);
  const result = state.status === "succeeded" ? state.data : null;

  const onPickFile = async (file: File | undefined): Promise<void> => {
    if (file === undefined) return;
    setFileError(null);
    const content = await file.text();
    if (looksBinary(content)) {
      setFileError(
        `${file.name} does not look like a CSV — it reads as a binary file. Export it as CSV, or paste the columns instead.`,
      );
      if (fileRef.current !== null) fileRef.current.value = "";
      return;
    }
    setText(content);
    setSourceLabel(file.name);
  };

  if (result !== null) {
    const nothing = result.added === 0 && result.alreadyKnown === 0;
    return (
      <Stack gap="sm">
        <Notice tone={nothing ? "warn" : "ok"}>
          {nothing
            ? `Nothing was added. ${result.skipped} row${result.skipped === 1 ? "" : "s"} carried a number that could not be read.`
            : `Imported from ${result.received} row${result.received === 1 ? "" : "s"}: ${result.added} added, ${result.alreadyKnown} already on your list${result.skipped > 0 ? `, ${result.skipped} skipped as unreadable` : ""}.`}
        </Notice>
        <div className="flex justify-end">
          <Button type="button" variant="primary" onClick={onClose}>
            Done
          </Button>
        </div>
      </Stack>
    );
  }

  const ready = parsed.rows.length;
  const onlyBad = ready === 0 && parsed.skipped > 0;

  return (
    <form action={action}>
      <Stack gap="sm">
        <label className="block">
          <span className="mb-1.5 block text-[12.5px] font-medium">Paste your list</span>
          <textarea
            value={text}
            onChange={(event) => {
              setText(event.target.value);
              setSourceLabel("Pasted");
              setFileError(null);
            }}
            rows={7}
            placeholder={"phone,name,notes\n0803 123 4567,Adaeze,VIP\n0701 111 2222,Bola"}
            className={cn(CONTROL, "resize-y font-mono text-[12.5px] leading-relaxed")}
          />
        </label>

        <div className="flex items-center gap-3 text-[12.5px] text-[var(--ink-3)]">
          <span>or</span>
          <input
            ref={fileRef}
            type="file"
            accept=".csv,.tsv,.txt,text/csv,text/plain"
            onChange={(event) => void onPickFile(event.target.files?.[0])}
            className="min-w-0 flex-1 text-[12.5px] text-[var(--ink-2)] file:mr-3 file:rounded-md file:border file:border-[var(--hairline)] file:bg-[var(--surface-2)] file:px-2.5 file:py-1 file:text-[var(--ink)]"
          />
        </div>

        {fileError !== null && <Notice tone="error">{fileError}</Notice>}

        {text.trim() !== "" && (
          <div className="rounded-lg border border-[var(--hairline)] bg-[var(--surface-2)] p-3 text-[12.5px]">
            <p className="font-medium text-[var(--ink)]">
              {ready === 0
                ? "No usable rows"
                : `${ready} ${ready === 1 ? "person" : "people"} ready to import`}
              {parsed.skipped > 0 && (
                <span className="font-normal text-[var(--ink-3)]">
                  {" "}
                  · {parsed.skipped} row{parsed.skipped === 1 ? "" : "s"} with no readable number
                </span>
              )}
            </p>
            {ready > 0 && (
              <ul className="mt-2 space-y-0.5">
                {parsed.rows.slice(0, 5).map((row, i) => (
                  <li key={i} className="flex gap-2 text-[var(--ink-2)]">
                    <span className="font-mono">{row.phone}</span>
                    {row.displayName !== undefined && (
                      <span className="text-[var(--ink-3)]">— {row.displayName}</span>
                    )}
                  </li>
                ))}
                {ready > 5 && <li className="text-[var(--ink-3)]">…and {ready - 5} more</li>}
              </ul>
            )}
          </div>
        )}

        {parsed.truncated && (
          <Notice tone="warn">
            Your list is longer than one batch. The first {MAX_IMPORT_ROWS.toLocaleString()} will
            be imported and the remaining {parsed.dropped.toLocaleString()} left out — split the
            rest into a second import.
          </Notice>
        )}

        {onlyBad && (
          <Notice tone="warn">
            None of these rows carried a number we could read, so there is nothing to import.
            Check that a column holds phone numbers.
          </Notice>
        )}

        {(state.status === "failed" || state.status === "invalid") && state.message !== null && (
          <Notice tone="error">{state.message}</Notice>
        )}

        {/* The rows the preview showed, sent verbatim so what was seen is what is imported. */}
        <input type="hidden" name="rows" value={JSON.stringify(parsed.rows)} />
        <input type="hidden" name="sourceLabel" value={sourceLabel} />

        <div className="flex items-center justify-between gap-2">
          <span className="text-[12px] text-[var(--ink-3)]">
            {ready > 0 ? `Filed under "${sourceLabel}"` : ""}
          </span>
          <div className="flex gap-2">
            <Button type="button" variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            {ready > 0 ? (
              <SubmitButton
                pending={pending}
                idle={`Import ${ready} ${ready === 1 ? "person" : "people"}`}
                busy="Importing…"
              />
            ) : (
              <Button type="button" variant="primary" disabled>
                Import
              </Button>
            )}
          </div>
        </div>
      </Stack>
    </form>
  );
};
