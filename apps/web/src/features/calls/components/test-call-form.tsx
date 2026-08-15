"use client";

import { Loader2 } from "lucide-react";
import { useActionState } from "react";

import { Blip, CONTROL, FieldError, GlassPanel, Notice, Tag } from "@/components/ui";
import { cn } from "@/lib/cn";
import { idleForm } from "@/lib/form-state";

import { placeCall, type TestCallState } from "../calls.actions";

const START: TestCallState = { ...idleForm(), refused: false };

/**
 * The test-call toolbar.
 *
 * A toolbar, not a content card: it floats above the list and over whatever
 * scrolls beneath it, which is why it is glass while the tables below are
 * solid. One line, because this is the control you reach for twenty times an
 * hour and a tall card pushes the list — the thing you are watching — down.
 *
 * There is no button in here. "Test call" in the page header is the only one,
 * bound to this form by id — two buttons firing one action, worded differently,
 * is worse than one in the right place.
 */
export const TestCallForm = ({ configVersion }: { readonly configVersion?: number }) => {
  const [state, action, pending] = useActionState(placeCall, START);
  const numberError = state.fieldErrors["to"];

  return (
    <GlassPanel className="px-4 py-3.5" id="test-call">
      {/* `id` matters: the only button that submits this form is "Test call" in
          the page header, bound by `form="test-call-form"`. HTML has associated
          a control with a form it does not sit inside since forever, and it is
          the right tool here — one action, named once, in the place the design
          puts it. */}
      <form id="test-call-form" action={action} className="flex flex-wrap items-center gap-3">
        <label htmlFor="test-call-to" className="text-[12.5px] font-medium">
          Ring me at
        </label>
        <input
          id="test-call-to"
          name="to"
          type="tel"
          placeholder="+234 800 000 0000"
          defaultValue={state.data?.to ?? ""}
          aria-invalid={numberError !== undefined}
          className={cn(CONTROL, "w-[190px]", numberError !== undefined && "border-[var(--bad)]")}
        />
        {pending ? (
          <span className="flex items-center gap-2 text-[12.5px] text-[var(--ink-2)]">
            <Loader2 aria-hidden className="size-3.5 animate-spin" />
            Ringing…
          </span>
        ) : (
          configVersion !== undefined && (
            <span className="text-[12.5px] text-[var(--ink-3)]">on version {configVersion}</span>
          )
        )}

        <span className="flex-1" />

        {/* Stated rather than hidden: somebody testing an outbound number needs
            to know the gate is in the path before they wonder why it refused. */}
        <Tag>
          <Blip />
          Consent gate on
        </Tag>
      </form>

      {numberError !== undefined && <FieldError>{numberError}</FieldError>}

      {state.status === "succeeded" && state.data !== null && (
        <Notice tone="ok" className="mt-3">
          Queued to {state.data.to} on configuration version {state.data.configVersion}. The
          carrier says <span className="font-mono text-xs">{state.data.status}</span>. It appears
          below once it connects.
        </Notice>
      )}

      {state.status === "failed" && (
        <Notice tone={state.refused ? "warn" : "error"} className="mt-3">
          {state.message}
          {state.refused && " This is the consent gate, not a fault. Nothing skips it."}
        </Notice>
      )}
    </GlassPanel>
  );
};
