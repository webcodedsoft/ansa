import type { EmotionalRead } from "../conversation/emotional-read";

/**
 * What the agent is permitted to do this turn, decided before the model is asked.
 *
 * The distinction that makes this worth having: it computes what is *permitted*, never what
 * to *say*. Deciding the next sentence deterministically rebuilds the IVR flowchart that
 * makes these systems sound scripted — but removing options does not, because the wording
 * stays entirely the model's. The policy layer narrows the room; the model moves freely
 * inside it.
 *
 * Everything here already existed as a number somewhere. `EscalationWatch` has counted
 * turns that went nowhere since R6.4, Phase 4b counts contacts this week, Phase 5 reads how
 * the caller sounds. None of it was ever consulted before offering the model a tool. This
 * is the consultation.
 *
 * **Escalation itself was already enforced; what was missing is the state in between.** The
 * watch transfers at three failed turns, hard, and that stays. What it could not do is stop
 * the agent quietly changing somebody's address on the second failure, while the call was
 * already coming apart. A caller who is angry, distrustful, on their fourth call this week
 * and being misunderstood should not be able to have their account altered by an agent that
 * cannot follow the conversation.
 *
 * Pure. No clock, no I/O, and no knowledge of what a tool is beyond its name.
 */

export interface DialogueState {
  /** Turns that went nowhere and have not been reset by one that worked. */
  readonly failedTurns: number;
  /** True once a transfer has been triggered. */
  readonly escalationOffered: boolean;
  /** How the caller sounds, or null before the first read has arrived. */
  readonly read: EmotionalRead | null;
  /** Calls from this number in the seven days before this one. */
  readonly contactsThisWeek: number;
}

export interface TurnConstraints {
  /**
   * A person has to take this call, and the agent may not do anything else first.
   *
   * Not a suggestion the prompt carries: the list handed to the model is filtered and the
   * dispatch site refuses anything outside it, so an agent that ignores its instructions
   * still cannot act.
   */
  readonly escalationRequired: boolean;
  /** Why, for the log and for the line the agent is told to say. Null when nothing fired. */
  readonly reason: string | null;
  /**
   * The tools that may still be called, or null for "all of them".
   *
   * Null rather than the full list, deliberately: this module does not know what is
   * registered, and returning a list it invented would be a second source of truth for
   * something the registry owns.
   */
  readonly allowedTools: readonly string[] | null;
}

/**
 * What survives when the call has gone wrong: getting a person, and ending it.
 *
 * `end_call` stays because a caller who says goodbye mid-collapse should still be able to
 * hang up cleanly, rather than be held on a line whose agent has been disarmed.
 */
const WHEN_ESCALATING: readonly string[] = ["transfer_to_human", "end_call"];

/** Two, not three. The watch transfers at three; this is the turn before it does. */
const FAILED_TURNS = 2;
/**
 * Three contacts in a week is a failed process rather than a difficult caller, and a fourth
 * attempt by the same agent is the thing people complain about publicly.
 */
const CONTACTS_THIS_WEEK = 3;

/**
 * The reasons, in the order they are checked.
 *
 * Ordered so the reason given is the most specific true one. "They have called four times
 * this week" tells somebody reviewing the call more than "the caller is angry" does, even
 * when both hold.
 */
export const computeConstraints = (state: DialogueState): TurnConstraints => {
  const permit = (reason: string | null): TurnConstraints =>
    reason === null
      ? { escalationRequired: false, reason: null, allowedTools: null }
      : { escalationRequired: true, reason, allowedTools: WHEN_ESCALATING };

  if (state.contactsThisWeek >= CONTACTS_THIS_WEEK) {
    return permit(`they have called ${state.contactsThisWeek} times this week`);
  }
  if (state.failedTurns >= FAILED_TURNS) {
    return permit(`${state.failedTurns} turns on this call have gone nowhere`);
  }
  /* Angry *and* not believing you. Either alone is a call to handle carefully and neither is
     a reason to disarm the agent — plenty of angry callers get helped. Together they are
     somebody who has decided this is not working, and nothing the agent does next changes
     that except handing over. */
  if (state.read?.emotion === "angry" && state.read.trust === "low") {
    return permit("the caller is angry and does not trust the answers");
  }
  /* Reads as calm and is not: somebody who has given up. The most missed signal there is,
     which is exactly why it is enforced here rather than left to be noticed. */
  if (state.read?.emotion === "resigned") {
    return permit("the caller has given up on getting this resolved");
  }

  return permit(null);
};
