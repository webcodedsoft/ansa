import { anonymousApi, api, apiIfSignedIn, clearSession, startSession } from "@/lib/api/server";

/**
 * Everything this app does with sessions and identity.
 *
 * The service layer exists so that one question has one answer per feature: where does the
 * data come from. Pages and actions call these; nothing outside this file constructs an API
 * client for auth. That is what makes an endpoint rename a one-file change, and it is the
 * same reason the API keeps vendor SDKs inside adapters.
 *
 * Server-only, because everything here either reads or writes the session cookie. Importing
 * it from a client component is a build error rather than a subtle leak, which is the right
 * failure mode.
 */

export interface OrganisationChoice {
  readonly id: string;
  readonly name: string;
  readonly role: string;
}

export interface Session {
  readonly token: string;
  readonly expiresAt: string;
}

/**
 * Which organisations these credentials open.
 *
 * Empty for a wrong password and for an address with no account, and the API takes the same
 * time to answer both. Callers must preserve that: reporting the two differently turns this
 * into an oracle for whether an address is registered.
 */
export const organisationsFor = async (
  email: string,
  password: string,
): Promise<readonly OrganisationChoice[]> =>
  (await anonymousApi().auth.organisations({ body: { email, password } })).organisations;

/** Open a session and store it. The cookie is the only place the token is kept. */
export const signInTo = async (
  email: string,
  password: string,
  organisationId: string,
): Promise<Session> => {
  const session = await anonymousApi().auth.signIn({
    body: { email, password, organisationId },
  });
  await startSession(session.token, session.expiresAt);
  return { token: session.token, expiresAt: session.expiresAt };
};

/**
 * Create an organisation, and the account that owns it, and sign in.
 *
 * The API answers with a session, so this stores it — there is no second step and no screen
 * that asks somebody who just typed their password to type it again.
 */
export const createOrganisation = async (
  organisationName: string,
  email: string,
  password: string,
  displayName: string,
): Promise<{ readonly organisationName: string; readonly createdUser: boolean }> => {
  const created = await anonymousApi().auth.signUp({
    body: { organisationName, email, password, displayName },
  });
  await startSession(created.token, created.expiresAt);
  return { organisationName: created.organisation.name, createdUser: created.createdUser };
};

/**
 * Redeem an invitation, creating the person if they are new.
 *
 * `createdUser` distinguishes a brand-new account from an existing one joining a second
 * organisation. The API knows which happened and the caller cannot work it out, so it is
 * passed through rather than discarded.
 */
export const acceptInvitation = async (
  token: string,
  password: string,
  displayName: string,
): Promise<{ readonly organisationId: string; readonly createdUser: boolean }> => {
  const result = await anonymousApi().invitations.accept({
    body: { token, password, displayName },
  });
  return { organisationId: result.organisationId, createdUser: result.createdUser };
};

/** The signed-in user, their organisation, and what they may do in it. */
export const currentPrincipal = async () => (await api()).auth.me();

/**
 * End the session here and revoke it there.
 *
 * The cookie goes whatever the API says. If revocation fails — the API is down, the session
 * already expired — leaving the cookie would strand somebody signed in to a session that no
 * longer works, with no way to sign out of it.
 */
export const signOutEverywhere = async (): Promise<void> => {
  const client = await apiIfSignedIn();
  if (client !== null) {
    try {
      await client.auth.signOut();
    } catch {
      // Already revoked, expired, or unreachable. The local half still has to happen.
    }
  }
  await clearSession();
};
