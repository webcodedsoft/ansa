"use client";

import { useActionState, useEffect, useRef, useState, startTransition } from "react";

import { Button, ConfirmDialog, Modal, Notice, SelectField, TextField } from "@/components/ui";
import { idleForm } from "@/lib/form-state";

import { buyNumberAction, searchNumbersAction, type BuyNumberState, type SearchNumbersState } from "../connect.actions";
import type { AvailableNumber, NumberCountries } from "../connect.service";
import { spaced } from "../numbers.display";

const SEARCH_START: SearchNumbersState = idleForm();
const BUY_START: BuyNumberState = idleForm();

/** Typing pauses this long before the carrier is asked; the search is a request, not a keystroke. */
const SEARCH_DEBOUNCE_MS = 450;

/**
 * Get a number from Ansa — as a dialog.
 *
 * Country and a digit filter, and under them what the carrier would sell right now: up to
 * ten numbers, scrolling inside the dialog rather than stretching it. The list fills itself
 * when the dialog opens and again whenever the country or the digits change, so there is no
 * search button to find. Adding one asks once, in a dialog that names the number, then the
 * API takes it from the carrier, points it here and attaches it in one step.
 *
 * No price anywhere: the organisation does not pay the carrier, the number is part of what
 * they buy from Ansa. The catalogue is the carrier's; Nigeria is not in it, and the
 * description says so rather than letting somebody scroll the country list for it.
 */
export const GetNumberModal = ({
  open,
  onClose,
  countries,
  organisationName,
}: {
  readonly open: boolean;
  readonly onClose: () => void;
  readonly countries: NumberCountries;
  readonly organisationName: string;
}) => {
  const [search, searchAction, searching] = useActionState(searchNumbersAction, SEARCH_START);
  const [buy, buyAction, buying] = useActionState(buyNumberAction, BUY_START);
  const [country, setCountry] = useState(countries.items.some((one) => one.code === "US") ? "US" : (countries.items[0]?.code ?? "US"));
  const [contains, setContains] = useState("");
  const [chosen, setChosen] = useState<AvailableNumber | null>(null);
  const timer = useRef<number | null>(null);

  const ask = (nextCountry: string, nextContains: string) => {
    const form = new FormData();
    form.set("country", nextCountry);
    form.set("contains", nextContains);
    startTransition(() => searchAction(form));
  };

  /* Fill the list when the dialog opens, and again after typing pauses. */
  useEffect(() => {
    if (!open) return;
    if (timer.current !== null) window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => ask(country, contains), contains === "" ? 0 : SEARCH_DEBOUNCE_MS);
    return () => {
      if (timer.current !== null) window.clearTimeout(timer.current);
    };
    // `ask` is stable for the life of the dialog; only the inputs decide when to search.
  }, [open, country, contains]);

  const results = search.status === "succeeded" && search.data !== null ? search.data.items : null;
  const bought = buy.status === "succeeded" ? buy.data?.number : undefined;

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Get a number from Ansa"
      description={`Part of your plan — nothing to pay the carrier. Pointed at Ansa and attached in one step.${countries.nigeria ? "" : " Not Nigeria; use Bring your own for a Nigerian line."}`}
      footer={
        <div className="flex w-full items-center justify-end">
          <Button variant="secondary" onClick={onClose}>
            Done
          </Button>
        </div>
      }
    >
      <div className="flex flex-col gap-4">
        {buy.status === "failed" && <Notice tone="error">{buy.message}</Notice>}
        {bought !== undefined && <Notice tone="ok">{buy.message}</Notice>}

        <div className="grid gap-3.5 sm:grid-cols-2">
          <SelectField label="Country" value={country} onChange={(event) => setCountry(event.target.value)}>
            {countries.items.map((one) => (
              <option key={one.code} value={one.code}>
                {one.name}
              </option>
            ))}
          </SelectField>
          <TextField
            label="Contains"
            mono
            inputMode="numeric"
            placeholder="e.g. 814"
            value={contains}
            onChange={(event) => setContains(event.target.value.replace(/[^0-9*]/g, "").slice(0, 12))}
          />
        </div>

        {search.status === "failed" && <Notice tone="error">{search.message}</Notice>}

        <div className="max-h-[19rem] overflow-y-auto rounded-lg border border-[var(--hairline)]" aria-busy={searching}>
          {results === null && (
            <p className="m-0 px-3.5 py-6 text-center text-[13px] text-[var(--ink-3)]">
              {searching ? "Asking the carrier…" : "Choose a country to see what is available."}
            </p>
          )}
          {results !== null && results.length === 0 && (
            <p className="m-0 px-3.5 py-6 text-center text-[13px] text-[var(--ink-3)]">
              Nothing available with those digits right now. Try fewer digits.
            </p>
          )}
          {results !== null && results.length > 0 && (
            <ul className={`m-0 list-none divide-y divide-[var(--surface-line)] p-0 ${searching ? "opacity-60" : ""}`}>
              {results.map((one) => (
                <li key={one.number} className="grid grid-cols-[minmax(0,1fr)_auto_auto] items-center gap-3 px-3.5 py-2.5">
                  <span className="flex min-w-0 flex-wrap items-baseline gap-x-3 gap-y-0.5">
                    <span className="font-mono text-[14px] font-medium">{spaced(one.number)}</span>
                    <span className="text-[12.5px] text-[var(--ink-3)]">{one.locality ?? one.country}</span>
                  </span>
                  <span className="text-[12.5px] text-[var(--ink-3)]">available</span>
                  <Button size="sm" variant="primary" onClick={() => setChosen(one)} disabled={buying}>
                    Add
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </div>

        <ConfirmDialog
          open={chosen !== null}
          onClose={() => setChosen(null)}
          onConfirm={() => {
            if (chosen === null) return;
            const form = new FormData();
            form.set("number", chosen.number);
            form.set("country", chosen.country);
            setChosen(null);
            startTransition(() => buyAction(form));
          }}
          title={`Add ${chosen === null ? "this number" : spaced(chosen.number)}?`}
          confirmLabel="Add and attach"
          pending={buying}
        >
          Part of your Ansa plan — nothing to pay the carrier. It is attached to {organisationName}{" "}
          and rings here the moment this completes; route an agent to it afterwards.
        </ConfirmDialog>
      </div>
    </Modal>
  );
};
