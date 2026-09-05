"use client";

import { Search, X } from "lucide-react";
import { useState, useTransition } from "react";

import { CONTROL, IconButton } from "@/components/ui";
import { cn } from "@/lib/cn";

import { findContacts, type ContactMatch } from "../appointments.actions";

/**
 * Attach a contact to a booking, or leave it unattached.
 *
 * Optional by design: a manual booking might be for somebody who has never called, so this
 * never blocks a booking and starts empty. The search runs through a Server Action rather than
 * a browser fetch — the API has no CORS and the session lives in an httpOnly cookie, so the
 * server is the only side that can ask — and a failed search degrades to "no matches" instead
 * of taking the booking dialog down with it.
 *
 * The chosen contact's id is reported upward for the hidden field the booking form submits; the
 * name and number are kept only to show who was picked.
 */
export const ContactPicker = ({
  value,
  onChange,
}: {
  readonly value: ContactMatch | null;
  readonly onChange: (contact: ContactMatch | null) => void;
}) => {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<readonly ContactMatch[]>([]);
  const [searched, setSearched] = useState(false);
  const [pending, startSearch] = useTransition();

  const run = (term: string): void => {
    const trimmed = term.trim();
    if (trimmed === "") {
      setResults([]);
      setSearched(false);
      return;
    }
    startSearch(async () => {
      const result = await findContacts(trimmed);
      setResults(result.ok ? result.contacts : []);
      setSearched(true);
    });
  };

  if (value !== null) {
    return (
      <div className="flex items-center justify-between gap-2 rounded-lg border border-[var(--hairline)] bg-[var(--surface-2)] px-3 py-2">
        <div className="min-w-0">
          <div className="truncate text-[13px] font-medium">{value.name}</div>
          <div className="truncate font-mono text-[11.5px] text-[var(--ink-3)]">{value.phone}</div>
        </div>
        <IconButton aria-label="Detach contact" onClick={() => onChange(null)}>
          <X aria-hidden className="size-4" />
        </IconButton>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-2">
      <div className="relative flex items-center">
        <Search aria-hidden className="pointer-events-none absolute left-3 size-4 text-[var(--ink-3)]" />
        <input
          type="search"
          value={query}
          placeholder="Search a name or number (optional)"
          className={cn(CONTROL, "pl-9")}
          onChange={(event) => {
            setQuery(event.target.value);
            run(event.target.value);
          }}
        />
      </div>

      {pending && <p className="text-[12px] text-[var(--ink-3)]">Searching…</p>}

      {!pending && searched && results.length === 0 && (
        <p className="text-[12px] text-[var(--ink-3)]">No matching contacts. The booking can go ahead without one.</p>
      )}

      {results.length > 0 && (
        <ul className="max-h-40 overflow-y-auto rounded-lg border border-[var(--hairline)]">
          {results.map((contact) => (
            <li key={contact.id}>
              <button
                type="button"
                onClick={() => onChange(contact)}
                className="flex w-full items-center justify-between gap-2 border-b border-[var(--surface-line)] px-3 py-2 text-left last:border-b-0 hover:bg-[var(--surface-2)]"
              >
                <span className="min-w-0">
                  <span className="block truncate text-[13px] font-medium">{contact.name}</span>
                  <span className="block truncate font-mono text-[11.5px] text-[var(--ink-3)]">
                    {contact.phone}
                  </span>
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
};
