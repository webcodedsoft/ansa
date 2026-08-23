import { forSpeech } from "@ansa/normalizer";
import type { CallId, HandoffDestination, Logger, OrganizationId } from "@ansa/shared";
import type { TelephonyProvider } from "@ansa/telephony";

import type { CallRecorder } from "../telephony/event-log";
import { renderSummary, speakSummary, summarise, type LoggedEvent } from "./summary";
import type { EscalationTrigger } from "./triggers";
import type { WhisperRegistry } from "./whisper";

/**
 * The one path from "the agent has given up" to "a person is on the line".
 *
 * Every trigger — asked for, capture failed, misunderstood three times, tool down — comes
 * through here and gets the same treatment: the caller is told, the person answering is
 * briefed, the event log records both, and a failure to connect is said out loud rather
 * than becoming silence. A second path would mean a second answer to "what does the
 * caller hear when the transfer fails", and the two would not stay the same.
 *
 * The ordering below is the part that only a phone call proves and the part most likely
 * to be got wrong on a rewrite: the transfer replaces the call's carrier instruction,
 * which tears down the media stream we are speaking through. Anything the caller is owed
 * has to be finished before the REST call, not queued behind it.
 */

export interface HandoffDeps {
  /** The adapter, narrowed to what a transfer needs. */
  readonly telephony: Pick<TelephonyProvider, "transferToNumber">;
  readonly callId: CallId;
  readonly organizationId: OrganizationId | null;
  readonly callerNumber: string | null;
  /** Null when nothing is configured. The caller is then told the truth. */
  readonly destination: HandoffDestination | null;
  /**
   * Where a caller in danger goes, whatever the hour.
   *
   * Null falls back to `destination`, which is the right failure: an office line that may
   * not answer is still better than telling somebody in trouble that nobody is available.
   * The absence is reported as a readiness problem on `GET /numbers` so it is visible
   * before it is needed rather than discovered during the call it exists for.
   */
  readonly crisisDestination?: HandoffDestination | null;
  /** The call's own events, teed from the recorder. See journal.ts. */
  readonly events: () => readonly LoggedEvent[];
  readonly record: CallRecorder;
  readonly log: Logger;
  /**
   * Speaks one line to the caller and resolves once they have HEARD it, not once it has
   * been queued. Queued audio sits at the carrier for over a second on a real call, and
   * transferring on top of it deletes the sentence that explains what is happening.
   */
  readonly say: (text: string) => Promise<void>;
  readonly hangUp: () => void;
  readonly whisper: WhisperRegistry;
  /**
   * Where the carrier can reach us. Undefined means no whisper: the transfer still
   * happens, cold, and the log says it was cold.
   */
  readonly whisperBaseUrl?: string;
  /** Overridden in tests. A mark that never arrives must not strand the caller. */
  readonly sayTimeoutMs?: number;
}

/** Longer than any single sentence takes to play, short enough not to feel like a hang. */
const DEFAULT_SAY_TIMEOUT_MS = 8_000;

export const WHISPER_PATH = "/handoff/whisper";

/**
 * What the caller hears on the way out, by why they are going.
 *
 * A caller who asked for a person should not be told the assistant is having trouble, and
 * a caller the assistant failed should not be told "of course" as though they had asked.
 * Getting this wrong is the difference between a handover and a brush-off.
 */
const departureLine = (trigger: EscalationTrigger): string => {
  switch (trigger.kind) {
    case "asked-for-a-person":
      return "Of course. Let me put you through to someone now.";
    case "caller-in-crisis":
      /* Warm, present, and not in a hurry. The document is explicit about what this must
         not do: no questions about it, no advice, no minimising, and no rushing to get off
         the phone. It also must not sound like the other lines here, which are all some
         version of "I cannot do this" — that is the wrong thing to say to somebody who has
         just told you they are in trouble. */
      return "I am really sorry you are going through that. Stay with me — I am getting you to someone who can help.";
    case "capture-failed":
      return "Let me get a colleague for you — they will take it from here.";
    case "repeated-misunderstanding":
      return "I am not getting this right. Let me put you through to someone.";
    case "tool-failed":
      return "I cannot reach that from here. Let me put you through to someone who can.";
    case "needs-a-person":
      // Not "I cannot reach that": nothing was unreachable. The assistant is not allowed
      // to do it, which is a different sentence and the caller can hear the difference.
      return "That is not something I can do myself. Let me put you through to a colleague who can.";
  }
};

/** Said when there is nobody to transfer to. Honest, and it does not pretend to try. */
const NO_DESTINATION_LINE =
  "I am sorry — I cannot put you through to anyone right now. Please call back and someone will help you.";

/** Said when the carrier refused. The caller is still on our stream, so they can be told. */
const TRANSFER_FAILED_LINE =
  "I am sorry — I could not connect you. Please call back and ask for a person.";

/** Said by the carrier, not by us, if the person's phone rings out. */
const NO_ANSWER_LINE =
  "Sorry, nobody is free at the moment. Please call back shortly and someone will help you.";

/** Never let a mark that will not arrive hold a caller in silence. */
const sayWithin = async (
  say: (text: string) => Promise<void>,
  text: string,
  ms: number,
  log: Logger,
): Promise<void> => {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<void>((resolve) => {
    timer = setTimeout(() => {
      log.warn("caller never acknowledged the transfer line, going anyway");
      resolve();
    }, ms);
    timer.unref();
  });
  try {
    await Promise.race([say(text), timeout]);
  } catch (error) {
    // Speech failing must not cancel the transfer. A caller handed over without warning
    // is worse than one who is not handed over at all only if they are also dropped.
    log.error("could not speak the transfer line", {
      error: error instanceof Error ? error.message : String(error),
    });
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
};

export const createHandoff = (deps: HandoffDeps) => {
  const log = deps.log.child({ callId: deps.callId, organizationId: deps.organizationId ?? "unknown" });
  let started = false;

  return {
    /**
     * Hands the call over. Resolves once the carrier has accepted the transfer or the
     * caller has been told it failed — never before either.
     */
    escalate: async (trigger: EscalationTrigger): Promise<void> => {
      // Two triggers can fire on the same turn — a caller who asks for a person while a
      // tool is timing out — and the second transfer would replace the first mid-dial.
      if (started) {
        log.info("handoff already in progress, ignoring a second trigger", { kind: trigger.kind });
        return;
      }
      started = true;

      const summary = summarise({
        organizationId: deps.organizationId,
        carrierCallId: deps.callId,
        callerNumber: deps.callerNumber,
        events: deps.events(),
        escalation: trigger.detail,
      });

      // Recorded before the transfer, not after. Once the instruction is replaced the
      // media stream is gone and so is any chance to write down what we handed over.
      deps.record.event("handoff_started", {
        reason: trigger.kind,
        detail: trigger.detail,
        summary: renderSummary(summary),
        confirmedValues: summary.confirmed.length,
        unconfirmedValues: summary.unconfirmed.length,
      });
      log.info("escalating to a person", { reason: trigger.kind, detail: trigger.detail });

      /* A crisis goes to the line that answers at any hour, and falls back to the ordinary
         one when nobody has configured it. Chosen here rather than at the call site so
         there is one place that decides where a transfer lands. */
      const destination =
        trigger.kind === "caller-in-crisis" ? (deps.crisisDestination ?? deps.destination) : deps.destination;
      if (trigger.kind === "caller-in-crisis") {
        log.warn("crisis escalation", {
          configured: (deps.crisisDestination ?? null) !== null,
        });
        deps.record.event("crisis_escalation", {
          configured: (deps.crisisDestination ?? null) !== null,
        });
      }

      if (destination === null) {
        // The failure the charter names: today the agent says a line and transfers
        // nowhere. It is still a dead end, but it is one the caller is told about and one
        // the log can be searched for.
        log.error("escalation with no destination configured");
        deps.record.event("handoff_unavailable", { reason: trigger.kind });
        await sayWithin(deps.say, forSpeech(NO_DESTINATION_LINE), deps.sayTimeoutMs ?? DEFAULT_SAY_TIMEOUT_MS, log);
        deps.hangUp();
        return;
      }

      // The token is minted before the line is spoken so the URL exists by the time the
      // carrier could possibly fetch it.
      const whisperUrl =
        deps.whisperBaseUrl === undefined
          ? undefined
          : `${deps.whisperBaseUrl.replace(/\/+$/, "")}${WHISPER_PATH}/${deps.whisper.offer(speakSummary(summary))}`;
      if (whisperUrl === undefined) {
        log.warn("transferring without a summary: no reachable base url configured");
      }

      // Spoken and HEARD before the REST call. The transfer replaces the carrier
      // instruction, which ends the media stream this sentence is playing through.
      await sayWithin(
        deps.say,
        forSpeech(departureLine(trigger)),
        deps.sayTimeoutMs ?? DEFAULT_SAY_TIMEOUT_MS,
        log,
      );

      try {
        await deps.telephony.transferToNumber({
          callId: deps.callId,
          to: destination.to,
          from: destination.from,
          ringSeconds: destination.ringSeconds,
          noAnswerLine: forSpeech(NO_ANSWER_LINE),
          ...(whisperUrl === undefined ? {} : { whisperUrl }),
        });
        deps.record.event("handoff_transferred", {
          reason: trigger.kind,
          to: destination.to,
          withSummary: whisperUrl !== undefined,
        });
        log.info("transferred to a person", { to: destination.to });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        // The instruction was not replaced, so the media stream is still ours and the
        // caller can still be spoken to. This is the only reason transferToNumber rejects
        // rather than swallowing.
        log.error("carrier refused the transfer", { error: message });
        deps.record.event("handoff_failed", { reason: trigger.kind, error: message });
        await sayWithin(deps.say, forSpeech(TRANSFER_FAILED_LINE), deps.sayTimeoutMs ?? DEFAULT_SAY_TIMEOUT_MS, log);
        deps.hangUp();
      }
    },
  };
};

export type Handoff = ReturnType<typeof createHandoff>;
