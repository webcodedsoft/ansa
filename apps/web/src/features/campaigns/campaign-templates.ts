import type { CapturedField } from "@/features/agents/agents.schema";
import type { TemplateBranch } from "@/features/agents/templates.shape";
import { field } from "@/features/agents/templates.shape";

import type { CampaignWindow } from "./campaigns.service";

/**
 * A campaign somebody actually runs, ready to be pointed at a list.
 *
 * Not a form with defaults. Each of these is a specific thing a specific kind of
 * organisation rings people about — a school chasing fees before term, a clinic reminding
 * patients the day before — written with the reason the agent opens with, the exact verdicts
 * that campaign records, the conversation it has to have when the person says something back,
 * and the retry policy that suits the subject. A fee reminder can try three times over a
 * week; a same-day appointment reminder that has not connected by tonight is pointless
 * tomorrow.
 *
 * The purpose is what the agent says in its first breath, so it is written as the tail of
 * "I'm calling…". Anything in braces is filled per person from what is already known:
 * `{name}` always, and whatever the list carried as facts — `{amount}`, `{when}`,
 * `{property}`. A placeholder nobody has a value for is read out with its braces on, which is
 * why each template names the facts it expects and the create page shows them.
 *
 * The conversation reuses the agent-template machinery — the same `field` and `branch`
 * shapes, turned into a graph by `flowFromTemplate` — because a campaign's flow and an
 * agent's flow are the same kind of drawing and the canvas does not know the difference.
 */
export interface CampaignTemplate {
  readonly id: string;
  readonly name: string;
  /** The kind of organisation this is for. Matches the agent gallery's vocabulary. */
  readonly sector: string;
  /** One line for the card: what the campaign is for, not how it works. */
  readonly summary: string;
  /**
   * Why it rings, as the tail of "I'm calling…". The load-bearing field: without it the agent
   * composes a reason, and an invented reason for an unexpected call is what a scam sounds
   * like to whoever answers.
   */
  readonly purpose: string;
  /** The exact first line, or null to let the agent compose one from the purpose. */
  readonly opening: string | null;
  /** The verdicts the agent picks from at the end. What the breakdown on the page counts. */
  readonly outcomes: readonly string[];
  /**
   * The facts each contact should carry for the placeholders to fill. Shown on the create
   * page so somebody sees "this needs {amount} on every row" before they import a list
   * without it.
   */
  readonly facts: readonly { readonly key: string; readonly example: string }[];
  /** What to do when a machine answers. Silence is the safer default for anything private. */
  readonly voicemail: "hang_up" | "leave_message";
  readonly maxAttempts: number;
  readonly retryAfterMinutes: number;
  /** Null takes the default 08:00–20:00 bound; a window narrows it for the subject. */
  readonly callingWindow: CampaignWindow | null;
  /**
   * What the call has to collect when the person says something back, or null when the
   * campaign only confirms. Same shape as an agent template's, and drawn the same way.
   */
  readonly conversation: {
    readonly fields: readonly CapturedField[];
    readonly branch?: TemplateBranch;
    readonly closing?: string;
  } | null;
  /**
   * Why this template is shaped the way it is: the retry choice, the voicemail choice, the
   * one thing people get wrong. Shown on the card's detail so the template teaches rather
   * than merely fills.
   */
  readonly rationale: string;
}

const WEEKDAYS = [1, 2, 3, 4, 5];
const EVERY_DAY = [0, 1, 2, 3, 4, 5, 6];

/** Office hours, for subjects that want a person at their desk on the other end. */
const OFFICE_HOURS: CampaignWindow = { startHour: 9, endHour: 17, weekdays: WEEKDAYS };

/** Mid-morning to early evening, for reaching people at home without ringing at breakfast. */
const HOME_HOURS: CampaignWindow = { startHour: 10, endHour: 19, weekdays: EVERY_DAY };

/** Confirm, move, or cancel — the shape every reminder shares, parameterised by the thing booked. */
const confirmOrMove = (whatIsBooked: string): CampaignTemplate["conversation"] => ({
  fields: [
    field("attending", "choice", `Are you still able to make the ${whatIsBooked}?`, {
      options: ["yes", "need to change it", "cancel"],
      required: true,
    }),
  ],
  branch: {
    on: "attending",
    arms: {
      yes: { fields: [], closing: "Thank them, confirm the time once more, and say goodbye." },
      "need to change it": {
        fields: [
          field("preferredDay", "text", "What day would suit you better?", { required: true }),
          field("preferredTime", "text", "And roughly what time of day?", { required: false }),
        ],
        closing:
          "Say that somebody will call back to confirm the new time, and that nothing changes until they do.",
      },
      cancel: {
        fields: [field("reason", "text", "May I ask why, so we can note it?", { required: false })],
        closing:
          "Say that it has been noted, that there is nothing else they need to do, and say goodbye.",
      },
    },
  },
});

/**
 * The catalogue.
 *
 * Grouped by sector and ordered within each by how often it is run. Every one has been
 * written as if a real organisation of that kind were about to start it tomorrow: the
 * outcomes are the ones their operations person would actually want counted, and the retry
 * policy follows from what the call is about rather than from a default.
 */
export const CAMPAIGN_TEMPLATES: readonly CampaignTemplate[] = [
  // ------------------------------------------------------------------ Property
  {
    id: "viewing-confirmation",
    name: "Viewing confirmation",
    sector: "Property",
    summary: "The day before a viewing, check they are still coming and move it if not.",
    purpose: "to confirm your viewing at {property} on {when}",
    opening: null,
    outcomes: ["confirmed", "rescheduled", "cancelled", "no longer interested"],
    facts: [
      { key: "property", example: "the two-bedroom flat on Adeola Odeku" },
      { key: "when", example: "tomorrow at 11" },
    ],
    voicemail: "leave_message",
    maxAttempts: 3,
    retryAfterMinutes: 120,
    callingWindow: HOME_HOURS,
    conversation: confirmOrMove("viewing"),
    rationale:
      "Three tries two hours apart, because a viewing that is not confirmed by this evening is a wasted agent tomorrow morning — a longer gap would run past the point of being useful. Voicemail is fine here: a viewing is not a private matter, and the callback number is enough for them to move it.",
  },
  {
    id: "rent-reminder",
    name: "Rent due reminder",
    sector: "Property",
    summary: "A week before rent is due, remind them and note how they intend to pay.",
    purpose: "to remind you that your rent of {amount} for {property} is due on {when}",
    opening: null,
    outcomes: ["will pay on time", "will pay late", "already paid", "disputes the amount", "wants to speak to somebody"],
    facts: [
      { key: "amount", example: "one million two hundred thousand naira" },
      { key: "property", example: "flat 4B" },
      { key: "when", example: "the first of next month" },
    ],
    voicemail: "hang_up",
    maxAttempts: 3,
    retryAfterMinutes: 1440,
    callingWindow: HOME_HOURS,
    conversation: {
      fields: [
        field("intent", "choice", "Will you be able to pay by then?", {
          options: ["yes", "it will be late", "already paid", "I want to query it"],
          required: true,
        }),
      ],
      branch: {
        on: "intent",
        arms: {
          yes: { fields: [], closing: "Thank them and say goodbye." },
          "it will be late": {
            fields: [field("expectedDate", "date", "When do you expect to be able to pay?", { required: true })],
            closing: "Say that it has been noted and somebody from the office may be in touch, and say goodbye.",
          },
          "already paid": {
            fields: [field("paidWhen", "date", "When did you make the payment?", { required: false })],
            closing: "Apologise for the reminder, say the office will check the account, and say goodbye.",
          },
          "I want to query it": {
            fields: [],
            handover: "They have a question about the amount that a person should answer.",
          },
        },
      },
    },
    rationale:
      "Once a day, three times, so the reminder lands on three different days rather than three times on one. Never a voicemail — the amount somebody owes is not something to leave on a machine that plays out loud in a shared flat. A disputed amount goes to a person; an agent must never argue about money.",
  },
  {
    id: "maintenance-followup",
    name: "Repair follow-up",
    sector: "Property",
    summary: "After a repair is marked done, ask whether it actually was.",
    purpose: "to check that the {issue} at {property} has been fixed to your satisfaction",
    opening: null,
    outcomes: ["fixed", "not fixed", "partly fixed"],
    facts: [
      { key: "issue", example: "leaking kitchen tap" },
      { key: "property", example: "your flat" },
    ],
    voicemail: "leave_message",
    maxAttempts: 2,
    retryAfterMinutes: 240,
    callingWindow: HOME_HOURS,
    conversation: {
      fields: [
        field("fixed", "choice", "Has the problem been sorted out?", {
          options: ["yes", "no", "partly"],
          required: true,
        }),
      ],
      branch: {
        on: "fixed",
        arms: {
          yes: { fields: [], closing: "Thank them and say goodbye." },
          no: {
            fields: [field("stillWrong", "text", "What is still wrong?", { required: true })],
            closing: "Apologise, say it will be raised again as a priority, and say goodbye.",
          },
          partly: {
            fields: [field("remaining", "text", "What is left to do?", { required: true })],
            closing: "Say it will be passed on and somebody will be in touch about the rest, and say goodbye.",
          },
        },
      },
    },
    rationale:
      "Two tries only. This is a courtesy call; a tenant who does not answer twice has told you it is fine, and a third attempt turns a nice gesture into a nuisance.",
  },

  // ------------------------------------------------------------------ Healthcare
  {
    id: "appointment-reminder",
    name: "Appointment reminder",
    sector: "Healthcare",
    summary: "The day before, confirm the appointment and free the slot if they cannot make it.",
    purpose: "to remind you of your appointment with {clinician} on {when}",
    opening: null,
    outcomes: ["confirmed", "rescheduled", "cancelled"],
    facts: [
      { key: "clinician", example: "Dr Adebayo" },
      { key: "when", example: "tomorrow at 2:30" },
    ],
    voicemail: "hang_up",
    maxAttempts: 3,
    retryAfterMinutes: 90,
    callingWindow: HOME_HOURS,
    conversation: confirmOrMove("appointment"),
    rationale:
      "No voicemail, ever, for anything medical: a message naming a clinic on a shared answerphone tells the household something the patient may not have. Three tries ninety minutes apart, because a slot freed this afternoon can be given to somebody on the waiting list and one freed tomorrow morning cannot.",
  },
  {
    id: "results-ready",
    name: "Results are ready",
    sector: "Healthcare",
    summary: "Tell them results are in and book the follow-up. Never say what the results are.",
    purpose: "to let you know your results are ready and to arrange a time to come in and discuss them",
    opening: null,
    outcomes: ["follow-up booked", "will call back", "declined"],
    facts: [],
    voicemail: "hang_up",
    maxAttempts: 4,
    retryAfterMinutes: 360,
    callingWindow: OFFICE_HOURS,
    conversation: {
      fields: [
        field("bookNow", "choice", "Would you like to book a time now?", {
          options: ["yes", "I'll call back", "no"],
          required: true,
        }),
      ],
      branch: {
        on: "bookNow",
        arms: {
          yes: {
            fields: [
              field("preferredDay", "text", "What day suits you?", { required: true }),
              field("preferredTime", "text", "Morning or afternoon?", { required: false }),
            ],
            closing: "Say the clinic will confirm the exact time by message, and say goodbye.",
          },
          "I'll call back": { fields: [], closing: "Give the clinic's number and say goodbye." },
          no: {
            fields: [],
            handover: "They are declining a results follow-up; a clinician should speak to them.",
          },
        },
      },
    },
    rationale:
      "The purpose says results are ready and nothing about what they say — the agent must never be in a position to. Four tries over two days because this matters more than a reminder, and office hours only so a person is at the clinic to take the handover.",
  },
  {
    id: "vaccination-drive",
    name: "Vaccination drive",
    sector: "Healthcare",
    summary: "Invite eligible patients to a clinic day and book them into a slot.",
    purpose: "to invite you to our {vaccine} clinic on {when} and to book you a time if you would like one",
    opening: null,
    outcomes: ["booked", "not interested", "already had it", "wants information"],
    facts: [
      { key: "vaccine", example: "flu vaccination" },
      { key: "when", example: "Saturday the 14th" },
    ],
    voicemail: "leave_message",
    maxAttempts: 2,
    retryAfterMinutes: 1440,
    callingWindow: HOME_HOURS,
    conversation: {
      fields: [
        field("interested", "choice", "Would you like to come along?", {
          options: ["yes", "no", "already had it", "tell me more"],
          required: true,
        }),
      ],
      branch: {
        on: "interested",
        arms: {
          yes: {
            fields: [
              field("slot", "choice", "Morning or afternoon?", { options: ["morning", "afternoon"], required: true }),
            ],
            closing: "Confirm the day and the half, say a reminder will come the day before, and say goodbye.",
          },
          no: { fields: [], closing: "Thank them for their time and say goodbye." },
          "already had it": {
            fields: [],
            closing: "Say that is good to know and the record will be updated, and say goodbye.",
          },
          "tell me more": {
            fields: [],
            handover: "They want to know about the vaccine itself, which is a question for a nurse.",
          },
        },
      },
    },
    rationale:
      "Two tries a day apart: an invitation is not urgent and a third call about a clinic day is the kind of thing people complain about. A voicemail is acceptable because a vaccine clinic is public information, and it lets them ring back to book. Medical questions go to a nurse, always.",
  },

  // ------------------------------------------------------------------ Education
  {
    id: "school-fees",
    name: "School fees reminder",
    sector: "Education",
    summary: "Before term, remind parents fees are due and learn who needs a plan.",
    purpose: "to remind you that {student}'s school fees of {amount} for {term} are due by {when}",
    opening: null,
    outcomes: ["will pay by deadline", "needs an instalment plan", "already paid", "child is leaving"],
    facts: [
      { key: "student", example: "Chidera" },
      { key: "amount", example: "three hundred and fifty thousand naira" },
      { key: "term", example: "second term" },
      { key: "when", example: "the 12th of January" },
    ],
    voicemail: "hang_up",
    maxAttempts: 3,
    retryAfterMinutes: 1440,
    callingWindow: { startHour: 10, endHour: 18, weekdays: EVERY_DAY },
    conversation: {
      fields: [
        field("intent", "choice", "Will you be able to settle it by then?", {
          options: ["yes", "I need to pay in instalments", "already paid", "my child is leaving"],
          required: true,
        }),
      ],
      branch: {
        on: "intent",
        arms: {
          yes: { fields: [], closing: "Thank them and say goodbye." },
          "I need to pay in instalments": {
            fields: [],
            handover: "They want an instalment plan, which only the bursar can agree.",
          },
          "already paid": {
            fields: [field("reference", "text", "Do you have the payment reference or the date it was made?", { required: false })],
            closing: "Apologise for the reminder, say the bursary will match the payment, and say goodbye.",
          },
          "my child is leaving": {
            fields: [],
            handover: "A withdrawal, which the school office needs to hear from them directly.",
          },
        },
      },
    },
    rationale:
      "Fees are private, so no voicemail. Once a day for three days lands on three different days. Anything about a payment plan or a withdrawal goes to a person — an agent should never negotiate money or accept a child leaving.",
  },
  {
    id: "absence-check",
    name: "Absence check",
    sector: "Education",
    summary: "A pupil is not in and nobody told the school. Find out why, quickly.",
    purpose: "because {student} has not arrived at school this morning and we have not heard from you",
    opening: null,
    outcomes: ["parent aware — ill", "parent aware — other", "parent unaware", "child is on the way"],
    facts: [{ key: "student", example: "Emeka" }],
    voicemail: "leave_message",
    maxAttempts: 3,
    retryAfterMinutes: 20,
    callingWindow: { startHour: 8, endHour: 12, weekdays: WEEKDAYS },
    conversation: {
      fields: [
        field("aware", "choice", "Are you aware they are not in today?", {
          options: ["yes, they are unwell", "yes, another reason", "they are on their way", "no, I was not aware"],
          required: true,
        }),
      ],
      branch: {
        on: "aware",
        arms: {
          "yes, they are unwell": {
            fields: [],
            closing: "Wish them well, say the register will be updated, and say goodbye.",
          },
          "yes, another reason": {
            fields: [field("reason", "text", "May I note the reason?", { required: false })],
            closing: "Say the register will be updated and say goodbye.",
          },
          "they are on their way": { fields: [], closing: "Say the office will look out for them and say goodbye." },
          "no, I was not aware": {
            fields: [],
            handover: "The parent did not know their child is missing from school. A person needs to be on this call now.",
          },
        },
      },
    },
    rationale:
      "Twenty minutes between tries and a morning-only window, because the whole point is to know before lunch. A parent who did not know is the case this exists for and is handed to a person immediately — an agent must not be the one holding that conversation.",
  },

  // ------------------------------------------------------------------ Banking & fintech
  {
    id: "loan-repayment",
    name: "Loan repayment reminder",
    sector: "Banking & fintech",
    summary: "Ahead of a due date, remind them and record whether it will be met.",
    purpose: "to remind you that your loan repayment of {amount} is due on {when}",
    opening: null,
    outcomes: ["will pay on time", "will pay late", "already paid", "cannot pay", "disputes"],
    facts: [
      { key: "amount", example: "forty-five thousand naira" },
      { key: "when", example: "Friday" },
    ],
    voicemail: "hang_up",
    maxAttempts: 3,
    retryAfterMinutes: 1440,
    callingWindow: HOME_HOURS,
    conversation: {
      fields: [
        field("intent", "choice", "Will you be able to make that payment?", {
          options: ["yes", "it will be late", "already paid", "I cannot pay", "I want to query it"],
          required: true,
        }),
      ],
      branch: {
        on: "intent",
        arms: {
          yes: { fields: [], closing: "Thank them and say goodbye." },
          "it will be late": {
            fields: [field("expectedDate", "date", "When do you expect to pay?", { required: true })],
            closing: "Say it has been noted and say goodbye. Do not mention charges or consequences.",
          },
          "already paid": { fields: [], closing: "Apologise, say the account will be checked, and say goodbye." },
          "I cannot pay": { fields: [], handover: "They cannot pay; that conversation belongs to a person." },
          "I want to query it": { fields: [], handover: "A dispute about the amount, which a person must handle." },
        },
      },
    },
    rationale:
      "Never a voicemail about a debt. Never a mention of consequences, fees or credit — the agent reminds and records, and everything harder goes to a person. The Central Bank's rules on recovery calls are not something to leave to a prompt; keep the agent to the reminder and the handover.",
  },
  {
    id: "card-activation",
    name: "Card activation nudge",
    sector: "Banking & fintech",
    summary: "A card was delivered and never activated. Walk them to activating it.",
    purpose: "because the new card we sent you has not been activated yet, and to help if anything is in the way",
    opening: null,
    outcomes: ["will activate", "did not receive it", "does not want it", "already activated"],
    facts: [],
    voicemail: "hang_up",
    maxAttempts: 2,
    retryAfterMinutes: 2880,
    callingWindow: HOME_HOURS,
    conversation: {
      fields: [
        field("status", "choice", "Did the card arrive safely?", {
          options: ["yes, I just haven't activated it", "it never arrived", "I don't want it", "I already activated it"],
          required: true,
        }),
      ],
      branch: {
        on: "status",
        arms: {
          "yes, I just haven't activated it": {
            fields: [],
            closing:
              "Tell them they can activate it in the app or by calling the number on the back of the card, and say goodbye. Do not ask for any card details.",
          },
          "it never arrived": {
            fields: [],
            handover: "A card is missing, which needs a person to block and reissue it.",
          },
          "I don't want it": { fields: [], closing: "Say that is noted and it will be cancelled, and say goodbye." },
          "I already activated it": { fields: [], closing: "Apologise and say goodbye." },
        },
      },
    },
    rationale:
      "The agent never asks for a card number, PIN or code — the outbound rules forbid it and this template is written so it never needs to. A missing card is a security event and goes straight to a person. Two tries two days apart; this is a nudge, not a chase.",
  },

  // ------------------------------------------------------------------ Insurance
  {
    id: "policy-renewal",
    name: "Policy renewal",
    sector: "Insurance",
    summary: "A month before a policy lapses, ask whether they want to renew.",
    purpose: "because your {policy} policy is due for renewal on {when}",
    opening: null,
    outcomes: ["renewing", "wants a quote first", "not renewing", "wants an adviser"],
    facts: [
      { key: "policy", example: "motor insurance" },
      { key: "when", example: "the 30th" },
    ],
    voicemail: "leave_message",
    maxAttempts: 3,
    retryAfterMinutes: 2880,
    callingWindow: HOME_HOURS,
    conversation: {
      fields: [
        field("intent", "choice", "Would you like to renew?", {
          options: ["yes", "I'd like a quote first", "no", "I want to speak to an adviser"],
          required: true,
        }),
      ],
      branch: {
        on: "intent",
        arms: {
          yes: { fields: [], closing: "Say the renewal documents will be sent and say goodbye." },
          "I'd like a quote first": {
            fields: [field("changes", "text", "Has anything changed since last year that we should know about?", { required: false })],
            closing: "Say an adviser will send a quote and say goodbye. Do not quote a price.",
          },
          no: {
            fields: [field("reason", "text", "May I ask why?", { required: false })],
            closing: "Thank them and say goodbye.",
          },
          "I want to speak to an adviser": { fields: [], handover: "They asked for an adviser." },
        },
      },
    },
    rationale:
      "Never quote a price — a figure said aloud by an agent is a figure somebody will hold you to. Two days between tries because renewal is not urgent a month out, and a voicemail is fine: a renewal date is not private and lets them ring back.",
  },
  {
    id: "claim-status",
    name: "Claim update",
    sector: "Insurance",
    summary: "Tell a claimant where their claim is, and what is needed from them.",
    purpose: "with an update on your claim {reference}: it is currently {stage}",
    opening: null,
    outcomes: ["informed", "will send documents", "has a question"],
    facts: [
      { key: "reference", example: "CLM-20481" },
      { key: "stage", example: "waiting for the repair estimate" },
    ],
    voicemail: "hang_up",
    maxAttempts: 2,
    retryAfterMinutes: 1440,
    callingWindow: OFFICE_HOURS,
    conversation: {
      fields: [
        field("next", "choice", "Is there anything you would like to ask about it?", {
          options: ["no, that's fine", "I have a question", "I'll send what's needed"],
          required: true,
        }),
      ],
      branch: {
        on: "next",
        arms: {
          "no, that's fine": { fields: [], closing: "Say goodbye." },
          "I have a question": {
            fields: [],
            handover: "A question about a live claim, which the claims handler should answer.",
          },
          "I'll send what's needed": { fields: [], closing: "Say what address to send it to and say goodbye." },
        },
      },
    },
    rationale:
      "Office hours only, because every question here goes to a handler and there has to be one at a desk. Nothing on a voicemail: a claim's stage is private to the claimant.",
  },

  // ------------------------------------------------------------------ Retail & e-commerce
  {
    id: "delivery-confirmation",
    name: "Delivery confirmation",
    sector: "Retail & e-commerce",
    summary: "The day before a delivery, check somebody will be in and the address is right.",
    purpose: "to confirm your delivery on {when} to {address}",
    opening: null,
    outcomes: ["confirmed", "change the day", "change the address", "cancel the order"],
    facts: [
      { key: "when", example: "tomorrow between 9 and 1" },
      { key: "address", example: "12 Bourdillon Road" },
    ],
    voicemail: "leave_message",
    maxAttempts: 3,
    retryAfterMinutes: 120,
    callingWindow: HOME_HOURS,
    conversation: {
      fields: [
        field("ok", "choice", "Is that still right, and will somebody be there?", {
          options: ["yes", "I need a different day", "the address is wrong", "cancel it"],
          required: true,
        }),
      ],
      branch: {
        on: "ok",
        arms: {
          yes: { fields: [], closing: "Thank them and say goodbye." },
          "I need a different day": {
            fields: [field("preferredDay", "date", "What day would suit?", { required: true })],
            closing: "Say the new day will be confirmed by message and say goodbye.",
          },
          "the address is wrong": {
            fields: [
              field("newAddress", "address", "What should the address be?", { required: true, confirm: "readback" }),
            ],
            closing: "Read the address back once more, say it has been updated, and say goodbye.",
          },
          "cancel it": { fields: [], handover: "A cancellation, which a person should confirm and refund." },
        },
      },
    },
    rationale:
      "An address is read back before it is accepted — a wrong digit is a lost parcel. Two hours between tries so it is settled the evening before. Cancellations go to a person because a refund is not something an agent should promise.",
  },
  {
    id: "abandoned-order",
    name: "Abandoned order",
    sector: "Retail & e-commerce",
    summary: "They got as far as the basket and stopped. Ask if anything got in the way.",
    purpose: "because you started an order with us for {item} and did not finish it, in case something got in the way",
    opening: null,
    outcomes: ["will complete it", "changed their mind", "had a problem", "just browsing"],
    facts: [{ key: "item", example: "the Samsung A54" }],
    voicemail: "hang_up",
    maxAttempts: 1,
    retryAfterMinutes: 60,
    callingWindow: HOME_HOURS,
    conversation: {
      fields: [
        field("why", "choice", "Was there anything stopping you?", {
          options: ["I'll finish it", "I changed my mind", "something went wrong", "just browsing"],
          required: true,
        }),
      ],
      branch: {
        on: "why",
        arms: {
          "I'll finish it": { fields: [], closing: "Say the basket is saved for them and say goodbye." },
          "I changed my mind": {
            fields: [],
            closing: "Thank them and say goodbye. Do not try to persuade them.",
          },
          "something went wrong": {
            fields: [field("problem", "text", "What happened?", { required: true })],
            closing: "Apologise, say it will be looked into, and say goodbye.",
          },
          "just browsing": { fields: [], closing: "Say no problem at all and say goodbye." },
        },
      },
    },
    rationale:
      "One try. A second call about a basket they walked away from is exactly what makes people block a number. No persuasion, no discount — the call asks whether something broke and takes the answer.",
  },

  // ------------------------------------------------------------------ Utilities & energy
  {
    id: "planned-outage",
    name: "Planned outage notice",
    sector: "Utilities & energy",
    summary: "Tell customers in an area about scheduled work and how long it will last.",
    purpose:
      "to let you know that supply to {area} will be interrupted on {when} for planned maintenance, for about {duration}",
    opening: null,
    outcomes: ["informed", "has a question", "needs continuous supply"],
    facts: [
      { key: "area", example: "Lekki Phase 1" },
      { key: "when", example: "Thursday from 9am" },
      { key: "duration", example: "four hours" },
    ],
    voicemail: "leave_message",
    maxAttempts: 2,
    retryAfterMinutes: 360,
    callingWindow: HOME_HOURS,
    conversation: {
      fields: [
        field("concern", "choice", "Is there anything about that you need to raise?", {
          options: ["no", "I have a question", "somebody here depends on the supply"],
          required: true,
        }),
      ],
      branch: {
        on: "concern",
        arms: {
          no: { fields: [], closing: "Apologise for the inconvenience and say goodbye." },
          "I have a question": { fields: [], handover: "A question about the work, for the operations desk." },
          "somebody here depends on the supply": {
            fields: [],
            handover:
              "A household with a medical or critical dependency on supply. A person must handle this before the outage.",
          },
        },
      },
    },
    rationale:
      "A voicemail is the point here: the message is the notice, and a machine hearing it is a household informed. Anybody who depends on supply — a dialysis machine, an oxygen concentrator — goes to a person at once, because that is the case a notice exists to catch.",
  },

  // ------------------------------------------------------------------ Any business
  {
    id: "satisfaction-followup",
    name: "How did we do?",
    sector: "Any business",
    summary: "A few days after a service, ask how it went and whether they would recommend you.",
    purpose: "to ask how things went with your recent {service} and whether there is anything we could have done better",
    opening: null,
    outcomes: ["happy", "mixed", "unhappy"],
    facts: [{ key: "service", example: "visit to the Ikeja branch" }],
    voicemail: "hang_up",
    maxAttempts: 2,
    retryAfterMinutes: 1440,
    callingWindow: HOME_HOURS,
    conversation: {
      fields: [
        field("rating", "choice", "Overall, how was it?", {
          options: ["good", "okay", "not good"],
          required: true,
        }),
        field("comment", "text", "Is there anything in particular you would like us to know?", { required: false }),
      ],
      branch: {
        on: "rating",
        arms: {
          good: { fields: [], closing: "Thank them warmly and say goodbye." },
          okay: { fields: [], closing: "Thank them for the honesty and say goodbye." },
          "not good": {
            fields: [
              field("callback", "choice", "Would you like somebody to call you about it?", { options: ["yes", "no"] , required: false }),
            ],
            closing: "Apologise, say what they said will be passed on, and say goodbye.",
          },
        },
      },
    },
    rationale:
      "Two tries a day apart and no voicemail — a survey on an answerphone is noise. An unhappy customer is offered a person rather than handed to one; forcing a call-back on somebody who only wanted to say it once is its own kind of unhappy.",
  },
  {
    id: "event-invitation",
    name: "Event invitation",
    sector: "Any business",
    summary: "Invite a list to an event and take RSVPs.",
    purpose: "to invite you to {event} on {when} at {venue}",
    opening: null,
    outcomes: ["attending", "maybe", "not attending", "wants details sent"],
    facts: [
      { key: "event", example: "our customer appreciation evening" },
      { key: "when", example: "Friday the 21st at 6pm" },
      { key: "venue", example: "the Eko Hotel" },
    ],
    voicemail: "leave_message",
    maxAttempts: 2,
    retryAfterMinutes: 2880,
    callingWindow: HOME_HOURS,
    conversation: {
      fields: [
        field("rsvp", "choice", "Will you be able to join us?", {
          options: ["yes", "maybe", "no", "send me the details"],
          required: true,
        }),
      ],
      branch: {
        on: "rsvp",
        arms: {
          yes: {
            fields: [field("guests", "quantity", "Will you be bringing anyone?", { required: false })],
            closing: "Say they are on the list and a reminder will come the day before, and say goodbye.",
          },
          maybe: { fields: [], closing: "Say the invitation stands and say goodbye." },
          no: { fields: [], closing: "Thank them and say goodbye." },
          "send me the details": {
            fields: [],
            closing: "Say the details will be sent by message and say goodbye.",
          },
        },
      },
    },
    rationale:
      "An invitation on a voicemail is still an invitation, so leave one. Two tries two days apart — nobody wants to be chased about a party.",
  },
];

/** The sectors present, in the order they first appear, for the gallery's filter. */
export const CAMPAIGN_SECTORS: readonly string[] = [
  ...new Set(CAMPAIGN_TEMPLATES.map((template) => template.sector)),
];

export const campaignTemplateById = (id: string): CampaignTemplate | null =>
  CAMPAIGN_TEMPLATES.find((template) => template.id === id) ?? null;
