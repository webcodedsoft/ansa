import { api } from "@/lib/api/server";

/**
 * Everything this app does with the people who have called.
 *
 * A contact is assembled from confirmed captures across every call from one number. The
 * calls list and the collected-data list both answer "what happened"; this answers "who is
 * this", which is the question somebody working through enquiries actually asks.
 */

export const listContacts = async (search?: string) => {
  const query: Record<string, string> = {};
  if (search !== undefined && search.trim() !== "") query["search"] = search.trim();
  return (await api()).contacts.list({ query });
};

export const readContactDetail = async (contactId: string) =>
  (await api()).contacts.detail({ path: { contactId } });

export type ContactSummary = Awaited<ReturnType<typeof listContacts>>["items"][number];
export type ContactDetail = Awaited<ReturnType<typeof readContactDetail>>;
export type ContactValue = ContactSummary["values"][number];
