"use client";

import Link from "next/link";
import { useActionState, useEffect, useMemo, useState } from "react";

import {
  Button,
  buttonClass,
  CONTROL,
  Modal,
  Notice,
  Stack,
  SubmitButton,
} from "@/components/ui";
import { idleForm } from "@/lib/form-state";
import { useFormToast } from "@/stores/toast.store";

import {
  enqueueContactsAction,
  findCampaignContacts,
  type EnqueueState,
} from "../campaigns.actions";

const START: EnqueueState = idleForm();

export interface PickerContact {
  readonly id: string;
  readonly displayName: string | null;
  readonly phone: string;
}

/**
 * Choose people already in the directory and put them on the campaign.
 *
 * This enqueues existing contacts; it does not create them. The scheduler still checks
 * consent and the calling window before it dials, so a chosen contact is a pending call, not
 * a placed one. Contacts already on the campaign, and any id from another organisation, are
 * skipped by the API — the result says how many of the chosen actually became a new call.
 *
 * **The search asks the server.** It used to filter one page of a hundred in the browser, and
 * `readContacts` orders by the most recent call — so an imported contact, which has never
 * called, sorts behind everybody who has. An organisation with a hundred past callers could
 * import five hundred people and find none of them here: the import said it worked and then
 * dead-ended. Searching the directory itself makes it reachable at any size.
 *
 * **A tick survives everything.** Rows are hidden rather than dropped, chosen people are kept
 * in state, and the chosen are always rendered even when they are not in the current results —
 * otherwise typing a search that matches nobody unmounted the ticked checkboxes while the
 * footer still counted them, and the submit sent an empty list against a button reading
 * "Enqueue 3".
 */
export const AddContactsButton = ({
  campaignId,
  contacts,
}: {
  readonly campaignId: string;
  readonly contacts: readonly PickerContact[];
}) => {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [picked, setPicked] = useState<ReadonlyMap<string, PickerContact>>(new Map());
  const [state, action, pending] = useActionState(enqueueContactsAction, START);
  useFormToast(state, (data) => `Enqueued ${data.enqueued} of ${data.requested} contacts.`);

  const [results, setResults] = useState<readonly PickerContact[]>(contacts);
  const [searching, setSearching] = useState(false);

  /* Debounced, and the answer is dropped if a later keystroke has already been sent — two
     searches in flight can otherwise land out of order and show the earlier one's results. */
  useEffect(() => {
    if (!open) return;
    let current = true;
    const id = window.setTimeout(() => {
      setSearching(true);
      void findCampaignContacts(query.trim()).then((found) => {
        if (!current) return;
        setSearching(false);
        if (found.ok) setResults(found.contacts);
      });
    }, 250);
    return () => {
      current = false;
      window.clearTimeout(id);
    };
  }, [query, open]);

  /* What is drawn: the results, plus anybody ticked who is not among them. A person already
     chosen must stay on screen and stay submitted whatever is typed afterwards. */
  const listed = useMemo(() => {
    const byId = new Map(results.map((c) => [c.id, c] as const));
    for (const c of contacts) if (selected.has(c.id) && !byId.has(c.id)) byId.set(c.id, c);
    for (const c of picked.values()) if (!byId.has(c.id)) byId.set(c.id, c);
    return [...byId.values()];
  }, [results, contacts, selected, picked]);
  const shown = new Set(results.map((c) => c.id));

  const toggle = (contact: PickerContact, on: boolean) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (on) next.add(contact.id);
      else next.delete(contact.id);
      return next;
    });
    /* Keep the row itself, not just its id: once a later search no longer returns this person
       there would otherwise be nothing to draw or to submit for them. */
    setPicked((prev) => {
      const next = new Map(prev);
      if (on) next.set(contact.id, contact);
      else next.delete(contact.id);
      return next;
    });
  };

  const hasContacts = contacts.length > 0;

  return (
    <>
      <Button variant="secondary" onClick={() => setOpen(true)}>
        Add contacts
      </Button>

      <Modal
        open={open}
        onClose={() => setOpen(false)}
        size="wide"
        title="Add contacts"
        description="Choose people from the directory to enqueue as calls. Consent and the calling window are still checked before any of them is dialled."
        footer={
          hasContacts ? (
            <>
              <Button onClick={() => setOpen(false)} disabled={pending}>
                Cancel
              </Button>
              <SubmitButton
                form="enqueue-contacts"
                pending={pending}
                idle={selected.size === 0 ? "Choose contacts" : `Enqueue ${selected.size}`}
                busy="Enqueuing…"
              />
            </>
          ) : (
            <Button onClick={() => setOpen(false)}>Close</Button>
          )
        }
      >
        {hasContacts ? (
          <form id="enqueue-contacts" action={action}>
            <input type="hidden" name="campaignId" value={campaignId} />
            <Stack gap="sm">
              <input
                type="search"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="Filter by name or number"
                className={CONTROL}
              />

              <div className="max-h-[46vh] overflow-y-auto rounded-lg border border-[var(--hairline)]">
                {/* The message sits beside the rows, never in place of them: replacing the
                    list unmounted the ticked checkboxes, so a search matching nobody emptied
                    the submission while the footer still counted the ticks. */}
                {results.length === 0 && !searching && (
                  <p className="px-3 py-6 text-center text-[13px] text-[var(--ink-3)]">
                    {selected.size === 0
                      ? "No contact matches that."
                      : "No other contact matches that. The people you have chosen are still below."}
                  </p>
                )}
                {listed.map((contact) => (
                    <label
                      key={contact.id}
                      /* Hidden, not removed, so a tick survives a search that excludes it —
                         and never hidden while it is ticked. */
                      hidden={!shown.has(contact.id) && !selected.has(contact.id)}
                      className="flex cursor-pointer items-center gap-3 border-b border-[var(--surface-line)] px-3 py-2.5 last:border-b-0 hover:bg-[var(--surface-2)]"
                    >
                      <input
                        type="checkbox"
                        name="contactIds"
                        value={contact.id}
                        checked={selected.has(contact.id)}
                        onChange={(event) => toggle(contact, event.target.checked)}
                        className="size-4 rounded border-[var(--hairline)] accent-[var(--accent)]"
                      />
                      <span className="min-w-0">
                        <span className="block truncate text-[13.5px] font-medium">
                          {contact.displayName ?? "Unnamed caller"}
                        </span>
                        <span className="block truncate font-mono text-[11.5px] text-[var(--ink-3)]">
                          {contact.phone}
                        </span>
                      </span>
                    </label>
                ))}
              </div>

              <p className="text-[12px] text-[var(--ink-3)]">
                {selected.size === 0
                  ? "Nobody chosen yet."
                  : `${selected.size} chosen. Some may be skipped if they are already on this campaign.`}
              </p>

              {state.status === "succeeded" && (
                <Notice tone={state.data !== null && state.data.enqueued > 0 ? "ok" : "warn"}>
                  {state.message}
                </Notice>
              )}
              {(state.status === "failed" || state.status === "invalid") && (
                <Notice tone="error">{state.message}</Notice>
              )}
            </Stack>
          </form>
        ) : (
          <Stack>
            <Notice tone="info">
              There is nobody in the directory yet. A person appears there the first time a
              caller confirms something, or when one is added by hand on the Contacts page.
            </Notice>
            <div>
              <Link href="/contacts" className={buttonClass()}>
                Go to contacts
              </Link>
            </div>
          </Stack>
        )}
      </Modal>
    </>
  );
};
