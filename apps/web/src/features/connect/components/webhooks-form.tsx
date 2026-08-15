"use client";

import { useActionState, useState } from "react";

import {
  Button,
  Card,
  CheckboxField,
  CheckboxGroup,
  FieldError,
  Notice,
  NumberField,
  Row,
  Stack,
  SubmitButton,
  TextAreaField,
  TextField,
} from "@/components/ui";
import { idleForm } from "@/lib/form-state";
import { useFormToast } from "@/stores/toast.store";

import { saveSubscriptions, type SaveSubscriptionsState } from "../connect.actions";
import { EVENT_KINDS, type EventKind } from "../connect.schema";
import type { SubscriptionDocument, SubscriptionEntry } from "../connect.service";

const START: SaveSubscriptionsState = idleForm();

const EVENT_LABEL: Record<EventKind, string> = {
  "call.ended": "Call ended",
  "call.transferred": "Call transferred",
};

interface SubscriptionDraft {
  readonly name: string;
  readonly url: string;
  readonly events: readonly EventKind[];
  readonly signingSecretRef: string;
  readonly credentialRef: string;
  readonly timeoutMs: string;
  readonly maxAttempts: string;
}

const emptyDraft = (): SubscriptionDraft => ({
  name: "",
  url: "",
  events: [],
  signingSecretRef: "",
  credentialRef: "",
  timeoutMs: "",
  maxAttempts: "",
});

const draftsFrom = (entries: readonly SubscriptionEntry[]): SubscriptionDraft[] =>
  entries.map((entry) => ({
    name: entry.name,
    url: entry.url,
    events: entry.events,
    signingSecretRef: entry.signingSecretRef,
    credentialRef: entry.credentialRef ?? "",
    timeoutMs: entry.timeoutMs === undefined ? "" : String(entry.timeoutMs),
    maxAttempts: entry.maxAttempts === undefined ? "" : String(entry.maxAttempts),
  }));

/**
 * Edit and replace the event subscription document.
 *
 * `eventSubscriptions.replace` overwrites the whole thing in one PUT — egress and
 * every receiver — so this form keeps the entire document in state, not just the fields a
 * person is actively changing. `subscriptions` travels to the server action as JSON in a
 * hidden field rather than as indexed `subscriptions[0].url` form fields: the list of
 * receivers grows and shrinks, and re-deriving an array of objects from flat, re-indexed
 * FormData keys is exactly the kind of thing that silently drops a field when a row is
 * removed from the middle. `expectedVersion` travels as a plain hidden field so the API can
 * refuse a save that raced another one — see the note above the field itself.
 */
export const WebhooksForm = ({ document }: { readonly document: SubscriptionDocument }) => {
  const [state, action, pending] = useActionState(saveSubscriptions, START);
  const errors = state.fieldErrors;

  const [allowedHosts, setAllowedHosts] = useState(document.egress.allowedHosts.join("\n"));
  const [allowPlaintextHttp, setAllowPlaintextHttp] = useState(
    document.egress.allowPlaintextHttp ?? false,
  );


  const [subscriptions, setSubscriptions] = useState<readonly SubscriptionDraft[]>(
    draftsFrom(document.subscriptions),
  );

  const updateSubscription = (index: number, patch: Partial<SubscriptionDraft>) =>
    setSubscriptions((prev) => prev.map((entry, i) => (i === index ? { ...entry, ...patch } : entry)));

  const toggleEvent = (index: number, kind: EventKind) =>
    setSubscriptions((prev) =>
      prev.map((entry, i) => {
        if (i !== index) return entry;
        const events = entry.events.includes(kind)
          ? entry.events.filter((candidate) => candidate !== kind)
          : [...entry.events, kind];
        return { ...entry, events };
      }),
    );


  useFormToast(state, (data) => `Saved. Now on configuration version ${data.configVersion}.`);

  return (
    <form action={action}>
      <input type="hidden" name="expectedVersion" value={document.configVersion} />
      <input type="hidden" name="subscriptionsJson" value={JSON.stringify(subscriptions)} readOnly />

      <Stack>
        {(state.status === "failed" || state.status === "invalid") && (
          <Notice tone="error">{state.message}</Notice>
        )}

        <Card
          title="Egress"
          description="Hosts a receiver's URL is allowed to resolve to. A receiver outside this list is refused, not silently skipped."
        >
          <Stack>
            <TextAreaField
              label="Allowed hosts"
              name="allowedHosts"
              value={allowedHosts}
              onChange={(event) => setAllowedHosts(event.target.value)}
              error={errors["allowedHosts"]}
              hint="One host per line, or comma-separated. Every receiver's URL below must resolve to one of these."
            />
            <CheckboxField
              label="Allow plaintext HTTP"
              name="allowPlaintextHttp"
              checked={allowPlaintextHttp}
              onChange={(event) => setAllowPlaintextHttp(event.target.checked)}
            />
          </Stack>
        </Card>

        <Card
          title="Receivers"
          description="Where this organisation's calls are pushed. At least one event kind, one signing secret."
        >
          <Stack>
            {subscriptions.length === 0 && (
              <p className="text-[13px] text-[var(--ink-3)]">No receivers configured.</p>
            )}

            {subscriptions.map((subscription, index) => (
              // Index as key: an unsaved draft row has no other stable identity, and rows
              // are only ever appended or removed here, never reordered.
              <div key={index} className="rounded-lg border border-[var(--hairline)] p-4">
                <Stack gap="sm">
                  <Row className="justify-between">
                    <span className="text-xs font-medium text-[var(--ink-3)]">Receiver {index + 1}</span>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => setSubscriptions((prev) => prev.filter((_, i) => i !== index))}
                    >
                      Remove
                    </Button>
                  </Row>

                  <Row>
                    <TextField
                      label="Name"
                      value={subscription.name}
                      onChange={(event) => updateSubscription(index, { name: event.target.value })}
                      error={errors[`subscriptions.${index}.name`]}
                      className="min-w-48 flex-1"
                    />
                    <TextField
                      label="Endpoint URL"
                      value={subscription.url}
                      onChange={(event) => updateSubscription(index, { url: event.target.value })}
                      placeholder="https://example.com/ansa/events"
                      error={errors[`subscriptions.${index}.url`]}
                      className="min-w-64 flex-[2]"
                    />
                  </Row>

                  <div>
                    <CheckboxGroup legend="Events">
                      {EVENT_KINDS.map((kind) => (
                        <CheckboxField
                          key={kind}
                          label={EVENT_LABEL[kind]}
                          checked={subscription.events.includes(kind)}
                          onChange={() => toggleEvent(index, kind)}
                        />
                      ))}
                    </CheckboxGroup>
                    {errors[`subscriptions.${index}.events`] !== undefined && (
                      <FieldError>{errors[`subscriptions.${index}.events`]}</FieldError>
                    )}
                  </div>

                  <TextField
                    label="Signing secret reference"
                    value={subscription.signingSecretRef}
                    onChange={(event) =>
                      updateSubscription(index, { signingSecretRef: event.target.value })
                    }
                    error={errors[`subscriptions.${index}.signingSecretRef`]}
                    hint="The name of a credential stored on the Credentials screen — that credential signs every payload sent here."
                  />

                  <Row>
                    <TextField
                      label="Credential reference"
                      value={subscription.credentialRef}
                      onChange={(event) =>
                        updateSubscription(index, { credentialRef: event.target.value })
                      }
                      error={errors[`subscriptions.${index}.credentialRef`]}
                      hint="Optional. A stored credential this receiver authenticates with."
                      className="min-w-40 flex-1"
                    />
                    <NumberField
                      label="Timeout (ms)"
                      min={1}
                      value={subscription.timeoutMs}
                      onChange={(event) => updateSubscription(index, { timeoutMs: event.target.value })}
                      error={errors[`subscriptions.${index}.timeoutMs`]}
                      className="w-32"
                    />
                    <NumberField
                      label="Max attempts"
                      min={1}
                      value={subscription.maxAttempts}
                      onChange={(event) =>
                        updateSubscription(index, { maxAttempts: event.target.value })
                      }
                      error={errors[`subscriptions.${index}.maxAttempts`]}
                      className="w-32"
                    />
                  </Row>
                </Stack>
              </div>
            ))}

            <div>
              <Button variant="secondary" onClick={() => setSubscriptions((prev) => [...prev, emptyDraft()])}>
                Add receiver
              </Button>
            </div>
          </Stack>
        </Card>

        <Card
          title="Save"
          description={`Currently on configuration version ${document.configVersion}. Saving overwrites the whole document, including receivers you did not touch — every field on this page is sent back, so nothing here is a partial update.`}
        >
          <Stack>
            <TextField
              label="What changed"
              name="note"
              maxLength={500}
              placeholder="Added the billing webhook"
              error={errors["note"]}
              hint="Recorded on the configuration version. Optional."
            />
            <div>
              <SubmitButton pending={pending} idle="Save" busy="Saving…" />
            </div>
          </Stack>
        </Card>
      </Stack>
    </form>
  );
};
