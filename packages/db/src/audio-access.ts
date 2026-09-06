import type { OrganizationScope } from "./organization-scope";

/**
 * Who was given a call's audio, and when (migration 0078).
 *
 * The counterpart to the single-use link. A recording is the most personal thing this product
 * holds, and the API's own comment named the two conditions for serving one: a URL that is not
 * a guessable path, and a record of who listened. This is the second.
 *
 * Recorded when the link is minted, not when the bytes are fetched. The mint is the
 * authenticated request with a known member of staff behind it; the fetch carries only the
 * token, because an `<audio>` element cannot send an authorization header. "Was given the
 * ability to listen" is the honest claim and the only attributable one.
 */
/**
 * Note that somebody was handed a recording.
 *
 * `caller` is read off the call in the same statement rather than passed in, so the log cannot
 * be told a number the call does not have — and it survives the call being deleted, which is
 * exactly when somebody is most likely to ask who heard it.
 */
export const recordAudioAccess = async (
  scope: OrganizationScope,
  callId: string,
  userId: string | null,
): Promise<void> => {
  await scope.query(
    `insert into audio_access_log (organization_id, call_id, user_id, caller)
     select app.current_organization(), c.id, $2::uuid, c.caller
       from calls c
      where c.id = $1`,
    [callId, userId],
  );
};

/* There is deliberately no reader here yet.
 *
 * "Who has heard my call" is the question this table exists to answer, and answering it needs
 * a screen and a decision about who may see the list — a member of staff looking up who else
 * listened is a different permission from listening. Writing the reader before either exists
 * would be a function with no caller, which is what `check-wiring` refuses and what it was
 * right to refuse: the rows are being written from today, so the history is there when the
 * screen is built. */
