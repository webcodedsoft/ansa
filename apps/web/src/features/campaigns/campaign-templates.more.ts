import { field } from "@/features/agents/templates.shape";

import {
  confirmOrMove,
  EVERY_DAY,
  HOME_HOURS,
  OFFICE_HOURS,
  WEEKDAYS,
  type CampaignTemplate,
} from "./campaign-templates.shape";
import type { CampaignWindow } from "./campaigns.service";

/**
 * The wider catalogue: fifty more campaigns, across every sector the agent gallery knows.
 *
 * Held to the same standard as the founding seventeen and checked by the same tests. Each
 * one is a specific thing a specific kind of organisation rings people about, with the reason
 * written as the tail of "I'm calling…", the verdicts that campaign would actually count, a
 * conversation for what the person says back, and a retry policy argued from the subject
 * rather than copied from a default.
 *
 * Three rules hold throughout and are tested rather than hoped for. Money, medicine and
 * anything private never go on the answerphone. Every hard thing — a dispute, a refund, a
 * diagnosis, a withdrawal, a household in danger — goes to a person. And no conversation asks
 * for a card number, a PIN, a code, an ID or a date of birth, because the outbound rules
 * forbid it and a template is exactly where such a question would be typed in good faith.
 */

/** Early evening, for people who work a shift and are home after it. */
const EVENING: CampaignWindow = { startHour: 17, endHour: 20, weekdays: EVERY_DAY };

/** Mornings only, for things that have to be known before the day gets going. */
const MORNING: CampaignWindow = { startHour: 8, endHour: 12, weekdays: WEEKDAYS };

/** A yes/no with a reason on the no, for anything that only needs an answer. */
const yesOrWhy = (question: string, yesClose: string): CampaignTemplate["conversation"] => ({
  fields: [field("answer", "choice", question, { options: ["yes", "no"], required: true })],
  branch: {
    on: "answer",
    arms: {
      yes: { fields: [], closing: yesClose },
      no: {
        fields: [field("reason", "text", "May I ask why?", { required: false })],
        closing: "Thank them for saying and say goodbye.",
      },
    },
  },
});

export const MORE_CAMPAIGN_TEMPLATES: readonly CampaignTemplate[] = [
  // ------------------------------------------------------------------ Property
  {
    id: "lease-renewal",
    name: "Lease renewal",
    sector: "Property",
    summary: "Two months before a tenancy ends, ask whether they are staying.",
    purpose: "because your tenancy at {property} ends on {when} and we would like to know whether you plan to stay",
    opening: null,
    outcomes: ["renewing", "leaving", "undecided", "wants new terms"],
    facts: [
      { key: "property", example: "flat 4B, Ikoyi" },
      { key: "when", example: "the 31st of March" },
    ],
    voicemail: "hang_up",
    maxAttempts: 3,
    retryAfterMinutes: 2880,
    callingWindow: HOME_HOURS,
    conversation: {
      fields: [
        field("plan", "choice", "Are you planning to stay on?", {
          options: ["yes", "no, I'm leaving", "I haven't decided", "I'd like to discuss the terms"],
          required: true,
        }),
      ],
      branch: {
        on: "plan",
        arms: {
          yes: { fields: [], closing: "Say the renewal papers will be sent and say goodbye." },
          "no, I'm leaving": {
            fields: [field("moveOut", "date", "Do you know roughly when you will move out?", { required: false })],
            closing: "Thank them for the notice, say the office will confirm the process in writing, and say goodbye.",
          },
          "I haven't decided": { fields: [], closing: "Say there is no rush yet and somebody will check back in a fortnight, and say goodbye." },
          "I'd like to discuss the terms": { fields: [], handover: "They want to negotiate the tenancy, which is the landlord's conversation." },
        },
      },
    },
    rationale:
      "Two days between tries and a two-month lead: this is a decision people make slowly, and chasing it daily reads as pressure. Terms go to a person — an agent must never negotiate rent or conditions. No voicemail, because who is and is not renewing is private to the tenant.",
  },
  {
    id: "inspection-notice",
    name: "Inspection notice",
    sector: "Property",
    summary: "Tell a tenant when the routine inspection is and check the time works.",
    purpose: "to let you know the routine inspection of {property} is scheduled for {when}, and to check that suits you",
    opening: null,
    outcomes: ["confirmed", "rescheduled", "refused entry"],
    facts: [
      { key: "property", example: "your flat" },
      { key: "when", example: "Tuesday between 10 and 12" },
    ],
    voicemail: "leave_message",
    maxAttempts: 3,
    retryAfterMinutes: 1440,
    callingWindow: HOME_HOURS,
    conversation: confirmOrMove("inspection"),
    rationale:
      "Tenants have a right to reasonable notice, so this goes out with days to spare and a day between tries. A voicemail is fine — the visit is not private — and lets them ring back to move it.",
  },
  {
    id: "service-charge",
    name: "Service charge due",
    sector: "Property",
    summary: "Estate service charge is due; remind residents and note who disputes it.",
    purpose: "to remind you that the estate service charge of {amount} for {period} is due by {when}",
    opening: null,
    outcomes: ["will pay", "already paid", "disputes the charge", "wants a breakdown"],
    facts: [
      { key: "amount", example: "eighty-five thousand naira" },
      { key: "period", example: "the first quarter" },
      { key: "when", example: "the end of the month" },
    ],
    voicemail: "hang_up",
    maxAttempts: 3,
    retryAfterMinutes: 1440,
    callingWindow: HOME_HOURS,
    conversation: {
      fields: [
        field("intent", "choice", "Will you be able to settle it by then?", {
          options: ["yes", "already paid", "I dispute it", "I'd like a breakdown first"],
          required: true,
        }),
      ],
      branch: {
        on: "intent",
        arms: {
          yes: { fields: [], closing: "Thank them and say goodbye." },
          "already paid": { fields: [], closing: "Apologise, say the estate office will match the payment, and say goodbye." },
          "I dispute it": { fields: [], handover: "A disputed charge, for the estate manager." },
          "I'd like a breakdown first": { fields: [], closing: "Say the breakdown will be sent by message and say goodbye." },
        },
      },
    },
    rationale:
      "An amount owed never goes on a voicemail. Disputes go to the estate manager because an agent cannot explain a charge it did not set. Once a day, three days.",
  },
  {
    id: "open-house",
    name: "Open house invitation",
    sector: "Property",
    summary: "Invite registered buyers to a viewing day for a new development.",
    purpose: "to invite you to the open day at {development} on {when}, since you registered interest in it",
    opening: null,
    outcomes: ["attending", "not attending", "wants a private viewing", "no longer looking"],
    facts: [
      { key: "development", example: "Lekki Gardens Phase 3" },
      { key: "when", example: "Saturday from 10am" },
    ],
    voicemail: "leave_message",
    maxAttempts: 2,
    retryAfterMinutes: 2880,
    callingWindow: HOME_HOURS,
    conversation: {
      fields: [
        field("rsvp", "choice", "Will you be able to come along?", {
          options: ["yes", "no", "I'd prefer a private viewing", "I'm no longer looking"],
          required: true,
        }),
      ],
      branch: {
        on: "rsvp",
        arms: {
          yes: { fields: [], closing: "Say they are on the list and directions will be sent, and say goodbye." },
          no: { fields: [], closing: "Thank them and say goodbye." },
          "I'd prefer a private viewing": {
            fields: [field("preferredDay", "text", "What day would suit you?", { required: true })],
            closing: "Say an agent will call to confirm and say goodbye.",
          },
          "I'm no longer looking": { fields: [], closing: "Thank them, say they will be taken off the list, and say goodbye." },
        },
      },
    },
    rationale:
      "They registered interest, which is the consent basis, and the record says so on every row. Two tries two days apart — an invitation chased harder than that is a sales call. 'No longer looking' is a verdict so the list cleans itself.",
  },

  // ------------------------------------------------------------------ Healthcare
  {
    id: "medication-refill",
    name: "Repeat prescription due",
    sector: "Healthcare",
    summary: "A repeat is running out; ask whether to prepare it for collection.",
    purpose: "because your repeat prescription is due and to check whether you would like it prepared for collection",
    opening: null,
    outcomes: ["prepare it", "not needed yet", "stopped taking it", "needs a review"],
    facts: [],
    voicemail: "hang_up",
    maxAttempts: 3,
    retryAfterMinutes: 1440,
    callingWindow: HOME_HOURS,
    conversation: {
      fields: [
        field("want", "choice", "Would you like us to prepare it?", {
          options: ["yes", "not yet", "I've stopped taking it", "I'd like to speak to the pharmacist"],
          required: true,
        }),
      ],
      branch: {
        on: "want",
        arms: {
          yes: { fields: [], closing: "Say it will be ready in two working days and say goodbye." },
          "not yet": { fields: [], closing: "Say to ring when it is needed and say goodbye." },
          "I've stopped taking it": { fields: [], handover: "A patient has stopped a medication; the pharmacist should hear why." },
          "I'd like to speak to the pharmacist": { fields: [], handover: "They asked for the pharmacist." },
        },
      },
    },
    rationale:
      "The purpose never names the medicine — that is between the patient and the pharmacy, and a voicemail naming a drug tells a household something. Stopping a medication is a clinical fact and goes to the pharmacist at once.",
  },
  {
    id: "post-discharge",
    name: "After discharge check-in",
    sector: "Healthcare",
    summary: "Two days after leaving hospital, check how they are and whether they need anything.",
    purpose: "to check how you are getting on since you came home from {facility}",
    opening: null,
    outcomes: ["doing well", "has concerns", "needs urgent attention", "wants a follow-up"],
    facts: [{ key: "facility", example: "the hospital" }],
    voicemail: "hang_up",
    maxAttempts: 3,
    retryAfterMinutes: 240,
    callingWindow: HOME_HOURS,
    conversation: {
      fields: [
        field("howAreYou", "choice", "How are you feeling since you got home?", {
          options: ["well", "I have some concerns", "I feel worse", "I'd like a follow-up appointment"],
          required: true,
        }),
      ],
      branch: {
        on: "howAreYou",
        arms: {
          well: { fields: [], closing: "Say that is good to hear, remind them of the number to ring if anything changes, and say goodbye." },
          "I have some concerns": { fields: [], handover: "A recovering patient has concerns; a nurse should hear them." },
          "I feel worse": { fields: [], handover: "A recovering patient feels worse. A clinician needs this call now." },
          "I'd like a follow-up appointment": {
            fields: [field("preferredDay", "text", "What day would suit you?", { required: true })],
            closing: "Say the clinic will confirm a time and say goodbye.",
          },
        },
      },
    },
    rationale:
      "Anything other than 'well' goes to a person, immediately, because an agent must never triage. Four hours between tries: a patient who does not answer may be resting, and a check-in that becomes a pursuit is its own harm.",
  },
  {
    id: "screening-invite",
    name: "Screening invitation",
    sector: "Healthcare",
    summary: "Invite patients in an eligible group to a screening and book a slot.",
    purpose: "to invite you for a {screening} screening, which is offered to everyone in your age group",
    opening: null,
    outcomes: ["booked", "declined", "already screened elsewhere", "wants information"],
    facts: [{ key: "screening", example: "blood pressure and diabetes" }],
    voicemail: "leave_message",
    maxAttempts: 2,
    retryAfterMinutes: 2880,
    callingWindow: HOME_HOURS,
    conversation: {
      fields: [
        field("interest", "choice", "Would you like to book a time?", {
          options: ["yes", "no thank you", "I've had it done elsewhere", "I'd like to know more"],
          required: true,
        }),
      ],
      branch: {
        on: "interest",
        arms: {
          yes: {
            fields: [field("slot", "choice", "Morning or afternoon?", { options: ["morning", "afternoon"], required: true })],
            closing: "Say a time will be confirmed by message and say goodbye.",
          },
          "no thank you": { fields: [], closing: "Say the offer stands whenever they like and say goodbye." },
          "I've had it done elsewhere": { fields: [], closing: "Say that is noted and say goodbye." },
          "I'd like to know more": { fields: [], handover: "They want to know what the screening involves, which a nurse should explain." },
        },
      },
    },
    rationale:
      "A voicemail is acceptable because the purpose says only that a screening is offered to an age group — nothing about the person's health. Questions about what it involves go to a nurse, not an agent.",
  },
  {
    id: "immunisation-due",
    name: "Child immunisation due",
    sector: "Healthcare",
    summary: "A child's next vaccine is due; book the visit with the parent.",
    purpose: "because {child}'s next immunisation is due and to book a time for it",
    opening: null,
    outcomes: ["booked", "already done", "declined", "wants to speak to a nurse"],
    facts: [{ key: "child", example: "Amara" }],
    voicemail: "hang_up",
    maxAttempts: 3,
    retryAfterMinutes: 1440,
    callingWindow: HOME_HOURS,
    conversation: {
      fields: [
        field("book", "choice", "Would you like to book it now?", {
          options: ["yes", "it's already been done", "not at the moment", "I'd like to speak to a nurse"],
          required: true,
        }),
      ],
      branch: {
        on: "book",
        arms: {
          yes: {
            fields: [field("preferredDay", "text", "What day would suit you?", { required: true })],
            closing: "Say the clinic will confirm the time and say goodbye.",
          },
          "it's already been done": { fields: [], closing: "Say the record will be updated and say goodbye." },
          "not at the moment": { fields: [], closing: "Say the offer stands and say goodbye. Do not press." },
          "I'd like to speak to a nurse": { fields: [], handover: "A parent with questions about a vaccine, for a nurse." },
        },
      },
    },
    rationale:
      "A child's medical record is not something to leave on a machine. A parent who declines is not argued with — that conversation belongs to a nurse, if it happens at all, and never to an agent.",
  },
  {
    id: "dental-recall",
    name: "Dental check-up recall",
    sector: "Healthcare",
    summary: "Six months since the last check-up; invite them back.",
    purpose: "because it has been six months since your last check-up and to book your next one",
    opening: null,
    outcomes: ["booked", "will call back", "moved practice", "declined"],
    facts: [],
    voicemail: "leave_message",
    maxAttempts: 2,
    retryAfterMinutes: 4320,
    callingWindow: HOME_HOURS,
    conversation: confirmOrMove("check-up"),
    rationale:
      "Three days between tries; a recall is the least urgent call a practice makes. A voicemail is fine here — 'time for your check-up' is not a diagnosis, and it lets them ring back at leisure.",
  },

  // ------------------------------------------------------------------ Education
  {
    id: "parent-teacher",
    name: "Parent–teacher meeting",
    sector: "Education",
    summary: "Book parents into a slot for the termly meeting.",
    purpose: "to book you a time to meet {student}'s class teacher on {when}",
    opening: null,
    outcomes: ["booked", "cannot attend", "wants a call instead"],
    facts: [
      { key: "student", example: "Ngozi" },
      { key: "when", example: "Thursday the 20th" },
    ],
    voicemail: "leave_message",
    maxAttempts: 2,
    retryAfterMinutes: 1440,
    callingWindow: EVENING,
    conversation: {
      fields: [
        field("slot", "choice", "Would the afternoon or the evening suit you better?", {
          options: ["afternoon", "evening", "I can't attend", "could the teacher call me instead?"],
          required: true,
        }),
      ],
      branch: {
        on: "slot",
        arms: {
          afternoon: { fields: [], closing: "Say the exact time will be sent by message and say goodbye." },
          evening: { fields: [], closing: "Say the exact time will be sent by message and say goodbye." },
          "I can't attend": { fields: [], closing: "Say the teacher will send a written note instead and say goodbye." },
          "could the teacher call me instead?": { fields: [], closing: "Say that will be passed on and say goodbye." },
        },
      },
    },
    rationale:
      "Evenings, because parents are at work in the day. A voicemail is fine — a meeting date is public to every family — and two tries is enough for something a letter will also carry.",
  },
  {
    id: "exam-results",
    name: "Results collection",
    sector: "Education",
    summary: "Results are ready; tell parents when and where to collect them.",
    purpose: "to let you know that {student}'s results are ready for collection from {when}",
    opening: null,
    outcomes: ["will collect", "wants them posted", "has a question"],
    facts: [
      { key: "student", example: "Tobi" },
      { key: "when", example: "Monday" },
    ],
    voicemail: "hang_up",
    maxAttempts: 2,
    retryAfterMinutes: 1440,
    callingWindow: HOME_HOURS,
    conversation: {
      fields: [
        field("how", "choice", "Will you collect them, or would you prefer them sent?", {
          options: ["I'll collect them", "please send them", "I have a question"],
          required: true,
        }),
      ],
      branch: {
        on: "how",
        arms: {
          "I'll collect them": { fields: [], closing: "Say the office hours and say goodbye." },
          "please send them": { fields: [], closing: "Say they will be sent to the address on file and say goodbye." },
          "I have a question": { fields: [], handover: "A question about results, for the school office." },
        },
      },
    },
    rationale:
      "The purpose says results are ready and never what they are — the agent must never be in a position to. No voicemail: which child's results are in is not for the household to overhear.",
  },
  {
    id: "enrolment-followup",
    name: "Enrolment follow-up",
    sector: "Education",
    summary: "An application was started and not finished. Find out what is missing.",
    purpose: "because your application for {student} to join us has not been completed, in case something is in the way",
    opening: null,
    outcomes: ["will complete it", "missing a document", "changed their mind", "needs help"],
    facts: [{ key: "student", example: "your daughter" }],
    voicemail: "hang_up",
    maxAttempts: 2,
    retryAfterMinutes: 2880,
    callingWindow: HOME_HOURS,
    conversation: {
      fields: [
        field("status", "choice", "Is there anything holding it up?", {
          options: ["I'll finish it", "I'm missing a document", "we've decided against it", "I need help with the form"],
          required: true,
        }),
      ],
      branch: {
        on: "status",
        arms: {
          "I'll finish it": { fields: [], closing: "Say the deadline and say goodbye." },
          "I'm missing a document": {
            fields: [field("which", "text", "Which one?", { required: true })],
            closing: "Say what can be accepted instead, if anything, and say goodbye.",
          },
          "we've decided against it": { fields: [], closing: "Thank them and say goodbye. Do not persuade." },
          "I need help with the form": { fields: [], handover: "They need help completing the application, for the admissions office." },
        },
      },
    },
    rationale:
      "Two tries two days apart: an unfinished application is often a decision not yet made, and a chase reads as pressure. A family that has decided against it is thanked, not argued with.",
  },
  {
    id: "school-closure",
    name: "Unplanned closure",
    sector: "Education",
    summary: "The school is closed tomorrow; make sure every family knows.",
    purpose: "to let you know the school will be closed on {when} because of {reason}, and reopens on {reopens}",
    opening: null,
    outcomes: ["informed", "has a question"],
    facts: [
      { key: "when", example: "tomorrow" },
      { key: "reason", example: "a water supply problem" },
      { key: "reopens", example: "Thursday" },
    ],
    voicemail: "leave_message",
    maxAttempts: 3,
    retryAfterMinutes: 30,
    callingWindow: { startHour: 8, endHour: 20, weekdays: EVERY_DAY },
    conversation: yesOrWhy("Do you have any questions about that?", "Say goodbye."),
    rationale:
      "The message is the point, so a voicemail counts as informed. Thirty minutes between tries, three tries, the full permitted day — a family that sends a child to a closed school has been failed by this campaign.",
  },

  // ------------------------------------------------------------------ Banking & fintech
  {
    id: "dormant-account",
    name: "Dormant account notice",
    sector: "Banking & fintech",
    summary: "An account has been inactive for a year; tell them before it is classed dormant.",
    purpose: "because your account with us has had no activity for a year and will be classed as dormant on {when} unless it is used",
    opening: null,
    outcomes: ["will use it", "wants it closed", "wants to keep it as is", "did not know they had one"],
    facts: [{ key: "when", example: "the end of next month" }],
    voicemail: "hang_up",
    maxAttempts: 2,
    retryAfterMinutes: 4320,
    callingWindow: HOME_HOURS,
    conversation: {
      fields: [
        field("intent", "choice", "What would you like to do with it?", {
          options: ["I'll use it", "please close it", "leave it as it is", "I didn't know I had one"],
          required: true,
        }),
      ],
      branch: {
        on: "intent",
        arms: {
          "I'll use it": { fields: [], closing: "Say any transaction before the date keeps it active and say goodbye." },
          "please close it": { fields: [], handover: "A closure request, which needs identity checks a person must do." },
          "leave it as it is": { fields: [], closing: "Explain briefly what dormant means for access and say goodbye." },
          "I didn't know I had one": { fields: [], handover: "A customer unaware of an account in their name. A person should verify this properly." },
        },
      },
    },
    rationale:
      "Closing an account needs identity checks, and the outbound rules forbid the agent asking for any — so closure is a handover, always. Somebody who did not know they had an account is a possible fraud signal and goes to a person too.",
  },
  {
    id: "kyc-update",
    name: "Details need updating",
    sector: "Banking & fintech",
    summary: "Regulations require a document refresh; tell them what and where, never collect it.",
    purpose: "because we are required to refresh the {document} we hold for you by {when}",
    opening: null,
    outcomes: ["will visit a branch", "will use the app", "already done", "has a question"],
    facts: [
      { key: "document", example: "proof of address" },
      { key: "when", example: "the end of the quarter" },
    ],
    voicemail: "hang_up",
    maxAttempts: 3,
    retryAfterMinutes: 4320,
    callingWindow: HOME_HOURS,
    conversation: {
      fields: [
        field("how", "choice", "Would you prefer to do that in a branch or in the app?", {
          options: ["a branch", "the app", "I've already done it", "I have a question"],
          required: true,
        }),
      ],
      branch: {
        on: "how",
        arms: {
          "a branch": { fields: [], closing: "Say any branch can do it and what to bring, and say goodbye. Do not ask for any details now." },
          "the app": { fields: [], closing: "Say where in the app it is and say goodbye." },
          "I've already done it": { fields: [], closing: "Apologise and say goodbye." },
          "I have a question": { fields: [], handover: "A question about the document refresh, for the branch." },
        },
      },
    },
    rationale:
      "This is the campaign a scam most closely resembles, so it is written to take nothing: the agent says what is needed and where, and never asks for a single detail on the call. Three tries with three days between, because it has a deadline and a soft one.",
  },
  {
    id: "savings-maturity",
    name: "Fixed deposit maturing",
    sector: "Banking & fintech",
    summary: "A fixed deposit matures soon; ask whether to roll it over.",
    purpose: "because your fixed deposit matures on {when} and to ask what you would like to do with it",
    opening: null,
    outcomes: ["roll over", "withdraw", "undecided", "wants an adviser"],
    facts: [{ key: "when", example: "the 15th" }],
    voicemail: "hang_up",
    maxAttempts: 3,
    retryAfterMinutes: 1440,
    callingWindow: OFFICE_HOURS,
    conversation: {
      fields: [
        field("intent", "choice", "Would you like it rolled over, or paid out?", {
          options: ["roll it over", "pay it out", "I haven't decided", "I'd like to speak to an adviser"],
          required: true,
        }),
      ],
      branch: {
        on: "intent",
        arms: {
          "roll it over": { fields: [], closing: "Say the confirmation will come by message and say goodbye. Do not quote a rate." },
          "pay it out": { fields: [], handover: "A payout instruction, which needs verification a person must do." },
          "I haven't decided": { fields: [], closing: "Say what happens by default at maturity and say goodbye." },
          "I'd like to speak to an adviser": { fields: [], handover: "They asked for an adviser." },
        },
      },
    },
    rationale:
      "Never a rate, never an amount, never on a voicemail. A payout is an instruction that moves money and is verified by a person; an agent records the wish and hands over. Office hours, so the adviser is at a desk.",
  },
  {
    id: "suspicious-activity",
    name: "Unusual activity check",
    sector: "Banking & fintech",
    summary: "Something unusual happened on the account. Ask only whether it was them — nothing else.",
    purpose: "because of some unusual activity on your account, to check it was you — we will not ask you for any details",
    opening:
      "Good day, this is {organisation}'s fraud team. Am I speaking with {name}? We have noticed some activity on your account we want to check with you. We will not ask you for any card number, PIN or code on this call.",
    outcomes: ["was them", "was not them", "unsure"],
    facts: [],
    voicemail: "hang_up",
    maxAttempts: 4,
    retryAfterMinutes: 60,
    callingWindow: { startHour: 8, endHour: 20, weekdays: EVERY_DAY },
    conversation: {
      fields: [
        field("recognised", "choice", "Does that activity sound like something you did?", {
          options: ["yes, that was me", "no, that wasn't me", "I'm not sure"],
          required: true,
        }),
      ],
      branch: {
        on: "recognised",
        arms: {
          "yes, that was me": { fields: [], closing: "Thank them, say nothing further is needed, and say goodbye." },
          "no, that wasn't me": { fields: [], handover: "Possible fraud. A person must take this call now and secure the account." },
          "I'm not sure": { fields: [], handover: "Uncertain about activity on their account; the fraud team should walk through it." },
        },
      },
    },
    rationale:
      "The most dangerous template in the catalogue, because it is exactly what a scam call sounds like — which is why the opening says out loud that no details will be asked for, and the conversation is built so none ever are. Anything but a clear 'that was me' goes to a person at once. Hourly retries across the whole permitted day, because the account may be draining.",
  },

  // ------------------------------------------------------------------ Insurance
  {
    id: "premium-due",
    name: "Premium due",
    sector: "Insurance",
    summary: "A premium is due; remind them and learn whether the cover should continue.",
    purpose: "to remind you that the premium of {amount} on your {policy} policy is due on {when}",
    opening: null,
    outcomes: ["will pay", "already paid", "wants to cancel", "disputes"],
    facts: [
      { key: "amount", example: "twelve thousand naira" },
      { key: "policy", example: "health" },
      { key: "when", example: "Friday" },
    ],
    voicemail: "hang_up",
    maxAttempts: 3,
    retryAfterMinutes: 1440,
    callingWindow: HOME_HOURS,
    conversation: {
      fields: [
        field("intent", "choice", "Will you be able to make that payment?", {
          options: ["yes", "already paid", "I want to cancel the policy", "I want to query it"],
          required: true,
        }),
      ],
      branch: {
        on: "intent",
        arms: {
          yes: { fields: [], closing: "Thank them and say goodbye." },
          "already paid": { fields: [], closing: "Apologise, say the account will be checked, and say goodbye." },
          "I want to cancel the policy": { fields: [], handover: "A cancellation, which an adviser must handle so they understand what cover ends." },
          "I want to query it": { fields: [], handover: "A query about the premium, for an adviser." },
        },
      },
    },
    rationale:
      "A cancellation is handed over rather than taken, because somebody should understand what cover ends before it does. An amount owed is never left on a machine.",
  },
  {
    id: "claim-documents",
    name: "Documents needed for a claim",
    sector: "Insurance",
    summary: "A claim is stalled on paperwork; say exactly what is missing.",
    purpose: "because your claim {reference} is waiting on {document} before it can move forward",
    opening: null,
    outcomes: ["will send it", "already sent", "cannot provide it", "has a question"],
    facts: [
      { key: "reference", example: "CLM-20481" },
      { key: "document", example: "the police report" },
    ],
    voicemail: "hang_up",
    maxAttempts: 3,
    retryAfterMinutes: 2880,
    callingWindow: OFFICE_HOURS,
    conversation: {
      fields: [
        field("status", "choice", "Will you be able to send that?", {
          options: ["yes", "I already sent it", "I can't get it", "I have a question"],
          required: true,
        }),
      ],
      branch: {
        on: "status",
        arms: {
          yes: { fields: [], closing: "Say where to send it and say goodbye." },
          "I already sent it": {
            fields: [field("sentWhen", "date", "When did you send it?", { required: false })],
            closing: "Apologise, say the handler will look for it, and say goodbye.",
          },
          "I can't get it": { fields: [], handover: "A claimant cannot provide a required document; the handler should discuss alternatives." },
          "I have a question": { fields: [], handover: "A question about the claim, for the handler." },
        },
      },
    },
    rationale:
      "Office hours, because a claim that cannot produce a document needs a handler to discuss alternatives, and there has to be one at a desk. Nothing about a claim goes on a voicemail.",
  },
  {
    id: "motor-renewal-inspection",
    name: "Vehicle inspection for renewal",
    sector: "Insurance",
    summary: "A motor policy renewal needs an inspection; book it.",
    purpose: "because your motor policy renewal needs a vehicle inspection before {when}, and to book one",
    opening: null,
    outcomes: ["booked", "will come to a centre", "vehicle sold", "wants to discuss"],
    facts: [{ key: "when", example: "the 28th" }],
    voicemail: "leave_message",
    maxAttempts: 3,
    retryAfterMinutes: 2880,
    callingWindow: HOME_HOURS,
    conversation: {
      fields: [
        field("how", "choice", "Would you like an inspector to come to you, or to bring the car in?", {
          options: ["come to me", "I'll bring it in", "I've sold the vehicle", "I'd like to discuss it"],
          required: true,
        }),
      ],
      branch: {
        on: "how",
        arms: {
          "come to me": {
            fields: [field("preferredDay", "text", "What day would suit?", { required: true })],
            closing: "Say the inspector's visit will be confirmed by message and say goodbye.",
          },
          "I'll bring it in": { fields: [], closing: "Say the centre's hours and say goodbye." },
          "I've sold the vehicle": { fields: [], handover: "A sold vehicle changes the policy; an adviser needs to handle that." },
          "I'd like to discuss it": { fields: [], handover: "They want to discuss the renewal." },
        },
      },
    },
    rationale:
      "A voicemail is fine — an inspection date is not private. A sold vehicle is a change of risk and goes to an adviser rather than being noted and forgotten.",
  },

  // ------------------------------------------------------------------ Retail & e-commerce
  {
    id: "back-in-stock",
    name: "Back in stock",
    sector: "Retail & e-commerce",
    summary: "Something they asked about is available again; ask whether to hold one.",
    purpose: "because the {item} you asked about is back in stock, and to ask whether you would like one held for you",
    opening: null,
    outcomes: ["hold one", "will order online", "no longer wants it"],
    facts: [{ key: "item", example: "Samsung A54 in black" }],
    voicemail: "leave_message",
    maxAttempts: 2,
    retryAfterMinutes: 1440,
    callingWindow: HOME_HOURS,
    conversation: {
      fields: [
        field("want", "choice", "Would you like one held for you?", {
          options: ["yes, hold one", "I'll order online", "I no longer need it"],
          required: true,
        }),
      ],
      branch: {
        on: "want",
        arms: {
          "yes, hold one": { fields: [], closing: "Say it will be held for three days and where to collect it, and say goodbye." },
          "I'll order online": { fields: [], closing: "Thank them and say goodbye." },
          "I no longer need it": { fields: [], closing: "Thank them and say goodbye. Do not offer an alternative." },
        },
      },
    },
    rationale:
      "They asked to be told, which is the consent basis. Two tries at most; stock that sells out again is not their problem to be chased about. No alternatives are offered — that turns a courtesy into a sales call.",
  },
  {
    id: "warranty-expiry",
    name: "Warranty ending",
    sector: "Retail & e-commerce",
    summary: "A product's warranty ends next month; tell them and offer nothing else.",
    purpose: "to let you know the warranty on your {item} ends on {when}, in case you want anything checked before then",
    opening: null,
    outcomes: ["informed", "wants a check", "has a fault"],
    facts: [
      { key: "item", example: "washing machine" },
      { key: "when", example: "the 10th of next month" },
    ],
    voicemail: "leave_message",
    maxAttempts: 2,
    retryAfterMinutes: 2880,
    callingWindow: HOME_HOURS,
    conversation: {
      fields: [
        field("need", "choice", "Is there anything you would like looked at before it ends?", {
          options: ["no, it's fine", "yes, I'd like it checked", "it has a fault"],
          required: true,
        }),
      ],
      branch: {
        on: "need",
        arms: {
          "no, it's fine": { fields: [], closing: "Say goodbye." },
          "yes, I'd like it checked": {
            fields: [field("preferredDay", "text", "What day would suit for a visit?", { required: true })],
            closing: "Say the visit will be confirmed and say goodbye.",
          },
          "it has a fault": {
            fields: [field("fault", "text", "What is wrong with it?", { required: true })],
            closing: "Say a repair will be arranged under the warranty and say goodbye.",
          },
        },
      },
    },
    rationale:
      "Deliberately no extended-warranty offer. The call informs and takes a fault; the moment it sells, it becomes the call people resent. Two tries two days apart.",
  },
  {
    id: "return-collection",
    name: "Return collection",
    sector: "Retail & e-commerce",
    summary: "A return is approved; arrange when the courier collects it.",
    purpose: "to arrange collection of the {item} you are returning",
    opening: null,
    outcomes: ["collection booked", "will drop it off", "changed their mind"],
    facts: [{ key: "item", example: "pair of shoes" }],
    voicemail: "leave_message",
    maxAttempts: 3,
    retryAfterMinutes: 480,
    callingWindow: HOME_HOURS,
    conversation: {
      fields: [
        field("how", "choice", "Would you like it collected, or will you drop it off?", {
          options: ["collect it", "I'll drop it off", "I've decided to keep it"],
          required: true,
        }),
      ],
      branch: {
        on: "how",
        arms: {
          "collect it": {
            fields: [
              field("preferredDay", "date", "What day suits?", { required: true }),
              field("address", "address", "And the address to collect from?", { required: true, confirm: "readback" }),
            ],
            closing: "Read the address back, say the courier's window will be sent by message, and say goodbye.",
          },
          "I'll drop it off": { fields: [], closing: "Say where and the hours, and say goodbye." },
          "I've decided to keep it": { fields: [], closing: "Say the return will be cancelled and say goodbye." },
        },
      },
    },
    rationale:
      "The address is read back before it is accepted; a wrong digit is a courier at the wrong door. Eight hours between tries so it resolves within a day or two without ringing three times in a morning.",
  },
  {
    id: "loyalty-expiry",
    name: "Points about to expire",
    sector: "Retail & e-commerce",
    summary: "Loyalty points expire at month end; tell them, once.",
    purpose: "to let you know that {points} loyalty points on your account expire on {when}",
    opening: null,
    outcomes: ["informed", "will use them", "wants them extended"],
    facts: [
      { key: "points", example: "four thousand two hundred" },
      { key: "when", example: "the 31st" },
    ],
    voicemail: "leave_message",
    maxAttempts: 1,
    retryAfterMinutes: 60,
    callingWindow: HOME_HOURS,
    conversation: yesOrWhy("Is there anything you'd like to ask about that?", "Say goodbye."),
    rationale:
      "One try. This is the least important call a shop makes, and a second attempt about points is exactly the kind of thing that gets a number blocked. A voicemail is the whole message.",
  },

  // ------------------------------------------------------------------ Hospitality & food
  {
    id: "reservation-confirmation",
    name: "Table reservation confirmation",
    sector: "Hospitality & food",
    summary: "The day before, confirm the booking and free the table if not.",
    purpose: "to confirm your reservation for {party} at {when}",
    opening: null,
    outcomes: ["confirmed", "changed", "cancelled"],
    facts: [
      { key: "party", example: "four" },
      { key: "when", example: "tomorrow at 8pm" },
    ],
    voicemail: "leave_message",
    maxAttempts: 2,
    retryAfterMinutes: 180,
    callingWindow: { startHour: 11, endHour: 20, weekdays: EVERY_DAY },
    conversation: confirmOrMove("reservation"),
    rationale:
      "Two tries three hours apart, both on the day before: a table not confirmed by tonight is a table that can be given away, and one confirmed tomorrow morning is not. A voicemail is fine — a dinner booking is not private.",
  },
  {
    id: "hotel-arrival",
    name: "Arrival check",
    sector: "Hospitality & food",
    summary: "Two days out, confirm the arrival time and note any requests.",
    purpose: "ahead of your stay with us from {when}, to check your arrival time and whether there is anything you need",
    opening: null,
    outcomes: ["confirmed", "changed dates", "has a request", "cancelled"],
    facts: [{ key: "when", example: "Friday the 12th" }],
    voicemail: "leave_message",
    maxAttempts: 2,
    retryAfterMinutes: 1440,
    callingWindow: HOME_HOURS,
    conversation: {
      fields: [
        field("arrival", "choice", "Roughly when do you expect to arrive?", {
          options: ["morning", "afternoon", "evening", "I need to change the booking"],
          required: true,
        }),
        field("request", "text", "Is there anything we can arrange for you?", { required: false }),
      ],
      branch: {
        on: "arrival",
        arms: {
          morning: { fields: [], closing: "Say early check-in will be tried and say goodbye." },
          afternoon: { fields: [], closing: "Say the room will be ready and say goodbye." },
          evening: { fields: [], closing: "Say reception is open late and say goodbye." },
          "I need to change the booking": { fields: [], handover: "A booking change, for reservations." },
        },
      },
    },
    rationale:
      "A guest with a request has told you how to make the stay good; it is captured before the fork so every arm hears it. Booking changes go to a person because rates and availability are not the agent's to promise.",
  },
  {
    id: "event-catering",
    name: "Catering order confirmation",
    sector: "Hospitality & food",
    summary: "Confirm headcount and dietary needs two days before a catered event.",
    purpose: "to confirm the details of your catering order for {when}",
    opening: null,
    outcomes: ["confirmed", "headcount changed", "menu changed", "cancelled"],
    facts: [{ key: "when", example: "Saturday" }],
    voicemail: "hang_up",
    maxAttempts: 3,
    retryAfterMinutes: 240,
    callingWindow: OFFICE_HOURS,
    conversation: {
      fields: [
        field("headcount", "quantity", "How many people should we cater for?", { required: true }),
        field("dietary", "text", "Any dietary requirements we should know about?", { required: false }),
        field("ok", "choice", "Is everything else on the order still right?", {
          options: ["yes", "I need to change the menu", "I need to cancel"],
          required: true,
        }),
      ],
      branch: {
        on: "ok",
        arms: {
          yes: { fields: [], closing: "Read the headcount back, confirm the delivery time, and say goodbye." },
          "I need to change the menu": { fields: [], handover: "A menu change two days out, for the kitchen to agree." },
          "I need to cancel": { fields: [], handover: "A cancellation, which has cost implications a person should explain." },
        },
      },
    },
    rationale:
      "Headcount and dietary needs are asked before the fork because every outcome needs them. A cancellation this close has costs, and a person should be the one to explain them.",
  },

  // ------------------------------------------------------------------ Logistics & delivery
  {
    id: "failed-delivery",
    name: "We missed you",
    sector: "Logistics & delivery",
    summary: "A delivery could not be made; arrange the next attempt.",
    purpose: "because we tried to deliver your parcel today and nobody was available, to arrange another time",
    opening: null,
    outcomes: ["redelivery booked", "will collect", "changed address", "refused"],
    facts: [],
    voicemail: "leave_message",
    maxAttempts: 3,
    retryAfterMinutes: 120,
    callingWindow: HOME_HOURS,
    conversation: {
      fields: [
        field("how", "choice", "Would you like us to try again, or would you rather collect it?", {
          options: ["try again", "I'll collect it", "the address is wrong", "I don't want it"],
          required: true,
        }),
      ],
      branch: {
        on: "how",
        arms: {
          "try again": {
            fields: [field("preferredDay", "date", "What day suits?", { required: true })],
            closing: "Say the window will be sent by message and say goodbye.",
          },
          "I'll collect it": { fields: [], closing: "Say where it is held and the hours, and say goodbye." },
          "the address is wrong": {
            fields: [field("newAddress", "address", "What should the address be?", { required: true, confirm: "readback" })],
            closing: "Read it back, say it has been updated, and say goodbye.",
          },
          "I don't want it": { fields: [], handover: "A refused parcel, which needs the sender told." },
        },
      },
    },
    rationale:
      "Two hours between tries because the parcel is on a van and the next attempt has to be planned today. An address is read back before it is accepted. A refusal goes to a person so the sender is told rather than the parcel silently returned.",
  },
  {
    id: "driver-shift",
    name: "Shift confirmation",
    sector: "Logistics & delivery",
    summary: "Confirm tomorrow's shift with each driver the evening before.",
    purpose: "to confirm you are on shift tomorrow from {when}",
    opening: null,
    outcomes: ["confirmed", "cannot make it", "wants a different shift"],
    facts: [{ key: "when", example: "6am" }],
    voicemail: "leave_message",
    maxAttempts: 3,
    retryAfterMinutes: 60,
    callingWindow: EVENING,
    conversation: {
      fields: [
        field("on", "choice", "Are you able to make that shift?", {
          options: ["yes", "no", "I'd like to swap it"],
          required: true,
        }),
      ],
      branch: {
        on: "on",
        arms: {
          yes: { fields: [], closing: "Say the depot and say goodbye." },
          no: {
            fields: [field("reason", "text", "May I ask why, so the rota can be covered?", { required: false })],
            closing: "Say the dispatcher will cover it and say goodbye.",
          },
          "I'd like to swap it": { fields: [], handover: "A shift swap, for the dispatcher." },
        },
      },
    },
    rationale:
      "Evenings only and an hour between tries: the rota is being finalised tonight and a driver who cannot be reached is a route unassigned. A voicemail is fine — a shift time is not private.",
  },
  {
    id: "pickup-ready",
    name: "Ready for collection",
    sector: "Logistics & delivery",
    summary: "A parcel is at the pickup point; tell them and say how long it is held.",
    purpose: "to let you know your parcel is ready to collect from {location} and will be held until {when}",
    opening: null,
    outcomes: ["will collect", "wants it delivered", "not theirs"],
    facts: [
      { key: "location", example: "the Yaba pickup point" },
      { key: "when", example: "Friday" },
    ],
    voicemail: "leave_message",
    maxAttempts: 2,
    retryAfterMinutes: 1440,
    callingWindow: HOME_HOURS,
    conversation: {
      fields: [
        field("plan", "choice", "Will you be able to collect it by then?", {
          options: ["yes", "could it be delivered instead?", "I'm not expecting a parcel"],
          required: true,
        }),
      ],
      branch: {
        on: "plan",
        arms: {
          yes: { fields: [], closing: "Say the hours and what to bring, and say goodbye." },
          "could it be delivered instead?": {
            fields: [field("address", "address", "What address should it go to?", { required: true, confirm: "readback" })],
            closing: "Read it back, say delivery will be arranged, and say goodbye.",
          },
          "I'm not expecting a parcel": { fields: [], handover: "A parcel addressed to somebody not expecting one; a person should check it." },
        },
      },
    },
    rationale:
      "A voicemail is the notice. Somebody not expecting a parcel is either a wrong number or something worth a person's look, and the agent does not guess which.",
  },

  // ------------------------------------------------------------------ Telecoms & internet
  {
    id: "service-restoration",
    name: "Service restored",
    sector: "Telecoms & internet",
    summary: "After an outage, tell affected customers it is fixed and check they are back.",
    purpose: "to let you know the fault affecting your {service} has been fixed, and to check that you are back up",
    opening: null,
    outcomes: ["working", "still down", "intermittent"],
    facts: [{ key: "service", example: "broadband" }],
    voicemail: "leave_message",
    maxAttempts: 2,
    retryAfterMinutes: 360,
    callingWindow: HOME_HOURS,
    conversation: {
      fields: [
        field("status", "choice", "Is everything working for you now?", {
          options: ["yes", "no, still down", "it comes and goes"],
          required: true,
        }),
      ],
      branch: {
        on: "status",
        arms: {
          yes: { fields: [], closing: "Apologise for the disruption and say goodbye." },
          "no, still down": { fields: [], handover: "A customer still without service after a fix was declared; support needs this." },
          "it comes and goes": { fields: [], handover: "An intermittent fault after a fix; support should look again." },
        },
      },
    },
    rationale:
      "The purpose is good news, so a voicemail counts. Anyone not back up goes to support at once — the whole point of the call is finding them.",
  },
  {
    id: "data-plan-expiry",
    name: "Plan about to expire",
    sector: "Telecoms & internet",
    summary: "A plan ends in three days; ask whether to renew it.",
    purpose: "because your {plan} expires on {when}, and to ask whether you would like it renewed",
    opening: null,
    outcomes: ["renew", "let it lapse", "wants a different plan"],
    facts: [
      { key: "plan", example: "monthly data plan" },
      { key: "when", example: "Thursday" },
    ],
    voicemail: "leave_message",
    maxAttempts: 2,
    retryAfterMinutes: 1440,
    callingWindow: HOME_HOURS,
    conversation: {
      fields: [
        field("intent", "choice", "Would you like it renewed?", {
          options: ["yes", "no, let it end", "I'd like a different plan"],
          required: true,
        }),
      ],
      branch: {
        on: "intent",
        arms: {
          yes: { fields: [], closing: "Say how to renew — the app or a code — and say goodbye. Do not take payment." },
          "no, let it end": { fields: [], closing: "Thank them and say goodbye. Do not persuade." },
          "I'd like a different plan": { fields: [], handover: "They want to change plan, which an adviser should walk through." },
        },
      },
    },
    rationale:
      "The agent never takes a payment — it says how to renew and stops. Somebody letting it lapse is not persuaded. Two tries, because a lapsed plan is theirs to renew whenever they like.",
  },
  {
    id: "sim-swap-check",
    name: "SIM change check",
    sector: "Telecoms & internet",
    summary: "A SIM change was requested. Confirm it was them, asking for nothing.",
    purpose: "because a request was made to move your number to a new SIM, and to check it was you — we will not ask you for any details",
    opening:
      "Good day, this is {organisation}. Am I speaking with {name}? A request was made today to move your number to a new SIM. We are checking it was you. We will not ask you for any PIN or code.",
    outcomes: ["was them", "was not them", "unsure"],
    facts: [],
    voicemail: "hang_up",
    maxAttempts: 4,
    retryAfterMinutes: 30,
    callingWindow: { startHour: 8, endHour: 20, weekdays: EVERY_DAY },
    conversation: {
      fields: [
        field("recognised", "choice", "Did you make that request?", {
          options: ["yes, that was me", "no, I didn't", "I'm not sure"],
          required: true,
        }),
      ],
      branch: {
        on: "recognised",
        arms: {
          "yes, that was me": { fields: [], closing: "Thank them and say goodbye." },
          "no, I didn't": { fields: [], handover: "A SIM swap the customer did not request. Fraud; a person must block it now." },
          "I'm not sure": { fields: [], handover: "Uncertain about a SIM swap on their number; a person should check with them." },
        },
      },
    },
    rationale:
      "A SIM swap is how bank accounts are emptied, so this is urgent and this is dangerous — it is also exactly what a scam sounds like. The opening says no PIN or code will be asked for, the conversation never asks, and anything but a clear yes goes to a person immediately. Half an hour between tries, four tries, the whole day.",
  },

  // ------------------------------------------------------------------ Utilities & energy
  {
    id: "meter-reading",
    name: "Meter reading request",
    sector: "Utilities & energy",
    summary: "Ask for a meter reading so the next bill is actual rather than estimated.",
    purpose: "to ask for a reading from your meter, so your next bill is based on what you have used rather than an estimate",
    opening: null,
    outcomes: ["reading given", "will submit online", "cannot access the meter", "has a prepaid meter"],
    facts: [],
    voicemail: "leave_message",
    maxAttempts: 2,
    retryAfterMinutes: 2880,
    callingWindow: HOME_HOURS,
    conversation: {
      fields: [
        field("can", "choice", "Are you able to read the meter now?", {
          options: ["yes", "I'll submit it online", "I can't get to it", "I have a prepaid meter"],
          required: true,
        }),
      ],
      branch: {
        on: "can",
        arms: {
          yes: {
            fields: [field("reading", "reference", "What are the numbers on the meter?", { required: true, capture: "either", confirm: "readback" })],
            closing: "Read the numbers back, confirm they have been recorded, and say goodbye.",
          },
          "I'll submit it online": { fields: [], closing: "Say where to submit it and say goodbye." },
          "I can't get to it": { fields: [], closing: "Say a reader will be scheduled and say goodbye." },
          "I have a prepaid meter": { fields: [], closing: "Apologise, say the record will be corrected, and say goodbye." },
        },
      },
    },
    rationale:
      "The reading is read back and can be keyed on the phone, because a mis-heard digit is a wrong bill. A prepaid meter is a record error and is corrected rather than argued.",
  },
  {
    id: "bill-overdue",
    name: "Bill overdue",
    sector: "Utilities & energy",
    summary: "A bill is past due; remind them before any action, and learn if there is a problem.",
    purpose: "because your bill of {amount} was due on {when} and has not yet been paid",
    opening: null,
    outcomes: ["will pay", "already paid", "disputes", "cannot pay"],
    facts: [
      { key: "amount", example: "twenty-three thousand naira" },
      { key: "when", example: "the 5th" },
    ],
    voicemail: "hang_up",
    maxAttempts: 3,
    retryAfterMinutes: 1440,
    callingWindow: HOME_HOURS,
    conversation: {
      fields: [
        field("intent", "choice", "Will you be able to settle it?", {
          options: ["yes", "I already paid", "I dispute the amount", "I can't pay right now"],
          required: true,
        }),
      ],
      branch: {
        on: "intent",
        arms: {
          yes: {
            fields: [field("byWhen", "date", "By when, roughly?", { required: false })],
            closing: "Say it has been noted and say goodbye. Do not mention disconnection.",
          },
          "I already paid": { fields: [], closing: "Apologise, say the account will be checked, and say goodbye." },
          "I dispute the amount": { fields: [], handover: "A disputed bill, for the billing team." },
          "I can't pay right now": { fields: [], handover: "A customer who cannot pay; a person should discuss options." },
        },
      },
    },
    rationale:
      "Never a mention of disconnection — the agent reminds and records, and consequences are a person's conversation. An amount owed is never on a voicemail. Someone who cannot pay is handed to a person who can discuss options, not left with a note.",
  },
  {
    id: "smart-meter-install",
    name: "Smart meter installation",
    sector: "Utilities & energy",
    summary: "Book the installation visit for a new meter.",
    purpose: "to book a time for the installation of your new meter",
    opening: null,
    outcomes: ["booked", "declined", "wants information"],
    facts: [],
    voicemail: "leave_message",
    maxAttempts: 3,
    retryAfterMinutes: 2880,
    callingWindow: HOME_HOURS,
    conversation: {
      fields: [
        field("book", "choice", "Would you like to book the visit now?", {
          options: ["yes", "no thank you", "I'd like to know more first"],
          required: true,
        }),
      ],
      branch: {
        on: "book",
        arms: {
          yes: {
            fields: [
              field("preferredDay", "date", "What day suits?", { required: true }),
              field("slot", "choice", "Morning or afternoon?", { options: ["morning", "afternoon"], required: true }),
            ],
            closing: "Say the visit will be confirmed by message and that somebody over eighteen must be in, and say goodbye.",
          },
          "no thank you": { fields: [], closing: "Say the offer stands and say goodbye. Do not press." },
          "I'd like to know more first": { fields: [], handover: "Questions about the meter, for the installation team." },
        },
      },
    },
    rationale:
      "Somebody declining is not pressed. The visit needs an adult present, which is said at booking so the installer is not turned away at the door.",
  },

  // ------------------------------------------------------------------ Travel & transport
  {
    id: "flight-schedule-change",
    name: "Schedule change",
    sector: "Travel & transport",
    summary: "A booked departure has moved; tell them the new time and take their choice.",
    purpose: "because the {service} you are booked on for {when} has moved to {newTime}",
    opening: null,
    outcomes: ["accepts", "wants to rebook", "wants a refund"],
    facts: [
      { key: "service", example: "Lagos to Abuja flight" },
      { key: "when", example: "Friday" },
      { key: "newTime", example: "3:40pm" },
    ],
    voicemail: "leave_message",
    maxAttempts: 4,
    retryAfterMinutes: 120,
    callingWindow: { startHour: 8, endHour: 20, weekdays: EVERY_DAY },
    conversation: {
      fields: [
        field("choice", "choice", "Does the new time work for you?", {
          options: ["yes, that's fine", "I'd like to rebook", "I'd like a refund"],
          required: true,
        }),
      ],
      branch: {
        on: "choice",
        arms: {
          "yes, that's fine": { fields: [], closing: "Say the updated ticket will be sent and say goodbye." },
          "I'd like to rebook": { fields: [], handover: "A rebooking, which needs availability a person must check." },
          "I'd like a refund": { fields: [], handover: "A refund request, which a person must process." },
        },
      },
    },
    rationale:
      "Four tries two hours apart across the whole permitted day, because a passenger who does not know about a change misses the departure. A voicemail is fine — the change is the message. Rebooking and refunds move money and go to a person.",
  },
  {
    id: "pickup-reminder",
    name: "Pickup reminder",
    sector: "Travel & transport",
    summary: "The evening before, confirm the pickup time and address for a booked ride.",
    purpose: "to confirm your pickup at {when} from {address}",
    opening: null,
    outcomes: ["confirmed", "changed", "cancelled"],
    facts: [
      { key: "when", example: "5:30 tomorrow morning" },
      { key: "address", example: "12 Bourdillon Road" },
    ],
    voicemail: "leave_message",
    maxAttempts: 3,
    retryAfterMinutes: 90,
    callingWindow: EVENING,
    conversation: confirmOrMove("pickup"),
    rationale:
      "Evenings, ninety minutes apart: a pickup at dawn has to be confirmed tonight. A voicemail is fine and the callback number is enough to change it.",
  },
  {
    id: "tour-briefing",
    name: "Tour briefing",
    sector: "Travel & transport",
    summary: "Two days before a tour, confirm attendance and what to bring.",
    purpose: "ahead of the {tour} on {when}, to confirm you are coming and to tell you what to bring",
    opening: null,
    outcomes: ["confirmed", "cancelled", "has a question"],
    facts: [
      { key: "tour", example: "Olumo Rock day trip" },
      { key: "when", example: "Saturday" },
    ],
    voicemail: "leave_message",
    maxAttempts: 2,
    retryAfterMinutes: 720,
    callingWindow: HOME_HOURS,
    conversation: {
      fields: [
        field("coming", "choice", "Are you still able to join us?", {
          options: ["yes", "no", "I have a question"],
          required: true,
        }),
      ],
      branch: {
        on: "coming",
        arms: {
          yes: { fields: [], closing: "Say the meeting point, the time, and what to bring, and say goodbye." },
          no: {
            fields: [field("reason", "text", "May I ask why?", { required: false })],
            closing: "Say the cancellation terms will be sent in writing and say goodbye.",
          },
          "I have a question": { fields: [], handover: "A question about the tour, for the operator." },
        },
      },
    },
    rationale:
      "Twelve hours between tries so both attempts land on different halves of the day. Cancellation terms are sent in writing rather than read aloud — an agent should not be quoting refund policy.",
  },

  // ------------------------------------------------------------------ Automotive & energy
  {
    id: "service-due",
    name: "Vehicle service due",
    sector: "Automotive & energy",
    summary: "The car is due a service; book it in.",
    purpose: "because your {vehicle} is due its {service}, and to book it in",
    opening: null,
    outcomes: ["booked", "serviced elsewhere", "sold the car", "will call back"],
    facts: [
      { key: "vehicle", example: "Toyota Corolla" },
      { key: "service", example: "annual service" },
    ],
    voicemail: "leave_message",
    maxAttempts: 2,
    retryAfterMinutes: 4320,
    callingWindow: HOME_HOURS,
    conversation: {
      fields: [
        field("book", "choice", "Would you like to book it in?", {
          options: ["yes", "I had it done elsewhere", "I've sold the car", "I'll call back"],
          required: true,
        }),
      ],
      branch: {
        on: "book",
        arms: {
          yes: {
            fields: [field("preferredDay", "date", "What day suits?", { required: true })],
            closing: "Say the workshop will confirm and say goodbye. Do not quote a price.",
          },
          "I had it done elsewhere": { fields: [], closing: "Say that is noted and say goodbye." },
          "I've sold the car": { fields: [], closing: "Say the record will be updated and say goodbye." },
          "I'll call back": { fields: [], closing: "Give the number and say goodbye." },
        },
      },
    },
    rationale:
      "Three days between tries; a service reminder is not urgent. The agent never quotes a price — a workshop's figure said aloud is a figure somebody will hold them to.",
  },
  {
    id: "recall-notice",
    name: "Safety recall",
    sector: "Automotive & energy",
    summary: "A part on their vehicle is subject to a recall; book the fix.",
    purpose: "because of a safety recall affecting the {part} on your {vehicle}, to book a free repair",
    opening: null,
    outcomes: ["booked", "already done", "no longer owns it", "has a question"],
    facts: [
      { key: "part", example: "airbag inflator" },
      { key: "vehicle", example: "2019 Honda Accord" },
    ],
    voicemail: "leave_message",
    maxAttempts: 4,
    retryAfterMinutes: 1440,
    callingWindow: HOME_HOURS,
    conversation: {
      fields: [
        field("book", "choice", "Would you like to book the repair?", {
          options: ["yes", "it's already been done", "I no longer own the vehicle", "I have a question"],
          required: true,
        }),
      ],
      branch: {
        on: "book",
        arms: {
          yes: {
            fields: [field("preferredDay", "date", "What day suits?", { required: true })],
            closing: "Say the dealer will confirm and that the repair is free, and say goodbye.",
          },
          "it's already been done": { fields: [], closing: "Say the record will be updated and say goodbye." },
          "I no longer own the vehicle": {
            fields: [field("newOwner", "text", "Do you know how we might reach the new owner?", { required: false })],
            closing: "Thank them and say goodbye.",
          },
          "I have a question": { fields: [], handover: "A question about a safety recall, for the service team." },
        },
      },
    },
    rationale:
      "Four tries a day apart, because a safety recall is the one automotive call that must land. The voicemail is fine and says the repair is free, so nobody ignores it thinking it costs. A question about the defect goes to a person.",
  },
  {
    id: "fuel-delivery",
    name: "Fuel delivery scheduled",
    sector: "Automotive & energy",
    summary: "A diesel delivery is booked; confirm access and the time.",
    purpose: "to confirm your fuel delivery on {when}, and to check the site will be accessible",
    opening: null,
    outcomes: ["confirmed", "changed", "access problem"],
    facts: [{ key: "when", example: "Tuesday morning" }],
    voicemail: "leave_message",
    maxAttempts: 3,
    retryAfterMinutes: 240,
    callingWindow: OFFICE_HOURS,
    conversation: {
      fields: [
        field("ok", "choice", "Will the site be accessible then?", {
          options: ["yes", "I need a different time", "there's an access issue"],
          required: true,
        }),
      ],
      branch: {
        on: "ok",
        arms: {
          yes: { fields: [], closing: "Say the driver will call on approach and say goodbye." },
          "I need a different time": {
            fields: [field("preferredDay", "text", "When would suit?", { required: true })],
            closing: "Say dispatch will confirm and say goodbye.",
          },
          "there's an access issue": {
            fields: [field("issue", "text", "What should the driver know?", { required: true })],
            closing: "Say it will be passed to the driver and say goodbye.",
          },
        },
      },
    },
    rationale:
      "Office hours because a site contact is at work. Four hours between tries — a tanker that cannot get in is a wasted trip, and this has to be settled before dispatch.",
  },

  // ------------------------------------------------------------------ Home & personal services
  {
    id: "technician-visit",
    name: "Technician visit confirmation",
    sector: "Home & personal services",
    summary: "The day before a visit, confirm someone will be home.",
    purpose: "to confirm the technician's visit on {when} for your {job}",
    opening: null,
    outcomes: ["confirmed", "rescheduled", "cancelled"],
    facts: [
      { key: "when", example: "tomorrow between 9 and 12" },
      { key: "job", example: "air conditioner service" },
    ],
    voicemail: "leave_message",
    maxAttempts: 3,
    retryAfterMinutes: 120,
    callingWindow: HOME_HOURS,
    conversation: confirmOrMove("visit"),
    rationale:
      "Two hours apart, the day before: a technician who arrives to an empty house is a wasted slot and a wasted journey. A voicemail is fine and the callback number is enough to move it.",
  },
  {
    id: "quote-followup",
    name: "Quote follow-up",
    sector: "Home & personal services",
    summary: "A quote went out a week ago; ask whether they want to go ahead.",
    purpose: "about the quote we sent for {job}, to ask whether you would like to go ahead",
    opening: null,
    outcomes: ["go ahead", "not going ahead", "wants changes", "still deciding"],
    facts: [{ key: "job", example: "repainting the living room" }],
    voicemail: "hang_up",
    maxAttempts: 2,
    retryAfterMinutes: 4320,
    callingWindow: HOME_HOURS,
    conversation: {
      fields: [
        field("decision", "choice", "Have you had a chance to look at it?", {
          options: ["yes, go ahead", "no, not this time", "I'd like some changes", "I'm still deciding"],
          required: true,
        }),
      ],
      branch: {
        on: "decision",
        arms: {
          "yes, go ahead": {
            fields: [field("preferredDay", "text", "When would you like the work to start?", { required: true })],
            closing: "Say a start date will be confirmed and say goodbye.",
          },
          "no, not this time": {
            fields: [field("reason", "text", "May I ask why?", { required: false })],
            closing: "Thank them and say goodbye. Do not offer a discount.",
          },
          "I'd like some changes": { fields: [], handover: "They want the quote revised, which the estimator should do." },
          "I'm still deciding": { fields: [], closing: "Say the quote stands for thirty days and say goodbye." },
        },
      },
    },
    rationale:
      "Two tries three days apart, and no discount is ever offered — a follow-up that haggles is a sales call. Changes go to the estimator; an agent cannot revise a price.",
  },
  {
    id: "cleaner-reschedule",
    name: "Regular visit change",
    sector: "Home & personal services",
    summary: "A regular cleaner or carer cannot make the usual slot; offer an alternative.",
    purpose: "because {worker} cannot make your usual visit on {when}, and to offer another time",
    opening: null,
    outcomes: ["accepted alternative", "skip this week", "wants a different day"],
    facts: [
      { key: "worker", example: "Blessing" },
      { key: "when", example: "Thursday" },
    ],
    voicemail: "leave_message",
    maxAttempts: 3,
    retryAfterMinutes: 180,
    callingWindow: HOME_HOURS,
    conversation: {
      fields: [
        field("plan", "choice", "Would Friday at the same time work, or would you rather skip this week?", {
          options: ["Friday is fine", "skip this week", "another day would be better"],
          required: true,
        }),
      ],
      branch: {
        on: "plan",
        arms: {
          "Friday is fine": { fields: [], closing: "Confirm it and say goodbye." },
          "skip this week": { fields: [], closing: "Say there is no charge and say goodbye." },
          "another day would be better": {
            fields: [field("preferredDay", "text", "Which day?", { required: true })],
            closing: "Say the office will confirm and say goodbye.",
          },
        },
      },
    },
    rationale:
      "Three hours between tries because the gap in the rota is this week. The alternative is offered in the question so a one-word answer settles it.",
  },

  // ------------------------------------------------------------------ Professional services
  {
    id: "document-signing",
    name: "Documents ready to sign",
    sector: "Professional services",
    summary: "Papers are ready; book the signing or send them.",
    purpose: "because the documents for your {matter} are ready, and to arrange signing",
    opening: null,
    outcomes: ["will come in", "send them", "has a question", "needs more time"],
    facts: [{ key: "matter", example: "tenancy agreement" }],
    voicemail: "hang_up",
    maxAttempts: 3,
    retryAfterMinutes: 1440,
    callingWindow: OFFICE_HOURS,
    conversation: {
      fields: [
        field("how", "choice", "Would you like to come in to sign, or have them sent?", {
          options: ["I'll come in", "please send them", "I have a question first", "I need more time"],
          required: true,
        }),
      ],
      branch: {
        on: "how",
        arms: {
          "I'll come in": {
            fields: [field("preferredDay", "text", "What day suits?", { required: true })],
            closing: "Say the office will confirm and say goodbye.",
          },
          "please send them": { fields: [], closing: "Say they will go to the address on file and say goodbye." },
          "I have a question first": { fields: [], handover: "A question about the documents, for the fee earner." },
          "I need more time": { fields: [], closing: "Say there is no rush and to ring when ready, and say goodbye." },
        },
      },
    },
    rationale:
      "Office hours because every question goes to the fee earner. Nothing about a legal matter goes on a voicemail — even the existence of one is private.",
  },
  {
    id: "tax-deadline",
    name: "Filing deadline",
    sector: "Professional services",
    summary: "A filing is due in two weeks; check the client has sent what is needed.",
    purpose: "because your {filing} is due on {when}, and to check we have everything we need from you",
    opening: null,
    outcomes: ["all sent", "will send", "needs help", "wants an extension"],
    facts: [
      { key: "filing", example: "annual return" },
      { key: "when", example: "the 30th" },
    ],
    voicemail: "hang_up",
    maxAttempts: 3,
    retryAfterMinutes: 2880,
    callingWindow: OFFICE_HOURS,
    conversation: {
      fields: [
        field("status", "choice", "Have you sent everything across?", {
          options: ["yes", "I'll send it this week", "I'm not sure what's needed", "I'd like to ask about an extension"],
          required: true,
        }),
      ],
      branch: {
        on: "status",
        arms: {
          yes: { fields: [], closing: "Thank them and say goodbye." },
          "I'll send it this week": { fields: [], closing: "Say the deadline again and say goodbye." },
          "I'm not sure what's needed": { fields: [], handover: "They need the list of what is required, from the accountant." },
          "I'd like to ask about an extension": { fields: [], handover: "An extension is the accountant's call." },
        },
      },
    },
    rationale:
      "Two days between tries and two weeks of lead. Nothing about a client's affairs on a voicemail. Extensions and what-is-needed are the accountant's answers, not the agent's.",
  },
  {
    id: "consultation-followup",
    name: "After the consultation",
    sector: "Professional services",
    summary: "A week after a first meeting, ask whether they want to proceed.",
    purpose: "following your meeting with {adviser}, to ask whether you would like to go ahead",
    opening: null,
    outcomes: ["proceeding", "not proceeding", "still deciding", "wants another meeting"],
    facts: [{ key: "adviser", example: "Mrs Okonkwo" }],
    voicemail: "hang_up",
    maxAttempts: 2,
    retryAfterMinutes: 4320,
    callingWindow: OFFICE_HOURS,
    conversation: {
      fields: [
        field("decision", "choice", "Have you decided how you'd like to proceed?", {
          options: ["yes, let's go ahead", "no, not this time", "I'm still deciding", "I'd like another meeting"],
          required: true,
        }),
      ],
      branch: {
        on: "decision",
        arms: {
          "yes, let's go ahead": { fields: [], closing: "Say the engagement letter will be sent and say goodbye." },
          "no, not this time": {
            fields: [field("reason", "text", "May I ask why?", { required: false })],
            closing: "Thank them and say goodbye. Do not persuade.",
          },
          "I'm still deciding": { fields: [], closing: "Say there is no pressure and say goodbye." },
          "I'd like another meeting": {
            fields: [field("preferredDay", "text", "What day suits?", { required: true })],
            closing: "Say the adviser will confirm and say goodbye.",
          },
        },
      },
    },
    rationale:
      "Two tries three days apart; a professional relationship is not chased. No persuasion on a no. A voicemail would reveal that somebody consulted a firm, which is theirs to reveal.",
  },

  // ------------------------------------------------------------------ Faith & community
  {
    id: "service-time-change",
    name: "Service time change",
    sector: "Faith & community",
    summary: "This week's service has moved; make sure the congregation knows.",
    purpose: "to let you know that this {day}'s service has moved to {newTime}",
    opening: null,
    outcomes: ["informed", "has a question"],
    facts: [
      { key: "day", example: "Sunday" },
      { key: "newTime", example: "9am" },
    ],
    voicemail: "leave_message",
    maxAttempts: 2,
    retryAfterMinutes: 720,
    callingWindow: HOME_HOURS,
    conversation: yesOrWhy("Is there anything you'd like to ask?", "Say goodbye."),
    rationale:
      "The message is the point, so a voicemail counts. Two tries twelve hours apart so both land before the day.",
  },
  {
    id: "welfare-check",
    name: "Welfare check-in",
    sector: "Faith & community",
    summary: "Ring elderly or isolated members to ask how they are and whether they need anything.",
    purpose: "just to check how you are and whether there is anything you need",
    opening: null,
    outcomes: ["well", "needs a visit", "needs practical help", "needs urgent help"],
    facts: [],
    voicemail: "hang_up",
    maxAttempts: 3,
    retryAfterMinutes: 240,
    callingWindow: HOME_HOURS,
    conversation: {
      fields: [
        field("howAreYou", "choice", "How are you keeping?", {
          options: ["well, thank you", "I'd like a visit", "I need some help with something", "I'm not well"],
          required: true,
        }),
      ],
      branch: {
        on: "howAreYou",
        arms: {
          "well, thank you": { fields: [], closing: "Say somebody will ring again next week and say goodbye warmly." },
          "I'd like a visit": {
            fields: [field("preferredDay", "text", "What day would be good?", { required: false })],
            closing: "Say a visit will be arranged and say goodbye warmly.",
          },
          "I need some help with something": {
            fields: [field("need", "text", "What can we help with?", { required: true })],
            closing: "Say it will be passed on today and say goodbye warmly.",
          },
          "I'm not well": { fields: [], handover: "A member says they are unwell. A person should be on this call now." },
        },
      },
    },
    rationale:
      "No voicemail — the people this reaches may live alone, and a machine saying 'we're checking on you' is not company. Anyone unwell goes to a person at once. Four hours between tries, three tries: an unanswered check-in is itself information.",
  },
  {
    id: "volunteer-rota",
    name: "Volunteer rota confirmation",
    sector: "Faith & community",
    summary: "Confirm volunteers for this week's duties.",
    purpose: "to confirm you are able to help with {duty} on {when}",
    opening: null,
    outcomes: ["confirmed", "cannot", "will find cover"],
    facts: [
      { key: "duty", example: "the food bank" },
      { key: "when", example: "Saturday morning" },
    ],
    voicemail: "leave_message",
    maxAttempts: 2,
    retryAfterMinutes: 720,
    callingWindow: EVENING,
    conversation: {
      fields: [
        field("can", "choice", "Are you still able to help?", {
          options: ["yes", "no, I can't this time", "I'll find someone to cover"],
          required: true,
        }),
      ],
      branch: {
        on: "can",
        arms: {
          yes: { fields: [], closing: "Say the time and where to go, and say goodbye." },
          "no, I can't this time": { fields: [], closing: "Say thank you for letting us know and say goodbye." },
          "I'll find someone to cover": { fields: [], closing: "Say to let the coordinator know who and say goodbye." },
        },
      },
    },
    rationale:
      "Evenings, because volunteers work in the day. Two tries; a volunteer is giving their time, and being chased for it is the fastest way to lose them.",
  },

  // ------------------------------------------------------------------ Any business
  {
    id: "callback-request",
    name: "Returning a missed call",
    sector: "Any business",
    summary: "They rang and could not get through; ring back and take the reason.",
    purpose: "to return your call from earlier — we are sorry we missed you",
    opening: null,
    outcomes: ["resolved", "needs a person", "no longer needed"],
    facts: [],
    voicemail: "leave_message",
    maxAttempts: 2,
    retryAfterMinutes: 120,
    callingWindow: OFFICE_HOURS,
    conversation: {
      fields: [
        field("about", "text", "What were you calling about?", { required: true }),
        field("next", "choice", "Would you like a person to call you back, or is that something I can note?", {
          options: ["a person, please", "just note it", "it's sorted now"],
          required: true,
        }),
      ],
      branch: {
        on: "next",
        arms: {
          "a person, please": { fields: [], handover: "A returned call that needs a person." },
          "just note it": { fields: [], closing: "Say it has been noted and say goodbye." },
          "it's sorted now": { fields: [], closing: "Say goodbye." },
        },
      },
    },
    rationale:
      "They rang first, which is the consent basis and is on the record. Two hours between tries — a returned call is worth little tomorrow. The reason is taken before the fork so a handover carries it.",
  },
  {
    id: "membership-renewal",
    name: "Membership renewal",
    sector: "Any business",
    summary: "A membership ends soon; ask whether they are renewing.",
    purpose: "because your membership ends on {when}, and to ask whether you would like to renew",
    opening: null,
    outcomes: ["renewing", "not renewing", "wants a different tier", "undecided"],
    facts: [{ key: "when", example: "the end of the month" }],
    voicemail: "leave_message",
    maxAttempts: 2,
    retryAfterMinutes: 4320,
    callingWindow: HOME_HOURS,
    conversation: {
      fields: [
        field("intent", "choice", "Would you like to renew?", {
          options: ["yes", "no", "I'd like a different level", "I haven't decided"],
          required: true,
        }),
      ],
      branch: {
        on: "intent",
        arms: {
          yes: { fields: [], closing: "Say how to renew and say goodbye. Do not take payment." },
          no: {
            fields: [field("reason", "text", "May I ask why?", { required: false })],
            closing: "Thank them and say goodbye. Do not persuade.",
          },
          "I'd like a different level": { fields: [], handover: "A tier change, for membership services." },
          "I haven't decided": { fields: [], closing: "Say what happens at expiry and say goodbye." },
        },
      },
    },
    rationale:
      "No payment taken, no persuasion on a no, two tries three days apart. The reason for leaving is asked once and gently — it is the most useful thing the campaign learns.",
  },
  {
    id: "complaint-followup",
    name: "After a complaint",
    sector: "Any business",
    summary: "A complaint was resolved; check they agree it was.",
    purpose: "following your recent complaint, to check whether it has been resolved to your satisfaction",
    opening: null,
    outcomes: ["resolved", "not resolved", "partly resolved"],
    facts: [],
    voicemail: "hang_up",
    maxAttempts: 2,
    retryAfterMinutes: 1440,
    callingWindow: OFFICE_HOURS,
    conversation: {
      fields: [
        field("resolved", "choice", "Has it been sorted out to your satisfaction?", {
          options: ["yes", "no", "partly"],
          required: true,
        }),
      ],
      branch: {
        on: "resolved",
        arms: {
          yes: { fields: [], closing: "Thank them for their patience and say goodbye." },
          no: { fields: [], handover: "A complaint the customer says is unresolved; a manager should take this." },
          partly: {
            fields: [field("remaining", "text", "What is still outstanding?", { required: true })],
            closing: "Apologise, say it will be raised today, and say goodbye.",
          },
        },
      },
    },
    rationale:
      "Nothing about a complaint on a voicemail. A 'no' goes to a manager, not a note — a complaint closed against the customer's word is a second complaint.",
  },
  {
    id: "webinar-reminder",
    name: "Webinar reminder",
    sector: "Any business",
    summary: "The morning of an online event, remind those who registered.",
    purpose: "to remind you that the {event} you registered for starts at {when} today",
    opening: null,
    outcomes: ["attending", "cannot attend", "wants the recording"],
    facts: [
      { key: "event", example: "product briefing" },
      { key: "when", example: "2pm" },
    ],
    voicemail: "leave_message",
    maxAttempts: 1,
    retryAfterMinutes: 60,
    callingWindow: MORNING,
    conversation: {
      fields: [
        field("plan", "choice", "Will you be able to join?", {
          options: ["yes", "no", "could I have the recording?"],
          required: true,
        }),
      ],
      branch: {
        on: "plan",
        arms: {
          yes: { fields: [], closing: "Say the link is in their email and say goodbye." },
          no: { fields: [], closing: "Say the recording will be sent and say goodbye." },
          "could I have the recording?": { fields: [], closing: "Say it will be sent afterwards and say goodbye." },
        },
      },
    },
    rationale:
      "One try, mornings only: a reminder for this afternoon is worthless after it. They registered, which is the consent basis. A voicemail is the reminder.",
  },
  {
    id: "referral-thanks",
    name: "Thank you for a referral",
    sector: "Any business",
    summary: "Somebody they referred became a customer; thank them.",
    purpose: "to thank you for recommending us to {referred}, who has just joined us",
    opening: null,
    outcomes: ["thanked", "wants referral reward info"],
    facts: [{ key: "referred", example: "Mrs Adeyemi" }],
    voicemail: "leave_message",
    maxAttempts: 1,
    retryAfterMinutes: 60,
    callingWindow: HOME_HOURS,
    conversation: yesOrWhy("Is there anything we can do for you in return?", "Thank them again and say goodbye."),
    rationale:
      "One try, and a voicemail is a perfectly good thank-you. A thank-you that has to be chased is not one.",
  },
];
