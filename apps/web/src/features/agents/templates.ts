
import { CATALOGUE_TEMPLATES } from "./templates.catalogue";
import { field, type AgentTemplate } from "./templates.shape";

export { allFields, field, type AgentTemplate, type TemplateBranch } from "./templates.shape";

/**
 * Starting points for a new agent.
 *
 * An organisation can now have no agents at all — migration 0025 removed the trigger that
 * used to create one — so this is the first thing somebody sees after signing up. A blank
 * form at that moment asks a person who has never configured a voice agent to invent the
 * shape of one, and what they invent is usually a web form read aloud: "Please enter your
 * policy number." These templates exist to put a working conversation in front of them
 * instead, which they then edit.
 *
 * Every prompt below is written as speech. That is the same rule the field builder states
 * and the reason it is worth repeating here: these strings go through the normalizer and
 * out of a speaker, and "Policy number:" is not something a person says.
 *
 * Written for Nigerian callers — naira, WAT, Nigerian English, real branch names. A
 * template full of "Main Street" and dollars is a template every organisation has to
 * rewrite before it is usable, which defeats the point of having one.
 */

/** Two letters and seven digits, the shape most Nigerian insurers use for a policy. */
const POLICY_PATTERN = "^[A-Z]{2}[0-9]{7}$";

const FOUNDING_TEMPLATES: readonly AgentTemplate[] = [
  {
    id: "customer-service",
    name: "Insurance customer service",
    sector: "Insurance",
    summary: "Identifies the caller, confirms their policy number, then answers or transfers.",
    persona:
      "Warm and unhurried. Plain Nigerian English, no jargon. Never rush somebody who is reading out a number — wait for them to finish.",
    greeting: "Good afternoon, thank you for calling. How can I help you today?",
    instructions: [
      "Answer in two sentences at most.",
      "Confirm the policy number by reading it back one character at a time before you act on it. If they say it is wrong, ask again rather than guessing.",
      "Amounts are in naira and times are West Africa Time. Do not convert either.",
      "If they ask to cancel a policy, or to change who is named on it, transfer to a person — do not attempt it yourself.",
      "If you cannot check something, say so in a few words and offer to put them through.",
    ].join(" "),
    fields: [
      field("policyNumber", "reference", "Could you read me your policy number, one digit at a time?", {
        // Keypad because the tones survive an 8 kHz line intact, and an insurer's reference
        // is the one value on the call where a single wrong character is a wrong customer.
        capture: "keypad",
        confirm: "readback",
        pattern: POLICY_PATTERN,
      }),
      field("callerName", "name", "And who am I speaking with?", {
        confirm: "readback",
      }),
      field("reasonForCall", "text", "What can I help you with today?", {
        attempts: 2,
      }),
    ],
    bargeIn: true,
    answeringMachineDetection: false,
  },

  {
    id: "after-hours",
    name: "After hours",
    sector: "Any business",
    summary: "Takes a message when the office is closed. Looks nothing up, promises nothing.",
    persona:
      "Brief and apologetic without over-apologising. Somebody ringing a closed office wants to leave their details and go.",
    greeting:
      "Thanks for calling. The office is closed at the moment — we open again at eight in the morning. I can take a message and somebody will call you back.",
    instructions: [
      "Answer in two sentences at most.",
      "You cannot look anything up on this call and you have no access to any records. Do not offer to check, and do not say somebody will definitely call at a particular time.",
      "Take the message, read the callback number back, and end the call politely.",
      "If they say it is an emergency, transfer to a person immediately rather than taking a message.",
    ].join(" "),
    fields: [
      field("callerName", "name", "Can I take your name?"),
      field("callbackNumber", "phone", "And the best number to reach you on?", {
        // Either, because somebody ringing after hours is often reading their own number off
        // a second handset and would rather key it than say it twice.
        capture: "either",
        confirm: "readback",
      }),
      field("message", "text", "What would you like me to pass on?", {
        attempts: 2,
      }),
    ],
    bargeIn: true,
    answeringMachineDetection: false,
  },

  {
    id: "appointment-booking",
    name: "Appointment booking",
    sector: "Any business",
    summary: "Takes a name, a branch and a preferred day, then reads the booking back.",
    persona:
      "Efficient and friendly. Offers a concrete alternative when the day somebody asks for does not work, rather than asking them to guess again.",
    greeting: "Hello, thanks for calling. I can help you book an appointment.",
    instructions: [
      "Answer in two sentences at most.",
      "Collect the branch first, then the day, then the name — a caller who names a branch has usually already decided, and asking their name first makes it feel like a form.",
      "Read the whole booking back before you confirm it: branch, day and name together.",
      "Working hours are eight in the morning to five in the evening, West Africa Time, Monday to Friday. Do not offer a Saturday.",
      "If they want to change or cancel an existing appointment, transfer to a person.",
    ].join(" "),
    fields: [
      field("branch", "choice", "Which branch would suit you — Ikeja, Wuse, or Port Harcourt?", {
        options: ["Ikeja", "Wuse", "Port Harcourt"],
        confirm: "readback",
      }),
      field("preferredDay", "date", "What day were you hoping to come in?", {
        confirm: "readback",
      }),
      field("callerName", "name", "And what name should I put it under?", {
        confirm: "readback",
      }),
      field("callbackNumber", "phone", "If anything changes, what number should we use?", {
        capture: "either",
        confirm: "readback",
        required: false,
      }),
    ],
    bargeIn: true,
    answeringMachineDetection: false,
  },

  {
    id: "renewals-outreach",
    name: "Renewals reminder",
    sector: "Insurance",
    summary: "Calls out about a renewal, confirms who answered, and records their answer.",
    persona:
      "Polite and direct. This is an unsolicited call, so it says who it is and why it is calling in the first breath, and accepts a no without pushing.",
    greeting:
      "Good afternoon — I'm calling about your policy renewal. Is now a convenient time to talk?",
    instructions: [
      "Answer in two sentences at most.",
      "Say who is calling and why before anything else. If they say it is not a good time, offer to call back and end the call.",
      "Confirm you are speaking to the policyholder before you discuss the policy at all. If you are not, do not give any details — ask when the policyholder is available and end the call.",
      "Amounts are in naira. Read a premium back slowly and once only.",
      "If they want to change cover or cancel, transfer to a person. Never take a payment on this call.",
      "If they ask to be taken off the list, say you will action it and end the call.",
    ].join(" "),
    fields: [
      field("policyNumber", "reference", "Can you confirm your policy number for me?", {
        capture: "keypad",
        confirm: "readback",
        pattern: POLICY_PATTERN,
      }),
      field("renewalDecision", "choice", "Would you like to go ahead with the renewal, think about it, or stop there?", {
        options: ["Renew", "Think about it", "Do not renew"],
        confirm: "readback",
      }),
      field("callbackNumber", "phone", "If we need to reach you, is this the best number?", {
        capture: "either",
        required: false,
      }),
    ],
    bargeIn: true,
    // The one template that wants it: an outbound call reaching voicemail otherwise holds a
    // two-minute conversation with a greeting, and is billed for it.
    answeringMachineDetection: true,
  },

  {
    id: "blank",
    name: "Start from nothing",
    sector: "Any business",
    summary: "A name and nothing else. Write the greeting and the form yourself.",
    persona: "",
    greeting: "",
    instructions: "",
    fields: [],
    bargeIn: true,
    answeringMachineDetection: false,
  },
];

/** Null rather than a throw: a template id in a request body is not to be trusted. */
/**
 * Everything, the founding five first and the catalogue after, blank last.
 *
 * The catalogue lives in its own file because it is fifty templates of content and this
 * file is the shape. `field` is exported to it so both build questions the same way.
 */
export const AGENT_TEMPLATES: readonly AgentTemplate[] = [
  ...FOUNDING_TEMPLATES.filter((template) => template.id !== "blank"),
  ...CATALOGUE_TEMPLATES,
  ...FOUNDING_TEMPLATES.filter((template) => template.id === "blank"),
];

/** Every sector in the catalogue, in the order the gallery lists them. */
export const TEMPLATE_SECTORS: readonly string[] = [
  ...new Set(AGENT_TEMPLATES.map((template) => template.sector)),
];

export const findTemplate = (id: string): AgentTemplate | null =>
  AGENT_TEMPLATES.find((template) => template.id === id) ?? null;
