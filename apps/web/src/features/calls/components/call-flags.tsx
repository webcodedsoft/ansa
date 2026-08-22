import { Notice } from "@/components/ui";

import type { CallDetail } from "../calls.service";

/**
 * The two things about a call that should not have to be found by reading down an event table.
 *
 * Both were recorded and neither was surfaced. They appeared as ordinary rows in the event
 * list, between a latency measurement and a barge-in, with nothing to say that one of them is
 * permanent.
 *
 * The suppression is the more important. It is global and it cannot be undone — `do_not_call`
 * grants the application role INSERT and SELECT and no DELETE, deliberately — so somebody
 * reading this call needs to know that dialling this person again is not a decision anybody
 * gets to make. Saying that in a banner rather than in a row is the whole point.
 */

/** What the carrier's answering-machine detection concluded, if it ran at all. */
const answeredBy = (call: CallDetail): string | null => {
  const verdict = call.events.find((event) => event.kind === "answered_by");
  const value = verdict?.detail.answeredBy;
  return typeof value === "string" ? value : null;
};

const VERDICT_WORDING: Readonly<Record<string, string>> = {
  human: "The carrier judged that a person answered.",
  machine:
    "The carrier judged that this reached an answering machine, so the agent left a message and hung up rather than holding a conversation with a greeting.",
  /* Neither, and said as neither. Folding the carrier's uncertainty into "machine" is how a
     real person gets counted as voicemail — and this model is trained on US carrier patterns,
     with nobody yet knowing how it behaves on Nigerian networks. */
  unknown: "The carrier could not tell whether a person or a machine answered.",
};

export const CallFlags = ({ call }: { readonly call: CallDetail }) => {
  const suppressed = call.events.some((event) => event.kind === "do_not_call_recorded");
  // Only meaningful on a call we placed. An inbound call is answered by a person by definition.
  const verdict = call.direction === "outbound" ? answeredBy(call) : null;

  if (!suppressed && verdict === null) return null;

  return (
    <div className="mb-3.5">
      {suppressed && (
        <Notice tone="error">
          On this call somebody asked never to be called again. That request is recorded
          platform-wide and permanently — there is no way to undo it from here, and no
          configuration that will dial this number again.
        </Notice>
      )}
      {verdict !== null && (
        <Notice tone="ok" className={suppressed ? "mt-3.5" : undefined}>
          {VERDICT_WORDING[verdict] ?? `The carrier reported "${verdict}".`}
        </Notice>
      )}
    </div>
  );
};
