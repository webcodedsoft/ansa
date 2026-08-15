import { api } from "@/lib/api/server";

import type { CredentialFormInput, WebhooksBody } from "./connect.schema";

/**
 * Everything Connect does with the API: numbers, event subscriptions and credentials.
 *
 * Kept together for the same reason `agent.service.ts` and `calls.service.ts` are — the page
 * that reads a document and the action that writes it go through the same functions, so they
 * cannot drift into disagreeing about its shape.
 */

// ---------------------------------------------------------------------------
// Numbers
// ---------------------------------------------------------------------------

/** The numbers attached to this organisation. At most one today, per the API's own note. */
export const listNumbers = async () => (await api()).numbers.list();

/** What this organisation can and cannot do to get a number, and who to ask instead. */
export const numberProvisioning = async () => (await api()).numbers.provisioning();

export type NumbersList = Awaited<ReturnType<typeof listNumbers>>;
export type NumberSummary = NumbersList["items"][number];
export type NumberProvisioning = Awaited<ReturnType<typeof numberProvisioning>>;

// ---------------------------------------------------------------------------
// Event subscriptions (webhooks)
// ---------------------------------------------------------------------------

/** The current subscription document, with the redaction rules already resolved per receiver. */
export const currentSubscriptions = async () => (await api()).eventSubscriptions.read();

export type SubscriptionDocument = Awaited<ReturnType<typeof currentSubscriptions>>;
export type SubscriptionEntry = SubscriptionDocument["subscriptions"][number];

/**
 * Replace the whole document.
 *
 * Returns only the new version number — the page re-reads the live document after
 * revalidation, so there is no second copy of it to keep in sync with the first.
 */
export const replaceSubscriptions = async (
  body: WebhooksBody,
): Promise<{ readonly configVersion: number }> =>
  (await api()).eventSubscriptions.replace({ body });

// ---------------------------------------------------------------------------
// Credentials
// ---------------------------------------------------------------------------

/** Names, kinds and dates only. No credential value is ever returned by this API. */
export const listCredentials = async () => (await api()).credentials.list();

export type CredentialsList = Awaited<ReturnType<typeof listCredentials>>;
export type CredentialSummary = CredentialsList["items"][number];

/**
 * Store a credential under this name, or rotate the one already there. Write-only.
 *
 * A `switch` on `input.kind` rather than a spread, so each branch narrows to the exact
 * fields that kind takes and TypeScript — not a runtime shape check — is what stops a
 * `basic` submission from ever carrying a stray `token`.
 */
export const putCredential = async (
  input: CredentialFormInput,
): Promise<{ readonly ref: string; readonly createdAt: string; readonly updatedAt: string }> => {
  const client = await api();
  switch (input.kind) {
    case "bearer":
      return client.credentials.put({
        path: { ref: input.ref },
        body: { kind: "bearer", token: input.token },
      });
    case "header":
      return client.credentials.put({
        path: { ref: input.ref },
        body: { kind: "header", header: input.header, value: input.value },
      });
    case "basic":
      return client.credentials.put({
        path: { ref: input.ref },
        body: { kind: "basic", username: input.username, password: input.password },
      });
    case "signing":
      return client.credentials.put({
        path: { ref: input.ref },
        body: { kind: "signing", secret: input.secret },
      });
  }
};

export const removeCredential = async (ref: string): Promise<void> => {
  await (await api()).credentials.remove({ path: { ref } });
};
