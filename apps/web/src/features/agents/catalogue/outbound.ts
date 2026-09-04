import {
  NIGERIA, amount, choice, date, desk, forked, handover, outbound, outboundRules, policy, quantity, ref, service, text, time,
} from "./kit";

/**
 * Campaigns the organisation places, not calls it takes.
 *
 * One purpose per campaign, and every way the call can go from there: the person is not
 * the one asked for, it is a bad time, they already did the thing, they dispute it, they
 * want a person. The outbound layer enforces consent, calling hours and answering-machine
 * detection; these templates handle what happens once a human says hello.
 *
 * No name or number is asked for: the organisation placed the call and already has both.
 * Nothing here asks for an address, an ID number, a card, an account or a PIN, and the
 * rules say so out loud, because a call that arrives asking for those is what fraud sounds
 * like.
 */
const CONSENT = policy(
  "Consent and courtesy",
  "Every outbound call.",
  ["Say who you are and why you called first.", "Take 'not now' and 'stop calling me' at face value and end the call."],
  ["Call back after being asked not to.", "Argue, pressure, or repeat the request after a no."],
  ["They say they never gave the company their number."],
);

const OUTBOUND_WORDS = [...NIGERIA, "not a good time", "call back", "wrong number", "already paid", "I've paid", "dispute", "speak to someone", "stop calling"];

export const OUTBOUND = [
  outbound({
    id: "payment-reminder",
    name: "Payment reminder",
    sector: "Outbound",
    summary: "A due or overdue payment: confirms who answered, hears 'already paid', takes a promise-to-pay date, and routes a dispute to a person — never a card or PIN.",
    persona: "Courteous, calm, and never threatening. Sounds like a reminder, not a demand.",
    greeting: "Good afternoon, this is a courtesy call about a payment that is due. Is now a good time?",
    instructions: outboundRules(
      "Say the amount and the due date as the company has them, once, and ask how they would like to proceed.",
      "If they say they have paid, thank them, take the date and the reference if they have it, and end the call.",
      "Never say the words debt, default or recovery. Never mention consequences.",
    ),
    keyterms: [...OUTBOUND_WORDS, "transfer", "reference", "receipt", "instalment", "next week", "month end", "salary"],
    policies: [
      CONSENT,
      policy("Disputes", "They say the amount is wrong, they do not owe it, or they were overcharged.", ["Take what they say and put them through, or promise a call back from a person."], ["Argue the amount or insist it is correct."]),
    ],
    ...desk(
      {
        "I've already paid": service([date("paidDate", "Thank you. Which day did you pay?"), ref("paidReference", "And is there a reference on the receipt? Say none if not.")], "Thank them, say the payment will be matched and they will get a confirmation text, and say goodbye."),
        "I'll pay on a date": service([date("promiseDate", "Which day will you pay?"), amount("promiseAmount", "And how much on that day?")], "Read the date and amount back, thank them, say a reminder text will come the day before, and say goodbye."),
        "I want to dispute it": handover([text("disputeReason", "I understand. Tell me what's wrong with it.")], "Say you are putting them through to somebody who can look at the account, and pass on the reason."),
        "not now": service([time("callbackTime", "No problem. When would be a better time to call?")], "Thank them, say you will call back then, and say goodbye."),
      },
      "How would you like to proceed — have you paid already, would you like to pay on a date, or is there something wrong with it?",
      [],
    ),
  }),

  outbound({
    id: "appointment-reminder",
    name: "Appointment reminder",
    sector: "Outbound",
    summary: "Confirms tomorrow's appointment, reschedules with a new day and time, cancels with a reason, and repeats any preparation instructions.",
    persona: "Friendly and brief. The whole call should take under a minute.",
    greeting: "Good afternoon, this is a reminder call about your appointment tomorrow. Is now a good time?",
    instructions: outboundRules(
      "Say the appointment's day and time as the company has them, and ask whether it still works.",
      "If it does, repeat any preparation instruction and end the call.",
      "If they cannot make it, take a new day and time, or the cancellation, and say a text will confirm.",
    ),
    keyterms: [...OUTBOUND_WORDS, "appointment", "tomorrow", "reschedule", "cancel", "confirm", "fasting", "bring", "ID", "card"],
    policies: [CONSENT, policy("What you can change", "They want to move or cancel.", ["Take the new day and time, or the cancellation."], ["Confirm a new slot as final; say a text confirms it."])],
    ...desk(
      {
        "yes, I'll be there": service([], "Thank them, repeat any preparation instruction — fasting, what to bring — and say goodbye."),
        "I need to reschedule": service([date("newDate", "Which day would suit you instead?"), time("newTime", "And what time?")], "Read it back, say a text will confirm the new slot, and say goodbye."),
        "I need to cancel": service([text("cancelReason", "No problem. May I ask why?", )], "Thank them, say the slot has been released and they are welcome to book again, and say goodbye."),
        "not now": service([time("callbackTime", "When would be a better time to call?")], "Say you will call back then, and say goodbye."),
      },
      "Does the appointment still work for you?",
      [],
    ),
  }),

  outbound({
    id: "delivery-confirmation",
    name: "Delivery confirmation",
    sector: "Outbound",
    summary: "Before a delivery: confirms the day and that somebody will be there, takes a landmark and an alternative receiver, or moves the delivery.",
    persona: "Quick and practical, like a good dispatcher.",
    greeting: "Good afternoon, this is a call about a delivery scheduled for you. Is now a good time?",
    instructions: outboundRules(
      "Say the delivery day as the company has it, and ask whether somebody will be there.",
      "Take a landmark for the rider; do not ask for the full address, the company has it.",
      "If they will not be there, take who will receive it, or a new day.",
    ),
    keyterms: [...OUTBOUND_WORDS, "delivery", "rider", "landmark", "gate", "receive", "security", "tomorrow", "reschedule"],
    policies: [CONSENT],
    ...desk(
      {
        "yes, I'll be there": service([text("landmark", "Great. Is there a landmark near you the rider should look for?")], "Read the landmark back, say the rider will call when close, and say goodbye."),
        "somebody else will receive it": service([text("receiverName", "Who will receive it?"), text("receiverLandmark", "And a landmark for the rider?")], "Read it back, say the rider will ask for that person, and say goodbye."),
        "move it to another day": service([date("newDeliveryDate", "Which day would be better?"), choice("newDeliveryWindow", "Morning, or afternoon?", ["morning", "afternoon"])], "Read it back, say a text will confirm, and say goodbye."),
        "not now": service([time("callbackTime", "When would be a better time to call?")], "Say you will call back then, and say goodbye."),
      },
      "Will somebody be there to receive it?",
      [],
    ),
  }),

  outbound({
    id: "satisfaction-survey",
    name: "Customer satisfaction survey",
    sector: "Outbound",
    summary: "Three questions after a purchase or a service: a score, what went well or badly in their words, and whether they want a person to follow up.",
    persona: "Light, grateful, and genuinely curious. Takes criticism warmly.",
    greeting: "Good afternoon, this is a quick call to ask how your recent experience with us went. It takes about a minute — is now a good time?",
    instructions: outboundRules(
      "Three questions, no more. Do not defend the company when they criticise it; thank them.",
      "If they are unhappy, ask whether they would like a person to call, and treat a yes as urgent.",
    ),
    keyterms: [...OUTBOUND_WORDS, "rating", "out of ten", "excellent", "poor", "feedback", "recommend"],
    policies: [CONSENT, policy("Complaints on a survey", "They describe a problem that has not been resolved.", ["Thank them, take it in their words, and offer a call back from a person."], ["Explain, excuse or argue."], ["They say they want to cancel, or are still without what they paid for."])],
    ...desk(
      {
        "happy to answer": forked(
          [quantity("score", "On a scale of one to ten, how would you rate the experience?"), text("feedback", "Thank you. What went well, or what could we have done better?")],
          "followUp",
          "Would you like somebody to call you about anything you mentioned?",
          {
            yes: handover([], "Thank them, say a person will call, and pass on the score and the feedback."),
            no: service([], "Thank them warmly and say goodbye."),
          },
        ),
        "not now": service([time("callbackTime", "When would be a better time?")], "Say you will call back then, and say goodbye."),
        "I'd rather not": service([], "Thank them, say you will not call about this again, and say goodbye."),
      },
      "Are you happy to answer three quick questions?",
      [],
    ),
  }),

  outbound({
    id: "renewal-reminder",
    name: "Renewal reminder",
    sector: "Outbound",
    summary: "A policy, subscription or membership due for renewal: renews, changes the plan, declines with a reason, or routes a question to a person.",
    persona: "Helpful and unpushy. It is a reminder, not a sale.",
    greeting: "Good afternoon, this is a courtesy call about a renewal that is coming up. Is now a good time?",
    instructions: outboundRules(
      "Say what is renewing and when, once. Do not quote a new price; say the renewal notice has it.",
      "If they want to renew, say how — the link or the account details in the notice — and never take payment details.",
      "If they decline, thank them and take the reason without arguing.",
    ),
    keyterms: [...OUTBOUND_WORDS, "renew", "renewal", "policy", "subscription", "membership", "expires", "plan", "upgrade", "downgrade"],
    policies: [CONSENT, policy("Payment", "They want to pay on the call.", ["Say how to pay from the renewal notice."], ["Take a card number, an account number or any payment detail."])],
    ...desk(
      {
        "yes, renew it": service([], "Thank them, say the renewal notice has the payment link and details, and that a confirmation follows payment. Say goodbye."),
        "I want to change the plan": service([choice("planChange", "Would you like more, or less?", ["more", "less"]), text("planDetail", "What would suit you better?")], "Read it back, say an adviser will call with the options, and say goodbye."),
        "I don't want to renew": service([text("declineReason", "That's fine. May I ask why?")], "Thank them for saying, say the account will simply lapse at the date and they are welcome back, and say goodbye."),
        "I have a question": handover([text("question", "Go ahead.")], "Say you are putting them through to somebody who can answer it properly."),
        "not now": service([time("callbackTime", "When would be a better time?")], "Say you will call back then, and say goodbye."),
      },
      "Would you like to renew, change the plan, or is there something you'd like to ask?",
      [],
    ),
  }),

  outbound({
    id: "lead-follow-up",
    name: "Lead follow-up",
    sector: "Outbound",
    summary: "After an enquiry: checks whether they are still interested, books a visit, demo or call with an adviser, or closes the lead politely.",
    persona: "Warm and low-pressure. Sounds like a follow-up, not a chase.",
    greeting: "Good afternoon, this is a follow-up to the enquiry you made with us recently. Is now a good time?",
    instructions: outboundRules(
      "Remind them briefly what they enquired about, and ask whether they are still interested.",
      "If they are, book the next step. If not, thank them and close the lead. Do not pitch.",
    ),
    keyterms: [...OUTBOUND_WORDS, "enquiry", "interested", "still interested", "demo", "visit", "adviser", "brochure", "quotation"],
    policies: [CONSENT, policy("No pressure", "They hesitate or say they are still thinking.", ["Offer to send information and to call again in a week or two if they like."], ["Push, discount, or create urgency."])],
    ...desk(
      {
        "yes, still interested": forked(
          [],
          "nextStep",
          "Would a visit, a demo, or a call with an adviser suit you best?",
          {
            "a visit": service([date("visitDate", "Which day?"), time("visitTime", "And what time?")], "Read it back, say a text will confirm it, and say goodbye."),
            "a demo": service([date("demoDate", "Which day?"), time("demoTime", "And what time?")], "Read it back, say the link or the address will be sent by text, and say goodbye."),
            "a call with an adviser": service([date("adviserDate", "Which day?"), time("adviserTime", "And what time?")], "Read it back, say the adviser will call then, and say goodbye."),
          },
        ),
        "still thinking": service([choice("sendInfo", "Would you like us to send more information, and check back in a couple of weeks?", ["yes", "no"])], "Thank them, do what they asked, and say goodbye."),
        "no longer interested": service([text("closeReason", "That's fine. May I ask what changed?", )], "Thank them, say you will close the enquiry and will not call about it again, and say goodbye."),
        "not now": service([time("callbackTime", "When would be a better time?")], "Say you will call back then, and say goodbye."),
      },
      "Are you still interested?",
      [],
    ),
  }),
];
