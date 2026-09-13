"use client";

import { NIGERIAN_LEXICON, applyPronunciations, mergePronunciations, type Pronunciation } from "@ansa/normalizer";
import { ArrowUpRight, Plus, Search, Volume2, X } from "lucide-react";
import { useActionState, useDeferredValue, useMemo, useState } from "react";

import { Button, Card, FieldError, IconButton, Notice, SubmitButton, Tag, TextField } from "@/components/ui";
import { cn } from "@/lib/cn";
import { idleForm } from "@/lib/form-state";

import { useFailureToast } from "@/stores/toast.store";
import { savePronunciations, type PronunciationsState } from "../org.actions";

const START: PronunciationsState = idleForm();

/** A row on the form: what is stored, plus a key that survives removing the row above it. */
interface Row extends Pronunciation {
  readonly key: number;
}

const SAMPLE_SENTENCE = "Thank you, Sikiru, calling from Ikeja about your policy in Port Harcourt.";
const LEXICON_PAGE = 40;

/**
 * How this organisation's own words are said.
 *
 * The voice says most Nigerian names and places well because a built-in list of several
 * hundred tells it how — respelled in plain syllables it reads as English, and in IPA for the
 * voices that take a phoneme tag. What that list cannot know is this company's name, its
 * branches, its products, and the surnames it transfers calls to. Those go here, and an
 * entry here wins over the built-in one for the same word.
 *
 * The rows post as three columns sharing a name, in row order, which is what the action
 * reads. The preview runs the real normalizer in the browser against exactly the list the
 * call will use — the built-in one with these rows over it — so what the page shows is what
 * the voice is given. Applied from the next call: there is no version for it to sit in.
 */
export const PronunciationForm = ({
  pronunciations,
  canWrite,
}: {
  readonly pronunciations: readonly Pronunciation[];
  readonly canWrite: boolean;
}) => {
  const [state, action, pending] = useActionState(savePronunciations, START);
  useFailureToast(state);
  const errors = state.fieldErrors;

  const [rows, setRows] = useState<readonly Row[]>(() => pronunciations.map((entry, key) => ({ ...entry, key })));
  const [nextKey, setNextKey] = useState(rows.length);
  const [sample, setSample] = useState(SAMPLE_SENTENCE);
  const [query, setQuery] = useState("");
  const search = useDeferredValue(query.trim().toLowerCase());

  const addRow = (entry?: Pronunciation) => {
    setRows((current) => [...current, { key: nextKey, term: entry?.term ?? "", sayAs: entry?.sayAs ?? "", ipa: entry?.ipa ?? "" }]);
    setNextKey((k) => k + 1);
  };
  const removeRow = (key: number) => setRows((current) => current.filter((r) => r.key !== key));
  const editRow = (key: number, patch: Partial<Pronunciation>) =>
    setRows((current) => current.map((r) => (r.key === key ? { ...r, ...patch } : r)));

  /* What the voice will be given for the sample, against the list as it stands on the form —
     not as it was saved — so a row can be tried before it is kept. */
  const own = useMemo(() => rows.filter((r) => r.term.trim() !== "" && r.sayAs.trim() !== ""), [rows]);
  const spoken = useMemo(() => applyPronunciations(sample, mergePronunciations(NIGERIAN_LEXICON, own)), [own, sample]);

  const ownTerms = useMemo(() => new Set(rows.map((r) => r.term.trim().toLowerCase())), [rows]);
  const lexicon = useMemo(
    () =>
      search === ""
        ? NIGERIAN_LEXICON
        : NIGERIAN_LEXICON.filter((e) => e.term.toLowerCase().includes(search) || e.sayAs.toLowerCase().includes(search)),
    [search],
  );

  return (
    <Card
      title={
        <span className="inline-flex items-center gap-2">
          <Volume2 aria-hidden className="size-4 text-[var(--ink-3)]" />
          Pronunciation
        </span>
      }
      description="How the voice says your own words: the company, its branches, its products, the people it transfers to. Several hundred Nigerian names and places are already built in; add what the voice gets wrong. Applies from the next call, on every agent."
      actions={
        <Tag tone={own.length > 0 ? "ok" : "neutral"}>
          {own.length === 0 ? "built-in list" : `${own.length} of your own`}
        </Tag>
      }
    >
      <form action={action} className="flex flex-col gap-5">
        {state.status === "succeeded" && <Notice tone="ok">{state.message}</Notice>}

        <section className="rounded-lg border border-[var(--hairline)] bg-[var(--surface-2)] px-4 py-3.5">
          <TextField
            label="Try a sentence"
            value={sample}
            onChange={(event) => setSample(event.target.value)}
            hint="What the voice is handed for it, with your rows over the built-in list. Nothing here is saved."
            size="sm"
          />
          <p
            aria-live="polite"
            className="m-0 mt-3 rounded-md border border-dashed border-[var(--hairline)] bg-[var(--surface-solid)] px-3 py-2 text-[13.5px] leading-relaxed"
          >
            {spoken}
          </p>
        </section>

        <div className="flex flex-col gap-2">
          <div className="flex items-baseline justify-between gap-3">
            <span className="text-[12px] font-semibold uppercase tracking-[0.09em] text-[var(--ink-3)]">Your words</span>
            <span className="text-[12px] text-[var(--ink-3)]">
              Respell in syllables the way you would coach a newsreader: <span className="font-mono">Oakhaven → oak-hay-vun</span>
            </span>
          </div>

          {rows.length === 0 ? (
            <p className="m-0 rounded-lg border border-dashed border-[var(--hairline)] px-4 py-5 text-center text-[13px] text-[var(--ink-3)]">
              Nothing of your own yet. The voice uses the built-in list below.
            </p>
          ) : (
            <div className="flex flex-col gap-2">
              <div className="hidden grid-cols-[minmax(0,1fr)_minmax(0,1.3fr)_minmax(0,1fr)_30px] gap-2 px-1 text-[11.5px] text-[var(--ink-3)] sm:grid">
                <span>Word or phrase</span>
                <span>Said as</span>
                <span>IPA (optional)</span>
                <span />
              </div>
              {rows.map((row, index) => {
                const at = (field: keyof Pronunciation) => errors[`pronunciations.${index}.${field}`];
                const rowError = at("term") ?? at("sayAs") ?? at("ipa");
                return (
                  <div key={row.key} className="flex flex-col gap-1">
                    <div className="grid grid-cols-1 gap-2 sm:grid-cols-[minmax(0,1fr)_minmax(0,1.3fr)_minmax(0,1fr)_30px] sm:items-center">
                      <TextField
                        label={`Word ${index + 1}`}
                        hideLabel
                        name="term"
                        value={row.term}
                        onChange={(event) => editRow(row.key, { term: event.target.value })}
                        placeholder="Oakhaven"
                        size="sm"
                        maxLength={80}
                        autoComplete="off"
                        readOnly={!canWrite}
                        aria-invalid={at("term") !== undefined}
                      />
                      <TextField
                        label={`How word ${index + 1} is said`}
                        hideLabel
                        name="sayAs"
                        value={row.sayAs}
                        onChange={(event) => editRow(row.key, { sayAs: event.target.value })}
                        placeholder="oak-hay-vun"
                        size="sm"
                        maxLength={120}
                        autoComplete="off"
                        readOnly={!canWrite}
                        aria-invalid={at("sayAs") !== undefined}
                      />
                      <TextField
                        label={`IPA for word ${index + 1}`}
                        hideLabel
                        name="ipa"
                        value={row.ipa ?? ""}
                        onChange={(event) => editRow(row.key, { ipa: event.target.value })}
                        placeholder="ˈoʊkˌheɪvən"
                        size="sm"
                        mono
                        maxLength={120}
                        autoComplete="off"
                        readOnly={!canWrite}
                        aria-invalid={at("ipa") !== undefined}
                      />
                      {canWrite ? (
                        <IconButton aria-label={`Remove ${row.term === "" ? `row ${index + 1}` : row.term}`} onClick={() => removeRow(row.key)}>
                          <X aria-hidden className="size-4" />
                        </IconButton>
                      ) : (
                        <span />
                      )}
                    </div>
                    {rowError !== undefined && <FieldError>{rowError}</FieldError>}
                  </div>
                );
              })}
            </div>
          )}

          {canWrite && (
            <div>
              <Button type="button" size="sm" onClick={() => addRow()}>
                <Plus aria-hidden className="size-3.5" />
                Add a word
              </Button>
            </div>
          )}
        </div>

        {canWrite && (
          <div className="flex items-center justify-end gap-3 border-t border-[var(--surface-line)] pt-4">
            <span className="text-[12px] text-[var(--ink-3)]">Applies from the next call. Nothing to publish.</span>
            <SubmitButton pending={pending} idle="Save pronunciations" />
          </div>
        )}
      </form>

      <details className="group mt-5 border-t border-[var(--surface-line)] pt-4">
        <summary className="flex cursor-pointer list-none items-center justify-between gap-3 [&::-webkit-details-marker]:hidden">
          <span className="text-[12px] font-semibold uppercase tracking-[0.09em] text-[var(--ink-3)]">
            Built in · {NIGERIAN_LEXICON.length} Nigerian names and places
          </span>
          <span className="text-[12px] text-[var(--accent)] group-open:hidden">Show</span>
          <span className="hidden text-[12px] text-[var(--accent)] group-open:inline">Hide</span>
        </summary>
        <div className="mt-3 flex flex-col gap-3">
          <p className="m-0 max-w-[62ch] text-[12.5px] leading-relaxed text-[var(--ink-3)]">
            States and capitals, Lagos districts, towns, Yoruba, Igbo, Hausa and Niger Delta names, and the
            everyday words a call touches. Every one is already said this way. If one is wrong for you, take
            it into your own list and change it there; yours wins.
          </p>
          <TextField
            label="Find a word"
            hideLabel
            leading={<Search />}
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search the built-in list"
            size="sm"
            autoComplete="off"
          />
          {lexicon.length === 0 ? (
            <p className="m-0 py-3 text-center text-[13px] text-[var(--ink-3)]">
              Not built in. Add it to your own list above.
            </p>
          ) : (
            <ul className="m-0 grid list-none gap-x-4 p-0 sm:grid-cols-2">
              {lexicon.slice(0, LEXICON_PAGE).map((entry) => {
                const overridden = ownTerms.has(entry.term.toLowerCase());
                return (
                  <li
                    key={entry.term}
                    className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-2 border-b border-[var(--surface-line)] py-1.5 text-[13px]"
                  >
                    <span className="min-w-0">
                      <span className={cn("font-medium", overridden && "line-through text-[var(--ink-3)]")}>{entry.term}</span>
                      <span className="ml-2 text-[var(--ink-3)]">{entry.sayAs}</span>
                    </span>
                    {canWrite && !overridden && (
                      <button
                        type="button"
                        onClick={() => addRow({ term: entry.term, sayAs: entry.sayAs, ...(entry.ipa === undefined ? {} : { ipa: entry.ipa }) })}
                        className="inline-flex items-center gap-0.5 text-[12px] text-[var(--accent)] hover:underline"
                      >
                        Change
                        <ArrowUpRight aria-hidden className="size-3" />
                      </button>
                    )}
                    {overridden && <Tag>yours</Tag>}
                  </li>
                );
              })}
            </ul>
          )}
          {lexicon.length > LEXICON_PAGE && (
            <p className="m-0 text-[12px] text-[var(--ink-3)]">
              Showing {LEXICON_PAGE} of {lexicon.length}. Search to narrow it.
            </p>
          )}
        </div>
      </details>
    </Card>
  );
};
