/**
 * What an outbound campaign is about.
 *
 * The contract both halves read, for the same reason the flow contract is shared: the console
 * draws the brief, the API validates it, and the orchestrator says it out loud on a call. Three
 * copies of the same shape is three chances for a campaign to mean something different on the
 * phone than it did on screen.
 *
 * A campaign is *not* an agent. An agent is a voice, a persona and a set of tools, and it is
 * reusable — the same front desk can run a reminder campaign on Monday and a follow-up campaign
 * on Friday. What changes between them is why the phone is ringing, and that is what lives here.
 */

/** The most a campaign may ask of one person, in total, before it gives up on them. */
export const CAMPAIGN_LIMITS = {
  purposeLength: 300,
  openingLength: 300,
  outcomeLength: 60,
  outcomes: 12,
  voicemailLength: 600,
  factKeyLength: 40,
  factValueLength: 200,
  facts: 20,
  attempts: { min: 1, max: 10 },
  /** Fifteen minutes at the least; a week at the most. */
  retryMinutes: { min: 15, max: 10080 },
} as const;

/**
 * What to do when a machine answers.
 *
 * `hang_up` is the default and the safe one. CLAUDE.md puts it plainly: an agent that holds a
 * two-minute conversation with a voicemail greeting is both useless and billed. Leaving a
 * message is a deliberate choice with its own cost — a message left by mistake cannot be taken
 * back — so it has to be asked for, and the words have to be written down rather than improvised
 * by a model talking to a beep.
 */
export const VOICEMAIL_MODES = ["hang_up", "leave_message"] as const;
export type VoicemailMode = (typeof VOICEMAIL_MODES)[number];

export interface CampaignVoicemail {
  readonly mode: VoicemailMode;
  /** Required when the mode is `leave_message`, and read verbatim. */
  readonly message?: string;
}

/**
 * The brief: everything about why this campaign rings and how the call should go.
 *
 * Every field is optional because a campaign can exist before it is thought through, and a
 * half-written brief should be savable. What is *not* optional is that a running campaign has a
 * purpose — that is checked when it starts, not when it is typed, so the refusal lands at the
 * moment it means something.
 */
export interface CampaignBrief {
  /** Why we are ringing, in one line and in the operator's words. Said in the opening. */
  readonly purpose?: string;
  /** The exact first line, if the operator wants to write it. Null lets the agent compose one. */
  readonly opening?: string;
  /** What counts as done, as names the agent picks from at the end of the call. */
  readonly outcomes?: readonly string[];
  readonly voicemail?: CampaignVoicemail;
  readonly maxAttempts?: number;
  readonly retryAfterMinutes?: number;
}

/**
 * Which parts of a campaign may still change.
 *
 * Draft and scheduled are editable; running, paused and done are not. The reason is Rule 4's
 * reason rather than Rule 4 itself: a campaign has no draft/publish cycle, but a call in flight
 * must not have its purpose or its script changed underneath it, and `status` already says
 * whether calls can be in flight. Deriving it from status rather than storing a second flag
 * keeps one source for one fact.
 */
export const briefIsEditable = (status: string): boolean =>
  status === "draft" || status === "scheduled";

/**
 * Fill `{placeholders}` from a contact's own facts.
 *
 * A campaign is about one thing and still has to be specific to each person: "your viewing at
 * {property} on {when}". Unknown placeholders are left standing rather than blanked, because a
 * sentence with `{when}` still in it is a visible mistake, while a sentence that silently reads
 * "your viewing at on" is one nobody catches until a caller hears it.
 */
export const mergeFacts = (
  text: string,
  facts: Readonly<Record<string, string>> | null | undefined,
): string => {
  if (facts === null || facts === undefined) return text;
  return text.replace(/\{([a-zA-Z][a-zA-Z0-9_]*)\}/g, (whole, key: string) => facts[key] ?? whole);
};
