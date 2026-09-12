"use client";

import { Plus, Webhook } from "lucide-react";
import { useState } from "react";

import { Button, Notice, PageHeader } from "@/components/ui";

import type { ClaimWebhook, NumberCountries, NumberSummary } from "../connect.service";
import { GetNumberModal } from "./get-number-modal";
import { BringYourOwnModal } from "./bring-your-own-modal";
import { NumberCard, type RoutableAgent } from "./number-card";


/**
 * The Numbers page, as number cards.
 *
 * Each number is a card; a dashed card at the end adds one. "Bring your own" opens a dialog
 * with the import URL and its three steps; "Get a number" opens a dialog with the carrier's
 * catalogue. Both are reachable from the header and from the add card, so the page never
 * navigates away from what it already holds. What the deployment can do is not a card of
 * its own: the country list and the Nigeria note live in the Get-a-number dialog, the
 * webhook URL in the Bring-your-own dialog, and a carrier refusal appears where somebody
 * is trying to act on it.
 */
export const NumbersBoard = ({
  numbers,
  agents,
  webhook,
  catalogue,
  organisationName,
}: {
  readonly numbers: readonly NumberSummary[];
  readonly agents: readonly RoutableAgent[];
  readonly webhook: ClaimWebhook | null;
  /** Null when this deployment cannot offer numbers; a refusal when the carrier turned the request down. */
  readonly catalogue: { readonly countries: NumberCountries | null; readonly refusal: string | null } | null;
  readonly organisationName: string;
}) => {
  const [bringing, setBringing] = useState(false);
  const [getting, setGetting] = useState(false);
  const fromPlan = numbers.filter((one) => one.managedBy === "platform").length;

  return (
    <>
      <PageHeader
        eyebrow="Connect"
        title="Numbers"
        meta={
          <span className="inline-flex flex-wrap items-center gap-x-2.5 gap-y-1">
            <span>
              {numbers.length} {numbers.length === 1 ? "number" : "numbers"}
            </span>
            <span aria-hidden>·</span>
            <span>{fromPlan} from your plan</span>
          </span>
        }
        actions={
          <>
            {webhook !== null && (
              <Button variant="secondary" onClick={() => setBringing(true)}>
                <Webhook aria-hidden className="size-3.5" />
                Bring your own
              </Button>
            )}
            {catalogue !== null && (
              <Button variant="primary" onClick={() => setGetting(true)}>
                <Plus aria-hidden className="size-3.5" />
                Get a number
              </Button>
            )}
          </>
        }
      />

      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
        {numbers.map((one) => (
          <NumberCard key={one.number} number={one} agents={agents} />
        ))}
        <button
          type="button"
          onClick={() => (catalogue !== null ? setGetting(true) : setBringing(true))}
          className="grid min-h-[250px] cursor-pointer place-items-center content-center gap-2 rounded-[14px] border border-dashed border-[var(--hairline)] p-[18px] text-center text-[var(--ink-3)] transition-colors hover:border-[var(--ink-3)] focus-visible:outline-2 focus-visible:outline-[var(--accent)]"
        >
          <Plus aria-hidden className="size-[22px]" />
          <span className="text-[15px] font-medium text-[var(--ink-2)]">Add a number</span>
          <span className="text-[12.5px]">Bring your own{catalogue !== null ? ", or get one from Ansa" : ""}</span>
        </button>
      </div>

      {webhook !== null && (
        <BringYourOwnModal open={bringing} onClose={() => setBringing(false)} webhook={webhook} />
      )}
      {catalogue !== null && catalogue.countries !== null && (
        <GetNumberModal
          open={getting}
          onClose={() => setGetting(false)}
          countries={catalogue.countries}
          organisationName={organisationName}
        />
      )}
      {catalogue !== null && catalogue.countries === null && getting && (
        <Notice tone="error" className="mt-[26px]">
          Getting a number is unavailable right now: {catalogue.refusal}. Whoever runs the platform needs to
          look at its carrier account; bringing your own number still works.
        </Notice>
      )}

    </>
  );
};
