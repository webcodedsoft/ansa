"use client";

import { Plus, Webhook } from "lucide-react";
import { useState } from "react";

import { Button, Card, Notice, PageHeader, SectionHead, Tag } from "@/components/ui";

import type { ClaimWebhook, NumberCountries, NumberProvisioning, NumberSummary } from "../connect.service";
import { BuyNumber } from "./buy-number";
import { BringYourOwnModal } from "./bring-your-own-modal";
import { NumberCard, type RoutableAgent } from "./number-card";

type Panel = "get" | null;

/**
 * The Numbers page, as number cards.
 *
 * Each number is a card; a dashed card at the end adds one. "Bring your own" opens a dialog
 * with the import URL and its three steps; "Get a number" opens the catalogue under the
 * grid. Both are reachable from the header and from the add card, so the page never
 * navigates away from what it already holds. Under it all, what this deployment can do,
 * straight from the API.
 */
export const NumbersBoard = ({
  numbers,
  agents,
  webhook,
  provisioning,
  catalogue,
  organisationName,
}: {
  readonly numbers: readonly NumberSummary[];
  readonly agents: readonly RoutableAgent[];
  readonly webhook: ClaimWebhook | null;
  readonly provisioning: NumberProvisioning;
  /** Null when this deployment cannot offer numbers; a refusal when the carrier turned the request down. */
  readonly catalogue: { readonly countries: NumberCountries | null; readonly refusal: string | null } | null;
  readonly organisationName: string;
}) => {
  const [panel, setPanel] = useState<Panel>(null);
  const [bringing, setBringing] = useState(false);
  const fromPlan = numbers.filter((one) => one.managedBy === "platform").length;
  const canGet = catalogue?.countries !== null && catalogue !== null && catalogue !== undefined;
  const moreCountries = catalogue?.countries === null || catalogue == null ? null : Math.max(0, catalogue.countries.items.length - 4);

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
              <Button variant="primary" onClick={() => setPanel(panel === "get" ? null : "get")} aria-pressed={panel === "get"}>
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
          onClick={() => (catalogue !== null ? setPanel(panel === "get" ? null : "get") : setBringing(true))}
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
      {panel === "get" && catalogue !== null && (
        <div className="mt-[26px]">
          <SectionHead>Get a number from Ansa</SectionHead>
          {catalogue.countries !== null ? (
            <BuyNumber countries={catalogue.countries} organisationName={organisationName} />
          ) : (
            <Notice tone="error">
              Getting a number is unavailable right now: {catalogue.refusal}. Whoever runs the platform needs to
              look at its carrier account; bringing your own number still works.
            </Notice>
          )}
        </div>
      )}

      <Card title="What this deployment can do" className="mt-[26px]">
        <dl className="m-0 grid grid-cols-[11rem_minmax(0,1fr)] gap-x-3.5 gap-y-2.5 text-[13.5px]">
          <dt className="text-[var(--ink-3)]">Numbers from Ansa</dt>
          <dd className="m-0 flex flex-wrap items-center gap-2">
            {canGet ? <Tag tone="ok">in your plan</Tag> : <Tag tone={catalogue === null ? "neutral" : "bad"}>{catalogue === null ? "not available" : "unavailable"}</Tag>}
            <span>
              {canGet
                ? `US, GB, CA, ZA${moreCountries !== null && moreCountries > 0 ? ` and ${moreCountries} more` : ""}. Not Nigeria.`
                : (catalogue?.refusal ?? provisioning.claim.detail)}
            </span>
          </dd>
          <dt className="text-[var(--ink-3)]">Bringing your own</dt>
          <dd className="m-0 flex flex-wrap items-center gap-2">
            <Tag tone={provisioning.attach.selfService ? "ok" : "neutral"}>
              {provisioning.attach.selfService ? "self-service" : "operator only"}
            </Tag>
            <span>Proved by webhook — no operator needed.</span>
          </dd>
          {provisioning.carrier !== null && (
            <>
              <dt className="text-[var(--ink-3)]">Carrier</dt>
              <dd className="m-0 font-mono text-[13px]">{provisioning.carrier}</dd>
            </>
          )}
          <dt className="text-[var(--ink-3)]">Voice webhook</dt>
          <dd className="m-0 font-mono text-[12px]">
            {provisioning.voiceWebhook.url === null ? (
              <span className="font-sans text-[13px] text-[var(--ink-3)]">not available</span>
            ) : (
              `${provisioning.voiceWebhook.method} ${provisioning.voiceWebhook.url}`
            )}
          </dd>
        </dl>
      </Card>
    </>
  );
};
