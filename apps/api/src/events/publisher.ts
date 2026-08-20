import { enqueueEventDelivery, type Db } from "@ansa/db";
import type { Logger, OrganizationId } from "@ansa/shared";
import type { EventType, PreparedEvents } from "@ansa/tools";

import type { CallFacts } from "../conversation/call-facts";
import { summarise, type LoggedEvent } from "../handoff/summary";
import type { CallRecorder } from "../telephony/event-log";

import {
  callEndedPayload,
  callTransferredPayload,
  serialisePayload,
  type CallEndedPayload,
  type CallIdentity,
  type CallTransferredPayload,
  type ReportedAction,
  type TranscriptLine,
} from "./payloads";

/**
 * The call's side of event webhooks, and deliberately the whole of it.
 *
 * This is a tee on the recorder — the same shape as `handoff/journal.ts` and for a related
 * reason. What it does at a lifecycle point is write a row to the outbox and forget it. It
 * makes no request, waits for nothing, and never learns whether a receiver was up. A
 * failing endpoint has no path back to a conversation because there is no path: the only
 * thing on the call side is an insert, and even that is fire-and-forget with its failure
 * swallowed into the log, exactly as the recorder handles a database hiccup.
 *
 * Why a tee rather than a hook in the orchestrator or in `handoff.ts`: those files own the
 * conversation, and the whole claim of this slice is that events are not part of it. The
 * recorder already sees every lifecycle moment that matters, so nothing in the call path
 * needs to learn that webhooks exist.
 */

/** A long call must not grow this without bound. Well past any real conversation. */
const MAX_LINES = 600;
const MAX_ACTIONS = 100;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const readString = (value: unknown): string | null =>
  typeof value === "string" && value.trim().length > 0 ? value.trim() : null;

/** Every kind the dispatch path reports, whatever adapter was behind it. */
const TOOL_KINDS = new Set(["tool_call", "tool_result", "tool_invoked", "tool_failed"]);

export interface EventPublisherDeps {
  readonly dataSource: Db | null;
  readonly log: Logger;
  readonly organizationId: OrganizationId;
  readonly events: PreparedEvents;
  readonly call: CallIdentity;
  /** Read at the moment an event fires, not snapshotted: a value confirmed on the last
   *  turn has to be in the payload. */
  readonly facts: () => CallFacts | null;
  /** The handoff journal, which is where the transfer summary comes from. */
  readonly journal: () => readonly LoggedEvent[];
  readonly callerNumber: string | null;
  readonly now?: () => number;
}

/**
 * Wrap the real recorder. Every call passes straight through; some also queue a delivery.
 *
 * Returns the recorder unchanged when the organization has configured no receivers, which is
 * every organization until one does. Nothing reaches a real call unless a real organization asked for
 * it, and this is where that is true rather than in a comment.
 */
export const withEventPublisher = (
  inner: CallRecorder,
  deps: EventPublisherDeps,
): CallRecorder => {
  if (deps.events.empty || deps.dataSource === null) return inner;

  const dataSource = deps.dataSource;
  const now = deps.now ?? Date.now;
  const lines: TranscriptLine[] = [];
  const actions: ReportedAction[] = [];
  let transferred = false;
  let published = false;

  /**
   * One event, to every receiver that asked for it.
   *
   * Serialised inside the loop, which since R5.2.4 was withdrawn produces identical bytes
   * for every receiver. Kept that way on purpose: what is stored against a delivery must be
   * what that delivery sent, and hoisting it would make the two the same object by accident
   * rather than by rule.
   */
  const publish = (
    type: EventType,
    build: () => CallEndedPayload | CallTransferredPayload,
  ): void => {
    const receivers = deps.events.subscribersTo(type);
    if (receivers.length === 0) return;

    let payload: CallEndedPayload | CallTransferredPayload;
    try {
      payload = build();
    } catch (error) {
      deps.log.error("could not build an event payload; nothing was queued", {
        organizationId: deps.organizationId,
        event: type,
        error: error instanceof Error ? error.message : String(error),
      });
      return;
    }

    for (const receiver of receivers) {
      let body: string;
      try {
        body = serialisePayload(payload);
      } catch (error) {
        // Serialisation failing must never send something half-built instead.
        deps.log.error("could not prepare an event payload for a receiver", {
          organizationId: deps.organizationId,
          event: type,
          subscription: receiver.subscription.name,
          error: error instanceof Error ? error.message : String(error),
        });
        continue;
      }

      void enqueueEventDelivery(dataSource, {
        organizationId: deps.organizationId,
        eventType: type,
        subscription: receiver.subscription.name,
        carrierCallId: deps.call.callId,
        configVersion: deps.call.configVersion,
        body,
      }).catch((error: unknown) => {
        // Swallowed for the same reason every write in the recorder is: the caller is on
        // the line, or has just left it, and a database hiccup is not their problem.
        deps.log.error("could not queue an event delivery", {
          organizationId: deps.organizationId,
          event: type,
          subscription: receiver.subscription.name,
          error: error instanceof Error ? error.message : String(error),
        });
      });
    }
  };

  return {
    started: (call) => {
      inner.started(call);
    },

    event: (kind, detail, offsetMs) => {
      inner.event(kind, detail, offsetMs);
      const fields = isRecord(detail) ? detail : {};

      if (kind === "agent said") {
        const text = readString(fields["text"]);
        if (text !== null && lines.length < MAX_LINES) {
          lines.push({ at: offsetMs ?? 0, speaker: "agent", text, confidence: null });
        }
        return;
      }

      if (TOOL_KINDS.has(kind)) {
        const name = readString(fields["tool"]) ?? readString(fields["name"]);
        if (name !== null && actions.length < MAX_ACTIONS) {
          actions.push({ name, outcome: readString(fields["outcome"]) ?? "unknown" });
        }
        return;
      }

      if (kind === "handoff_transferred") {
        transferred = true;
        publish("call.transferred", () =>
          callTransferredPayload({
            call: deps.call,
            at: now(),
            summary: summarise({
              organizationId: deps.organizationId,
              carrierCallId: deps.call.callId,
              callerNumber: deps.callerNumber,
              events: deps.journal(),
              escalation: readString(fields["detail"]) ?? readString(fields["reason"]),
            }),
          }),
        );
      }
    },

    latency: (l) => {
      inner.latency(l);
    },

    transcript: (t) => {
      inner.transcript(t);
      // The caller's side. The agent's own words arrive as `agent said` above, because the
      // agent is not transcribed — we know exactly what it said.
      if (lines.length < MAX_LINES) {
        lines.push({
          at: t.offsetMs,
          speaker: "caller",
          text: t.text,
          confidence: t.confidence,
        });
      }
    },

    turn: (t) => {
      inner.turn(t);
    },

    ended: (reason, carrierStatus, durationSeconds) => {
      inner.ended(reason, carrierStatus, durationSeconds);
      // `ended` can be reached twice — the media stream closing and the carrier's status
      // callback — and an organisation being told twice that the same call ended is a
      // duplicate they cannot deduplicate, because it would carry two event ids.
      if (published) return;
      published = true;

      publish("call.ended", () =>
        callEndedPayload({
          call: deps.call,
          endedAt: now(),
          endReason: reason,
          durationSeconds: durationSeconds ?? 0,
          // Sorted, because the two sources interleave and arrive out of order at the
          // boundaries of a barge-in.
          transcript: [...lines].sort((a, b) => a.at - b.at),
          actions,
          transferredToHuman: transferred,
          facts: deps.facts(),
        }),
      );
    },
  };
};
