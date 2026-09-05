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
 * sentence with `{when}` still in it is a visible mistake somebody catches on the first test
 * call, while a sentence that silently reads "your viewing at on" is one nobody notices until
 * a caller hears it.
 */
export const mergeFacts = (
  text: string,
  facts: Readonly<Record<string, string>> | null | undefined,
): string => {
  if (facts === null || facts === undefined) return text;
  return text.replace(/\{([a-zA-Z][a-zA-Z0-9_]*)\}/g, (whole, key: string) => facts[key] ?? whole);
};

/** What the orchestrator needs to know about the campaign it is ringing for. */
export interface CampaignCall {
  readonly organizationName: string;
  readonly purpose: string;
  readonly opening: string | null;
  readonly outcomes: readonly string[];
  /** This person's own detail, merged into the purpose and the opening. */
  readonly facts: Readonly<Record<string, string>> | null;
}

/**
 * What this particular call is about, as a layer for the prompt.
 *
 * Sits directly after `OUTBOUND_LAYER`, which tells the agent it must open by saying who it
 * is, which company, and why it is calling — and then has nothing to say for the third. This
 * is the third. Without it the model composes a reason, and an invented reason for an
 * unexpected call is indistinguishable from a scam to the person who answers.
 *
 * Static for the whole call, so it belongs in the stable prefix beside the safety layer rather
 * than in the per-turn steering, where it would cost the prompt cache on every exchange.
 *
 * The outcomes are named but not explained: the agent records one with `record_call_outcome`
 * at the end, and a list of the names is all it needs to choose. Describing each one would be
 * the kind of prompt instruction that code should carry instead.
 */
export const campaignLayer = (call: CampaignCall): string => {
  const purpose = mergeFacts(call.purpose, call.facts).trim();
  const opening = call.opening === null ? null : mergeFacts(call.opening, call.facts).trim();

  const lines = [
    `You are calling on behalf of ${call.organizationName}.`,
    "",
    `Why you are calling: ${purpose}`,
  ];

  if (opening !== null && opening !== "") {
    lines.push(
      "",
      "Open with this, in your own voice but keeping its meaning and its facts:",
      opening,
    );
  }

  lines.push(
    "",
    "That is the whole reason you rang. Do not raise anything else, do not take the call",
    "somewhere it was not going, and once it is settled say so in one sentence and finish.",
  );

  if (call.outcomes.length > 0) {
    lines.push(
      "",
      "Before the call ends, record how it went with record_call_outcome, choosing one of:",
      call.outcomes.map((outcome) => `- ${outcome}`).join("\n"),
      "Record it once, from what they actually said, and never guess to make the number",
      "look better. If none of them fits what happened, say so in the note rather than",
      "picking the nearest one.",
    );
  }

  return lines.join("\n");
};
