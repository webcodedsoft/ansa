import type { Logger } from "@ansa/shared";
import type { LlmProvider } from "@ansa/llm";
import type { OpenAiListenSession } from "@ansa/openai-listen";
import type { CallMediaStream } from "@ansa/telephony";
import type { SynthesisStream, TtsProvider } from "@ansa/tts";

import { createConversation } from "./conversation";
import { createSentenceBuffer } from "./sentences";
import { SYSTEM_PROMPT } from "./system-prompt";

export interface OrchestratorDeps {
  readonly listen: OpenAiListenSession;
  readonly llm: LlmProvider;
  readonly tts: TtsProvider;
  readonly voiceId: string;
  readonly log: Logger;
  readonly greeting: string;
  /** Applied to everything spoken. Slice 4 replaces this with packages/normalizer. */
  readonly forSpeech: (text: string) => string;
}

/**
 * Runs one call.
 *
 * The two listen streams are consumed separately and correlated only by their offsets,
 * never by assuming they share a connection (R4.1.7) — today they do, after Gate A they
 * may not, and this code should not need to know.
 */
export const runConversation = (stream: CallMediaStream, deps: OrchestratorDeps): void => {
  const log = deps.log.child({ callId: stream.callId });
  const conversation = createConversation();

  let turnSeq = 0;
  /** Non-null while the agent has audio in flight or queued at the carrier. */
  let speaking: {
    readonly seq: number;
    synthesis: SynthesisStream | null;
    cancelLlm: (() => void) | null;
    /** Characters handed to TTS so far. */
    sent: number;
    /** Characters the carrier has confirmed played, via marks. */
    heard: number;
    text: string;
  } | null = null;

  const stageStart = new Map<string, number>();
  const mark = (stage: string): void => {
    stageStart.set(stage, Date.now());
  };
  const measure = (stage: string, extra: Record<string, unknown> = {}): number | null => {
    const started = stageStart.get(stage);
    if (started === undefined) return null;
    const ms = Date.now() - started;
    // Slice 2's `latencies` table is where these land once the event log is wired.
    log.info("latency", { stage, ms, ...extra });
    return ms;
  };

  // ---- audio in: one fan-out point ----------------------------------------
  stream.onAudio((chunk) => {
    deps.listen.write(chunk);
  });

  // ---- barge-in ------------------------------------------------------------
  const stopSpeaking = (reason: string): void => {
    const current = speaking;
    if (current === null) return;
    speaking = null;

    // Order matters. Stop producing before discarding, or newly synthesised audio can
    // land at the carrier after the clear and play over the caller.
    current.cancelLlm?.();
    current.synthesis?.cancel();
    stream.clear();

    // Only what the caller actually heard may stay in the history.
    conversation.truncateLastAgent(current.heard);

    log.info("barge-in", {
      reason,
      seq: current.seq,
      charsSent: current.sent,
      charsHeard: current.heard,
      discarded: Math.max(0, current.sent - current.heard),
    });
  };

  stream.onMark((name) => {
    const current = speaking;
    if (current === null) return;
    const [seq, chars] = name.split(":");
    if (Number(seq) !== current.seq) return;
    current.heard = Math.max(current.heard, Number(chars) || 0);
    if (current.heard >= current.sent && current.synthesis === null) {
      // Everything queued has now been heard; the turn is genuinely over.
      speaking = null;
    }
  });

  deps.listen.turns.onSpeechStart((event) => {
    log.debug("caller speech start", { offsetMs: event.offsetMs });
    if (speaking !== null) stopSpeaking("caller interrupted");
    mark("caller_turn");
  });

  deps.listen.turns.onEndOfTurn((event) => {
    log.debug("caller end of turn", { offsetMs: event.offsetMs });
    mark("stt_final");
  });

  // ---- speaking ------------------------------------------------------------
  const speak = (text: string, seq: number): void => {
    const current = speaking;
    if (current === null || current.seq !== seq) return;

    const spoken = deps.forSpeech(text);
    const synthesis = deps.tts.synthesize({
      text: spoken,
      voiceId: deps.voiceId,
      format: stream.format,
    });
    current.synthesis = synthesis;

    let first = true;
    synthesis.onAudio((chunk) => {
      if (speaking?.seq !== seq) return;
      if (first) {
        first = false;
        measure("tts_first_byte", { seq });
      }
      stream.send(chunk);
    });

    synthesis.onDone(() => {
      if (speaking?.seq !== seq) return;
      current.sent += text.length;
      current.synthesis = null;
      // A mark carries how much text precedes it, so when the carrier echoes it back we
      // know how much the caller has actually heard rather than merely been sent.
      stream.mark(`${seq}:${current.sent}`);
    });

    synthesis.onError((error) => {
      log.error("tts failed", { seq, error: error.message });
      if (speaking?.seq === seq) speaking = null;
    });
  };

  // ---- one caller turn -----------------------------------------------------
  const respondTo = (callerText: string): void => {
    measure("stt_final", { chars: callerText.length });
    conversation.addCaller(callerText);

    turnSeq += 1;
    const seq = turnSeq;
    speaking = { seq, synthesis: null, cancelLlm: null, sent: 0, heard: 0, text: "" };

    mark("llm_first_token");
    const sentences = createSentenceBuffer();
    const completion = deps.llm.complete({
      system: SYSTEM_PROMPT,
      messages: conversation.messages,
    });

    const current = speaking;
    current.cancelLlm = () => {
      completion.cancel();
    };

    let firstToken = true;
    completion.onDelta((token) => {
      if (speaking?.seq !== seq) return;
      if (firstToken) {
        firstToken = false;
        measure("llm_first_token", { seq });
      }
      current.text += token;
      // Speak each sentence as it completes rather than waiting for the whole reply.
      for (const sentence of sentences.push(token)) speak(sentence, seq);
    });

    completion.onDone((full) => {
      if (speaking?.seq !== seq) return;
      const tail = sentences.flush();
      if (tail.length > 0) speak(tail, seq);
      conversation.addAgent(full);
      log.info("agent turn", { seq, chars: full.length });
    });

    completion.onError((error) => {
      log.error("llm failed", { seq, error: error.message });
      if (speaking?.seq === seq) speaking = null;
    });
  };

  deps.listen.transcripts.onFinal((transcript) => {
    if (transcript.text.trim().length === 0) return;
    log.info("caller said", { text: transcript.text, offsetMs: transcript.offsetMs });
    respondTo(transcript.text);
  });

  // ---- open the call -------------------------------------------------------
  stream.onClosed((reason) => {
    stopSpeaking("call ended");
    deps.listen.close();
    log.info("conversation ended", { reason, turns: turnSeq });
  });

  turnSeq += 1;
  speaking = { seq: turnSeq, synthesis: null, cancelLlm: null, sent: 0, heard: 0, text: "" };
  conversation.addAgent(deps.greeting);
  speak(deps.greeting, turnSeq);
  log.info("conversation started");
};
