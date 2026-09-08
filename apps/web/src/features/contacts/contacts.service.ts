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
  /** True for the people who have told us something; undefined for everybody. */
  identified?: boolean,
) => {
  const query: Record<string, string | number | boolean> = { ...paging };
  if (search !== undefined && search.trim() !== "") query["search"] = search.trim();
  if (identified !== undefined) query["identified"] = identified;
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

/**
 * Never ring this number again.
 *
 * Global and one-way from here: there is no endpoint that lifts a suppression, which is
 * deliberate on the API side and means this control is not a toggle however much it looks
 * like one. The caller confirms before sending.
 */
export const suppressContact = async (contactId: string, reason: string) =>
  (await api()).contacts.doNotCall({ path: { contactId }, body: { reason } });

export type ContactSummary = Awaited<ReturnType<typeof listContacts>>["page"]["items"][number];
export type ContactDetail = Awaited<ReturnType<typeof readContactDetail>>;
export type ContactValue = ContactSummary["values"][number];
