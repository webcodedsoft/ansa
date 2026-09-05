import { api } from "@/lib/api/server";

/**
 * Everything this app does with the people who have called.
 *
 * A contact is assembled from confirmed captures across every call from one number. The
 * calls list and the collected-data list both answer "what happened"; this answers "who is
 * this", which is the question somebody working through enquiries actually asks.
 */

export const listContacts = async (
  search: string | undefined,
  paging: { readonly page?: number; readonly perPage?: number } = {},
) => {
  const query: Record<string, string | number> = { ...paging };
  if (search !== undefined && search.trim() !== "") query["search"] = search.trim();
  return (await api()).contacts.list({ query });
};

export const readContactDetail = async (
  contactId: string,
  paging: { readonly page?: number; readonly perPage?: number } = {},
) => (await api()).contacts.detail({ path: { contactId }, query: paging });

/**
 * Add one person the office knows about who has not rung yet.
 *
 * The number is upserted, so adding one that has already called returns that caller's own
 * record rather than a second copy — `created` says which happened, and the action turns that
 * into "already on your list" rather than pretending a new person was made.
 */
export const addContact = async (body: {
  readonly phone: string;
  readonly displayName?: string;
  readonly notes?: string;
}) => (await api()).contacts.add({ body });

/**
 * Bring in a labelled batch at once.
 *
 * The API normalises each number, folds duplicates, skips a row whose phone it cannot read,
 * and caps the batch at 5000 — so the counts it returns are the honest outcome and the caller
 * reports them as they are rather than as what was sent.
 */
export const importContacts = async (body: {
  readonly sourceLabel: string;
  readonly rows: readonly { readonly phone: string; readonly displayName?: string; readonly notes?: string }[];
}) => (await api()).contacts.import({ body });

export type ContactSummary = Awaited<ReturnType<typeof listContacts>>["page"]["items"][number];
export type ContactDetail = Awaited<ReturnType<typeof readContactDetail>>;
export type ContactValue = ContactSummary["values"][number];
