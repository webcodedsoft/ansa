"use client";

import { ShoppingCart } from "lucide-react";
import { startTransition, useActionState, useState } from "react";

import { Button, Card, ConfirmDialog, Notice, SearchField, SelectField, Stack, SubmitButton } from "@/components/ui";
import { idleForm } from "@/lib/form-state";

import {
  buyNumberAction,
  searchNumbersAction,
  type BuyNumberState,
  type SearchNumbersState,
} from "../connect.actions";
import type { AvailableNumber, NumberCountries } from "../connect.service";

const SEARCH_START: SearchNumbersState = idleForm();
const BUY_START: BuyNumberState = idleForm();

/**
 * Buy a number from the platform's carrier.
 *
 * Country, an optional digit filter, a list of what is for sale with the monthly price, and
 * one confirmation per number that repeats the price — because the click that follows it
 * spends money every month until the number is released. The catalogue is the carrier's;
 * Nigeria is not in it, and the card says so above the country list rather than letting
 * somebody scroll for it.
 */
export const BuyNumber = ({
  countries,
  organisationName,
}: {
  readonly countries: NumberCountries;
  readonly organisationName: string;
}) => {
  const [search, searchAction, searching] = useActionState(searchNumbersAction, SEARCH_START);
  const [buy, buyAction, buying] = useActionState(buyNumberAction, BUY_START);
  const [chosen, setChosen] = useState<AvailableNumber | null>(null);

  const results = search.status === "succeeded" && search.data !== null ? search.data : null;
  const bought = buy.status === "succeeded" ? buy.data?.number : undefined;

  return (
    <Card
      title={
        <span className="inline-flex items-center gap-2">
          <ShoppingCart aria-hidden className="size-4 text-[var(--ink-3)]" />
          Buy a number
        </span>
      }
      description="Bought in the platform's carrier account, pointed at this deployment and attached to this organisation in one step. Billed to the platform monthly at the carrier's price until you release it."
    >
      <Stack>
        {!countries.nigeria && (
          <Notice tone="warn">
            The carrier sells no Nigerian numbers. For a Nigerian line, bring one you already hold
            using the card above; buy here for a line abroad — a London or New York number for
            customers outside the country.
          </Notice>
        )}

        <form action={searchAction} className="flex flex-wrap items-end gap-3">
          <SelectField label="Country" name="country" defaultValue={results?.country ?? "US"} className="min-w-[16rem]">
            {countries.items.map((one) => (
              <option key={one.code} value={one.code}>
                {one.name}
              </option>
            ))}
          </SelectField>
          <SearchField
            label="Digits the number should contain"
            hideLabel={false}
            name="contains"
            inputMode="numeric"
            placeholder="e.g. 0800"
            className="min-w-[14rem]"
          />
          <SubmitButton pending={searching} idle="Search" />
        </form>

        {search.status === "failed" && <Notice tone="error">{search.message}</Notice>}
        {buy.status === "failed" && <Notice tone="error">{buy.message}</Notice>}
        {bought !== undefined && <Notice tone="ok">{buy.message}</Notice>}

        {results !== null && results.items.length === 0 && (
          <p className="m-0 text-[13px] text-[var(--ink-3)]">Nothing for sale with those digits right now. Try fewer digits.</p>
        )}

        {results !== null && results.items.length > 0 && (
          <ul className="m-0 flex list-none flex-col divide-y divide-[var(--surface-line)] rounded-lg border border-[var(--hairline)] p-0">
            {results.items.map((one) => (
              <li key={one.number} className="flex flex-wrap items-center gap-3 px-3.5 py-2.5">
                <span className="font-mono text-[14px]">{one.number}</span>
                <span className="text-[12.5px] text-[var(--ink-3)]">
                  {one.locality ?? one.country}
                  {one.monthlyPrice !== null && ` · ${one.monthlyPrice} ${one.currency ?? ""} a month`}
                </span>
                <span className="ml-auto">
                  <Button size="sm" variant="primary" onClick={() => setChosen(one)} disabled={buying}>
                    Buy
                  </Button>
                </span>
              </li>
            ))}
          </ul>
        )}

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
          title={`Buy ${chosen?.number ?? "this number"}?`}
          confirmLabel="Buy and attach"
          pending={buying}
        >
          {chosen?.monthlyPrice !== null && chosen?.monthlyPrice !== undefined
            ? `${chosen.monthlyPrice} ${chosen.currency ?? ""} a month, billed to the platform's carrier account, until it is released. `
            : "Billed to the platform's carrier account monthly, at the carrier's price, until it is released. "}
          It is attached to {organisationName} and rings here the moment this completes; route an
          agent to it afterwards.
        </ConfirmDialog>
      </Stack>
    </Card>
  );
};
