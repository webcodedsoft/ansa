import { cookies } from "next/headers";
import { redirect } from "next/navigation";

import { AnsaApiError, createAnsaClient, type AnsaClient } from "./generated";

/**
 * The only place this app talks to the Ansa API, and it is server-side without exception.
 *
 * That is not a preference. The API enables no CORS, so a browser cannot reach it at all —
 * the choice is a server-side caller or a public proxy, and a proxy that forwards a token
 * from JavaScript would put the session where any script on the page can read it. So the
 * token lives in an httpOnly cookie, Server Components read data with it, Server Actions
 * mutate with it, and the browser never learns the API's address or the token's value.
 *
 * Practically, that means: no `NEXT_PUBLIC_` variable anywhere, no `fetch` in a client
 * component, and no route handler that exists only to relay a request. If a screen needs
 * data, the page loads it; if a button changes something, an action does it.
 */

const SESSION_COOKIE = "ansa_session";

/**
 * Where the API is. Read per request rather than captured at module load, so the same build
 * runs against a local API and a deployed one without being rebuilt.
 */
const baseUrl = (): string => {
  const url = process.env["ANSA_API_URL"];
  if (url === undefined || url === "") {
    throw new Error(
      "ANSA_API_URL is not set. Point it at the Ansa API, e.g. http://127.0.0.1:3000",
    );
  }
  return url;
};

export const readSessionToken = async (): Promise<string | null> =>
  (await cookies()).get(SESSION_COOKIE)?.value ?? null;

/**
 * Store the token from a successful sign-in.
 *
 * `expires` mirrors the API's own expiry rather than a duration invented here, so the
 * cookie and the session row stop being valid at the same moment. A cookie that outlives
 * its session produces a signed-in-looking app that 401s on every request.
 *
 * Only callable from a Server Action or route handler — Next forbids setting a cookie
 * during a page render, which is the correct restriction and not worth working around.
 */
export const startSession = async (token: string, expiresAt: string): Promise<void> => {
  const expires = new Date(expiresAt);
  (await cookies()).set(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    ...(Number.isNaN(expires.getTime()) ? {} : { expires }),
  });
};

export const clearSession = async (): Promise<void> => {
  (await cookies()).delete(SESSION_COOKIE);
};

const clientFor = (token: string | null): AnsaClient =>
  createAnsaClient({ baseUrl: baseUrl(), token: () => token });

/** A client with no session, for the two endpoints that work without one. */
export const anonymousApi = (): AnsaClient => clientFor(null);

/**
 * A client for the signed-in caller.
 *
 * Redirects rather than returning null when there is no cookie, so a page never has to
 * decide what to render for a visitor who is not signed in. The API would refuse the
 * request anyway; this only saves the round trip and gives a better destination than a
 * 401 page.
 */
export const api = async (): Promise<AnsaClient> => {
  const token = await readSessionToken();
  if (token === null) redirect("/sign-in");
  return clientFor(token);
};

/**
 * Run a request that needs a session, sending an expired one back to sign in.
 *
 * `api()` only redirects when the cookie is *missing*. A cookie that is present and no
 * longer valid — revoked, expired, or belonging to an organisation that has since been
 * deleted — sails past that check and 401s inside the page, which Next renders as a crash.
 * Somebody whose session simply timed out should be asked to sign in again, not shown a
 * stack trace.
 *
 * The stale cookie is deliberately not cleared here: a Server Component cannot set cookies
 * during render, and signing in overwrites it anyway. Until then every workspace route
 * bounces to the same place, which is the correct behaviour regardless.
 */
export const withSession = async <T>(read: () => Promise<T>): Promise<T> => {
  try {
    return await read();
  } catch (error) {
    if (refusedWith(error, 401)) redirect("/sign-in");
    throw error;
  }
};

/**
 * A client for the current session, or null when there is none.
 *
 * For the one caller that must not redirect: signing out. `api()` sends a visitor with no
 * cookie to the sign-in page, and wrapping that in a `try` to sign out best-effort would
 * swallow the redirect Next throws to do it.
 */
export const apiIfSignedIn = async (): Promise<AnsaClient | null> => {
  const token = await readSessionToken();
  return token === null ? null : clientFor(token);
};

/**
 * What went wrong, in words a person can act on.
 *
 * The API speaks RFC 9457, so a failure already carries a title and usually a detail
 * written for a human — the consent gate's refusal, for instance, says which rule stopped
 * the call. Showing that beats any message this app could invent, because this app does not
 * know the reason and the API does.
 *
 * Anything that is not an `AnsaApiError` is a bug or an outage here rather than a refusal
 * there, and says so instead of pretending to be a validation message.
 */
export const failureMessage = (error: unknown): string => {
  if (error instanceof AnsaApiError) {
    const { title, detail } = error.problem;
    return detail === undefined || detail === "" ? title : `${title}: ${detail}`;
  }
  if (error instanceof Error && error.message !== "") return error.message;
  return "The request failed and the reason was not readable.";
};

/** True when the API refused for this specific reason, e.g. 422 from the consent gate. */
export const refusedWith = (error: unknown, status: number): boolean =>
  error instanceof AnsaApiError && error.problem.status === status;
