"use client";

import Link from "next/link";
import { useActionState, useMemo, useState } from "react";

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

import { enqueueContactsAction, type EnqueueState } from "../campaigns.actions";

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
 * The filter hides rows rather than dropping them, so a name typed after ticking somebody
 * does not quietly clear that tick. Selections are held in state and survive the filtering.
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
  const [state, action, pending] = useActionState(enqueueContactsAction, START);
  useFormToast(state, (data) => `Enqueued ${data.enqueued} of ${data.requested} contacts.`);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (q === "") return contacts;
    return contacts.filter(
      (c) => c.phone.toLowerCase().includes(q) || (c.displayName ?? "").toLowerCase().includes(q),
    );
  }, [contacts, query]);
  const shown = new Set(filtered.map((c) => c.id));

  const toggle = (id: string, on: boolean) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });

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
                {filtered.length === 0 ? (
                  <p className="px-3 py-6 text-center text-[13px] text-[var(--ink-3)]">
                    No contact matches that.
                  </p>
                ) : (
                  contacts.map((contact) => (
                    <label
                      key={contact.id}
                      hidden={!shown.has(contact.id)}
                      className="flex cursor-pointer items-center gap-3 border-b border-[var(--surface-line)] px-3 py-2.5 last:border-b-0 hover:bg-[var(--surface-2)]"
                    >
                      <input
                        type="checkbox"
                        name="contactIds"
                        value={contact.id}
                        checked={selected.has(contact.id)}
                        onChange={(event) => toggle(contact.id, event.target.checked)}
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
                  ))
                )}
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
