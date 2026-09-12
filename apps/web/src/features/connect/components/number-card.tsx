"use client";

import { startTransition, useActionState } from "react";

import { Notice, SelectField, Tag, type Tone } from "@/components/ui";
import { setRouting, type RoutingState } from "@/features/agents/agents.actions";
import { dayLabel, timeOfDay } from "@/lib/format";
import { idleForm } from "@/lib/form-state";

import type { NumberSummary } from "../connect.service";
import { countryOf, spaced } from "../numbers.display";
import { ReleaseNumber } from "./release-number";

type WebhookState = NumberSummary["carrierWebhook"]["state"];

const STATUS_TONE: Record<WebhookState, Tone> = {
  matches: "ok",
  "points-elsewhere": "bad",
  "not-set": "warn",
  "not-in-carrier-account": "warn",
  unchecked: "neutral",
};

const STATUS_LABEL: Record<WebhookState, string> = {
  matches: "matches",
  "points-elsewhere": "points elsewhere",
  "not-set": "not set",
  "not-in-carrier-account": "not in carrier account",
  unchecked: "unchecked",
};

const ROUTING_START: RoutingState = idleForm();

export interface RoutableAgent {
  readonly agentId: string;
  readonly name: string;
  readonly dialledNumber: string | null;
}

/**
 * One number, as a thing you can hold.
 *
 * Big, with its flag, who answers it, whether the carrier is pointed here, and whether it
 * came from the plan. Routing an agent happens on the card: choosing one moves the number
 * to that agent (taking it from whoever answered it before, and un-routing the agent's old
 * number), "nobody" un-routes it. Both go through the same action the agent's own page
 * uses, so the two screens cannot disagree about who answers what.
 */
export const NumberCard = ({ number, agents }: { readonly number: NumberSummary; readonly agents: readonly RoutableAgent[] }) => {
  const [state, action, pending] = useActionState(setRouting, ROUTING_START);
  const current = number.answeredBy?.agentId ?? "";

  const route = (agentId: string) => {
    const form = new FormData();
    if (agentId === "") {
      /* Nobody: the agent that answers it today lets go of it. */
      if (number.answeredBy === null) return;
      form.set("agentId", number.answeredBy.agentId);
      form.set("dialledNumber", "");
    } else {
      form.set("agentId", agentId);
      form.set("dialledNumber", number.number);
      form.set("takeOver", "yes");
    }
    startTransition(() => action(form));
  };

  const fromPlan = number.managedBy === "platform";

  return (
    <div className="grid content-start gap-3.5 rounded-[14px] border border-[var(--hairline)] bg-[var(--surface)] p-[18px] shadow-[var(--shadow-s)]">
      <div className="flex items-center justify-between gap-2.5">
        <span
          aria-label={`Country ${countryOf(number.number, number.country)}`}
          className="inline-grid h-4 w-[22px] place-items-center rounded-[3px] border border-[var(--hairline)] bg-[var(--surface-2)] font-mono text-[9px] font-semibold text-[var(--ink-2)]"
        >
          {countryOf(number.number, number.country)}
        </span>
        {fromPlan ? <Tag tone="accent">from your plan</Tag> : <Tag>your own</Tag>}
      </div>

      <div className="font-mono text-[22px] font-semibold tracking-[-0.02em]">{spaced(number.number)}</div>

      <div className="flex items-center justify-between gap-2.5 border-t border-[var(--surface-line)] pt-2.5 text-[13px]">
        <span className="text-[12px] text-[var(--ink-3)]">Answers on</span>
        <span className="min-w-[11rem]">
          <SelectField
            label={`Who answers ${number.number}`}
            hideLabel
            size="sm"
            value={current}
            disabled={pending}
            onChange={(event) => route(event.target.value)}
          >
            <option value="">nobody yet</option>
            {agents.map((agent) => (
              <option key={agent.agentId} value={agent.agentId}>
                {agent.name}
              </option>
            ))}
          </SelectField>
        </span>
      </div>
      {state.status === "failed" && <Notice tone="error">{state.message}</Notice>}
      {number.answeredBy === null && state.status !== "failed" && (
        <p className="-mt-2 m-0 text-[11.5px] text-[var(--warn)]">Rings nobody until an agent is chosen.</p>
      )}

      <div className="flex items-center justify-between gap-2.5 border-t border-[var(--surface-line)] pt-2.5 text-[13px]">
        <span className="text-[12px] text-[var(--ink-3)]">Carrier webhook</span>
        <Tag tone={STATUS_TONE[number.carrierWebhook.state]}>{STATUS_LABEL[number.carrierWebhook.state]}</Tag>
      </div>
      {number.carrierWebhook.reason !== null && (
        <p className="-mt-2 m-0 text-[11.5px] text-[var(--ink-3)]">{number.carrierWebhook.reason}</p>
      )}

      {fromPlan ? (
        <div className="flex items-center justify-between gap-2.5 border-t border-[var(--surface-line)] pt-2.5 text-[13px]">
          <span className="text-[12px] text-[var(--ink-3)]">Plan</span>
          <span className="inline-flex items-center gap-2">
            included · <ReleaseNumber number={number.number} agentName={number.answeredBy?.name ?? null} />
          </span>
        </div>
      ) : (
        <div className="flex items-center justify-between gap-2.5 border-t border-[var(--surface-line)] pt-2.5 text-[13px]">
          <span className="text-[12px] text-[var(--ink-3)]">Last call</span>
          <span>
            {number.lastCallAt === null
              ? "never"
              : `${dayLabel(number.lastCallAt)} ${timeOfDay(number.lastCallAt)}`}
          </span>
        </div>
      )}
    </div>
  );
};
