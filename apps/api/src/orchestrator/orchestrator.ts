import type { LlmProvider } from "@ansa/llm";
import type { OpenAiListenSession } from "@ansa/openai-listen";
import type { AudioChunk, Logger } from "@ansa/shared";
import type { CallMediaStream } from "@ansa/telephony";
import { durationMs, type SynthesisStream, type TtsProvider } from "@ansa/tts";

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
  /**
   * How long after the agent starts producing audio to ignore speech-start.
   *
   * The caller's handset picks up the agent's own voice and sends it back, so VAD fires
   * on our own audio within a few hundred milliseconds of every turn. Observed on a live
   * call: every single agent turn was barged-in at `charsHeard: 0` — interrupted before
   * the caller could possibly have heard, let alone reacted to, a word of it.
   *
   * This is a floor, not echo cancellation. Too high and real interruptions are ignored.
   */
  readonly bargeInGuardMs?: number;
  /**
   * The greeting, already rendered. Fixed text in a fixed voice is deterministic, so
   * synthesising it over the network on every call spends ~500-950ms of silence at the
   * moment the caller is listening hardest. Null falls back to synthesising live.
   */
  readonly greetingAudio?: readonly AudioChunk[] | null;
  /**
   * Pre-rendered acknowledgements, played into the thinking gap. Empty disables filler.
   */
  readonly fillers?: readonly (readonly AudioChunk[])[];
  /** Play the first filler if no reply audio has gone out this long after end-of-turn. */
  readonly fillerAfterMs?: number;
}

/** A sentence that has been handed to TTS, and where its audio sits in the turn. */
interface SpokenSentence {
  readonly text: string;
  readonly startByte: number;
  readonly endByte: number;
}

interface AgentTurn {
  readonly seq: number;
  /** Sentences waiting to be synthesised, in order. */
  readonly queue: string[];
  synthesis: SynthesisStream | null;
  cancelLlm: (() => void) | null;
  /**
   * Audio accounting is in BYTES, not characters.
   *
   * Characters only advanced when a whole sentence finished synthesising, so for the
   * entire duration of a sentence both counters read zero — and a mid-sentence
   * interruption reported that the caller had heard nothing, erasing a reply they had
   * in fact heard most of. Bytes advance continuously and convert to milliseconds of
   * audio exactly.
   */
  bytesSent: number;
  bytesHeard: number;
  /** Completed sentences, in order. Used to reconstruct what was heard. */
  readonly spoken: SpokenSentence[];
  /**
   * The sentence currently being synthesised. Its total audio length is not yet known,
   * so what the caller has heard of it is estimated from duration rather than measured.
   */
  inFlight: { readonly text: string; readonly startByte: number } | null;
  llmDone: boolean;
  /** When audio for the sentence currently playing began. Anchors the echo guard. */
  sentenceAudioAt: number | null;
}

const DEFAULT_BARGE_IN_GUARD_MS = 400;

/**
 * Deliberately below a real speaking rate (~15). Used only to estimate how far into a
 * still-synthesising sentence the caller has got, where the sentence's full audio
 * length is not yet known. Under-crediting is the safe direction: the agent referring
 * to something the caller did not hear is the failure CLAUDE.md names.
 */
const CHARS_PER_SECOND = 13;

/** First acknowledgement. Early enough that the caller never hears a full second of nothing. */
const DEFAULT_FILLER_AFTER_MS = 450;
/** Second one, which is R6.2's two-second rule made literal. Never more than two per turn. */
const SECOND_FILLER_AFTER_MS = 2200;

/**
 * Said when a turn produces nothing. Deliberately an invitation rather than an
 * explanation: the caller does not care why, and "sorry, could you say it again"
 * recovers a turn that would otherwise end in silence.
 */
const RECOVERY_LINE = "Sorry, I did not catch that. Could you say it again?";

/**
 * If a turn has produced no audio at all by this point, say something.
 *
 * Anchored to the turn and cleared by the first reply byte — never to wall-clock
 * silence, because a timer that re-arms on every quiet moment eventually fires while
 * the caller is mid-thought, which is worse than the gap it was closing.
 */
const TURN_WATCHDOG_MS = 4_000;

/**
 * R6.3, enforced where it cannot be argued with. The prompt asks for two sentences and
 * the model will drift past it; this caps the turn regardless, and caps worst-case tail
 * latency at the same time.
 */
const MAX_SENTENCES_PER_TURN = 2;

/**
 * Backchannel: the noises a listener makes to show they are still there.
 *
 * A person saying "mm-hm" while you speak is not taking the floor, and a speaker who
 * stopped dead every time would be exhausting. Seen on a live call: "Mm." arrived
 * mid-reply, was treated as a turn, and discarded 916ms of speech the caller was in the
 * middle of hearing.
 *
 * Only applied while the agent is speaking. The same word alone in silence is a real
 * turn — a caller answering "yeah" to a question means yes.
 */
const BACKCHANNEL = new Set([
  "mm", "mmm", "mhm", "mmhm", "hmm", "hm", "uh", "uh huh", "uhhuh", "huh",
  "yeah", "yep", "yes", "ok", "okay", "right", "sure", "aha", "ah", "oh", "i see",
]);

export const runConversation = (stream: CallMediaStream, deps: OrchestratorDeps): void => {
  const log = deps.log.child({ callId: stream.callId });
  const conversation = createConversation();
  const guardMs = deps.bargeInGuardMs ?? DEFAULT_BARGE_IN_GUARD_MS;

  let turnSeq = 0;
  let turn: AgentTurn | null = null;

  /**
   * Speech segments the barge-in guard judged to be our own audio coming back.
   *
   * The guard only suppresses the speech-start event. The transcript of that same
   * segment still arrives, and without this it is answered as though the caller said
   * it — the agent holding a conversation with itself. Matching is exact rather than a
   * tolerance window, because a transcript now carries the offset of the speech-start
   * that produced it.
   */
  const echoSegments = new Set<number>();
  /**
   * The last few hundred characters the agent has actually spoken, normalised the same
   * way a transcript will be. A transcript wholly contained in this is our own voice.
   */
  let spokenWindow = "";

  /** Timers for the thinking-gap acknowledgements, cleared the moment real audio starts. */
  let fillerTimers: ReturnType<typeof setTimeout>[] = [];
  let fillerIndex = 0;

  let watchdog: ReturnType<typeof setTimeout> | null = null;
  const cancelWatchdog = (): void => {
    if (watchdog !== null) clearTimeout(watchdog);
    watchdog = null;
  };

  const cancelFiller = (): void => {
    for (const timer of fillerTimers) clearTimeout(timer);
    fillerTimers = [];
  };

  /**
   * Filler audio goes to the carrier and nowhere else: it is not counted in bytesSent,
   * produces no mark, and never enters the conversation. The agent did not say anything
   * it should remember. It IS added to the spoken window so the echo filter recognises
   * it coming back.
   */
  const playFiller = (): void => {
    const pool = deps.fillers ?? [];
    if (pool.length === 0) return;
    const chunks = pool[fillerIndex % pool.length];
    fillerIndex += 1;
    if (chunks === undefined) return;
    for (const chunk of chunks) stream.send(chunk);
    log.debug("played thinking filler", { index: fillerIndex });
  };

  const armFiller = (): void => {
    cancelFiller();
    if ((deps.fillers ?? []).length === 0) return;
    const first = deps.fillerAfterMs ?? DEFAULT_FILLER_AFTER_MS;
    fillerTimers = [
      setTimeout(playFiller, first),
      setTimeout(playFiller, SECOND_FILLER_AFTER_MS),
    ];
    for (const timer of fillerTimers) timer.unref();
  };

  const stageStart = new Map<string, number>();
  const mark = (stage: string): void => {
    stageStart.set(stage, Date.now());
  };
  const measure = (stage: string, extra: Record<string, unknown> = {}): void => {
    const started = stageStart.get(stage);
    if (started === undefined) {
      // Silently returning here is how "tts_first_byte measured against a mark that was
      // never set" reached a live call and stayed invisible for hours.
      log.warn("latency mark missing", { stage });
      return;
    }
    stageStart.delete(stage);
    // Slice 2's `latencies` table is where these land once the event log is wired.
    log.info("latency", { stage, ms: Date.now() - started, ...extra });
  };

  // ---- audio in: the single fan-out point ---------------------------------
  stream.onAudio((chunk) => {
    deps.listen.write(chunk);
  });

  // ---- speaking ------------------------------------------------------------
  /**
   * What the caller has actually heard of this turn, reconstructed from byte position.
   *
   * A sentence still being synthesised credits nothing: those bytes belong to text that
   * may not have been fully produced. Under-remembering is the safe direction — the
   * agent must never reference something the caller did not hear.
   */
  /** Half a word is not something a caller heard. */
  const toWordBoundary = (text: string, upTo: number): string => {
    const slice = text.slice(0, Math.max(0, upTo));
    if (slice.length === text.length) return slice;
    const lastSpace = slice.lastIndexOf(" ");
    return lastSpace > 0 ? slice.slice(0, lastSpace) : "";
  };

  const heardText = (current: AgentTurn): string => {
    const parts: string[] = [];
    for (const sentence of current.spoken) {
      if (current.bytesHeard >= sentence.endByte) {
        parts.push(sentence.text);
        continue;
      }
      const span = sentence.endByte - sentence.startByte;
      if (span <= 0 || current.bytesHeard <= sentence.startByte) break;
      const ratio = (current.bytesHeard - sentence.startByte) / span;
      parts.push(toWordBoundary(sentence.text, Math.floor(sentence.text.length * ratio)));
      return parts.join(" ").trim();
    }

    // Nothing complete is outstanding, so the caller may be partway through the
    // sentence still being synthesised. Its length is unknown, so estimate from audio
    // duration at a rate chosen to under-credit.
    const live = current.inFlight;
    if (live !== null && current.bytesHeard > live.startByte) {
      const msHeard = durationMs(current.bytesHeard - live.startByte, stream.format);
      const chars = Math.floor((msHeard / 1000) * CHARS_PER_SECOND);
      const prefix = toWordBoundary(live.text, Math.min(chars, live.text.length));
      if (prefix.length > 0) parts.push(prefix);
    }
    return parts.join(" ").trim();
  };

  const commitHeard = (current: AgentTurn): void => {
    conversation.recordAgentTurn(current.seq, heardText(current));
  };

  /** Retry counter per sentence, so a transient TTS failure costs one repeat, not the turn. */
  const attempts = new Map<string, number>();

  const speakNext = (current: AgentTurn): void => {
    // One synthesis at a time. Starting the next sentence before the previous finishes
    // interleaves two audio streams at the carrier, which is heard as garbled speech.
    if (current.synthesis !== null) return;
    const sentence = current.queue.shift();
    if (sentence === undefined) return;

    const attempt = attempts.get(sentence) ?? 0;
    const startByte = current.bytesSent;
    let markedAt = current.bytesSent;
    current.inFlight = { text: sentence, startByte };

    mark("tts_first_byte");
    const synthesis = deps.tts.synthesize({
      text: deps.forSpeech(sentence),
      voiceId: deps.voiceId,
      format: stream.format,
    });
    current.synthesis = synthesis;

    let first = true;
    synthesis.onAudio((chunk) => {
      if (turn?.seq !== current.seq) return;
      if (first) {
        first = false;
        current.sentenceAudioAt = Date.now();
        // The agent is speaking for real now; no acknowledgement should land on top.
        cancelFiller();
        cancelWatchdog();
        measure("tts_first_byte", { seq: current.seq });
        // Once per turn: the first byte of the first sentence is when the caller stops
        // waiting. Later sentences are already covered by the earlier audio.
        if (startByte === 0) measure("turn_to_audio", { seq: current.seq });
      }
      stream.send(chunk);
      current.bytesSent += chunk.data.length;

      // Sub-sentence marks, roughly every 200ms of audio. Without them a mid-sentence
      // interruption has no evidence the caller heard anything at all.
      if (durationMs(current.bytesSent - markedAt, stream.format) >= 200) {
        markedAt = current.bytesSent;
        stream.mark(`${current.seq}:${current.bytesSent}`);
      }
    });

    synthesis.onDone(() => {
      if (turn?.seq !== current.seq) return;
      current.synthesis = null;
      current.inFlight = null;
      current.spoken.push({ text: sentence, startByte, endByte: current.bytesSent });
      // The mark carries a byte position, so when the carrier echoes it back we know
      // how much audio the caller actually heard rather than how much we sent.
      stream.mark(`${current.seq}:${current.bytesSent}`);
      speakNext(current);
    });

    synthesis.onError((error) => {
      // A stale turn must stop walking its queue, the same guard onAudio and onDone have.
      if (turn?.seq !== current.seq) return;
      log.error("tts failed", { seq: current.seq, error: error.message, attempt });
      current.synthesis = null;
      current.inFlight = null;

      if (attempt === 0) {
        // One retry. Transient failures are common on this path and re-saying the
        // sentence is cheaper to the caller than losing it.
        current.queue.unshift(sentence);
        attempts.set(sentence, 1);
        speakNext(current);
        return;
      }

      attempts.delete(sentence);
      speakNext(current);
      if (current.bytesSent === 0 && current.queue.length === 0 && current.synthesis === null) {
        // Nothing was said and nothing can be: do not synthesise a fallback through the
        // provider that just failed twice. An open silent line is worse than ending.
        log.error("turn produced no audio, ending the call", { seq: current.seq });
        turn = null;
        stream.hangUp();
        return;
      }
      // If the queue is now empty no mark will ever arrive, and without this the turn
      // stays open forever and the agent never speaks again.
      finishIfComplete(current);
    });
  };

  /**
   * A turn is over only when the model has stopped writing, nothing is queued, nothing
   * is synthesising, and the caller has heard all of it. Called from every path that
   * could satisfy that — a mark arriving, the model finishing, a synthesis failing —
   * because whichever happens last is the one that closes the turn.
   */
  const finishIfComplete = (current: AgentTurn): void => {
    if (turn?.seq !== current.seq) return;
    if (!current.llmDone) return;
    if (current.queue.length > 0 || current.synthesis !== null) return;
    if (current.bytesHeard < current.bytesSent) return;

    log.info("agent turn played", {
      seq: current.seq,
      ms: Math.round(durationMs(current.bytesHeard, stream.format)),
    });
    turn = null;
  };

  const enqueue = (current: AgentTurn, sentence: string): void => {
    // The window holds what TTS was actually given, so the comparison is against the
    // words that were spoken — including the "An-Sah" respelling, which is what a
    // transcriber will hear.
    spokenWindow = `${spokenWindow} ${deps.forSpeech(sentence)}`.slice(-400);
    current.queue.push(sentence);
    speakNext(current);
  };

  // ---- barge-in ------------------------------------------------------------
  const stopSpeaking = (reason: string): void => {
    const current = turn;
    if (current === null) return;
    turn = null;

    // Order matters: stop producing before discarding, or audio synthesised in the gap
    // lands at the carrier after the clear and plays over the caller.
    current.cancelLlm?.();
    current.synthesis?.cancel();
    current.queue.length = 0;
    cancelFiller();
    cancelWatchdog();
    stream.clear();

    commitHeard(current);
    log.info("barge-in", {
      reason,
      seq: current.seq,
      msHeard: Math.round(durationMs(current.bytesHeard, stream.format)),
      msDiscarded: Math.round(
        durationMs(Math.max(0, current.bytesSent - current.bytesHeard), stream.format),
      ),
    });
  };

  stream.onMark((name) => {
    const current = turn;
    if (current === null) return;
    const [seq, chars] = name.split(":");
    if (Number(seq) !== current.seq) return;

    current.bytesHeard = Math.max(current.bytesHeard, Number(chars) || 0);
    commitHeard(current);
    finishIfComplete(current);
  });

  deps.listen.turns.onSpeechStart((event) => {
    const current = turn;
    if (current !== null && current.sentenceAudioAt !== null) {
      const speakingFor = Date.now() - current.sentenceAudioAt;
      if (speakingFor < guardMs) {
        // Almost certainly our own audio returning through the caller's handset. A
        // caller cannot react to speech they have not finished hearing.
        //
        // Remember the segment: its transcript is still coming, and answering that is
        // how the agent ends up talking to itself.
        echoSegments.add(event.offsetMs);
        log.debug("ignored speech start inside barge-in guard", { speakingFor });
        return;
      }
    }
    // The agent has made no sound yet, so there is nothing to interrupt. Tearing the
    // turn down here would cancel an LLM that was milliseconds from its first token —
    // the dead air manufacturing the interruption that deletes the answer.
    if (current !== null && current.sentenceAudioAt === null) {
      log.debug("caller spoke while the agent was still thinking", {
        offsetMs: event.offsetMs,
      });
      return;
    }

    log.debug("caller speech start", { offsetMs: event.offsetMs });
    if (current !== null) stopSpeaking("caller interrupted");
  });

  deps.listen.turns.onEndOfTurn(() => {
    mark("stt_final");
    // The number R5.5 is actually written against: caller stops speaking -> agent
    // starts speaking. Everything else is a component of it.
    mark("turn_to_audio");
    // Fires 480-1200ms before the transcript does, so it is the earliest point at which
    // we know the caller has stopped and is waiting.
    armFiller();
  });

  // Recoverable. The vendor emits these for conditions that do not end a session, and
  // ending the call on one would drop conversations that were fine.
  deps.listen.onVendorError((message) => {
    log.warn("listen vendor error", { message });
  });

  // Not recoverable: no further transcript will ever arrive. An open line the agent
  // cannot hear is worse than a clean ending, so say nothing clever and hang up.
  // Commit 6 upgrades this to apologise first.
  deps.listen.onFailure((reason) => {
    log.error("listen connection lost, ending the call", { reason });
    stopSpeaking("listen connection lost");
    // Say something before going: an open line the agent cannot hear is worse than a
    // clean ending, but ending mid-air with no explanation is worse than either.
    sayRecovery("listen connection lost");
    const farewell = turn;
    if (farewell === null) {
      stream.hangUp();
      return;
    }
    stream.onMark(() => {
      if (farewell.bytesHeard >= farewell.bytesSent && farewell.bytesSent > 0) stream.hangUp();
    });
  });

  // ---- one caller turn -----------------------------------------------------
  /**
   * Opens a new turn purely to say something. Used when a turn produced nothing, so the
   * caller gets speech instead of a dead line. Routed through enqueue like any other
   * utterance so it is normalised, marked and remembered identically.
   */
  const sayRecovery = (reason: string): void => {
    if (turn !== null) return;
    turnSeq += 1;
    const recovery: AgentTurn = {
      seq: turnSeq,
      queue: [],
      synthesis: null,
      cancelLlm: null,
      bytesSent: 0,
      bytesHeard: 0,
      spoken: [],
      inFlight: null,
      llmDone: true,
      sentenceAudioAt: null,
    };
    turn = recovery;
    log.warn("speaking a recovery line", { reason, seq: recovery.seq });
    enqueue(recovery, RECOVERY_LINE);
  };

  const respondTo = (callerText: string): void => {
    // A transcript can arrive while the agent is still speaking — the echo guard
    // suppresses the speech-start but not the transcript behind it. Without this the
    // old turn is orphaned: its LLM and TTS keep streaming and billing, and the audio
    // already queued at the carrier (measured at ~1.8s on real calls) plays over the
    // new reply. Ordering matters: the heard text must be committed against the
    // assistant turn before the new caller message lands.
    if (turn !== null) stopSpeaking("superseded by caller turn");

    measure("stt_final", { chars: callerText.length });
    conversation.addCaller(callerText);

    turnSeq += 1;
    const seq = turnSeq;
    const current: AgentTurn = {
      seq,
      queue: [],
      synthesis: null,
      cancelLlm: null,
      bytesSent: 0,
      bytesHeard: 0,
      spoken: [],
      inFlight: null,
      llmDone: false,
      sentenceAudioAt: null,
    };
    turn = current;

    cancelWatchdog();
    watchdog = setTimeout(() => {
      if (turn?.seq !== seq) return;
      log.error("turn produced no audio in time", { seq });
      stopSpeaking("turn watchdog");
      sayRecovery("turn watchdog");
    }, TURN_WATCHDOG_MS);
    watchdog.unref();

    mark("llm_first_token");
    const sentences = createSentenceBuffer();
    const completion = deps.llm.complete({
      system: SYSTEM_PROMPT,
      messages: conversation.messages,
      // 80 rather than 60: below that the flushed tail is regularly a truncated
      // fragment and the caller hears a cut-off word.
      maxTokens: 80,
    });
    current.cancelLlm = () => {
      completion.cancel();
    };

    let firstToken = true;
    let sentencesSpoken = 0;
    completion.onDelta((token) => {
      if (turn?.seq !== seq) return;
      if (firstToken) {
        firstToken = false;
        measure("llm_first_token", { seq });
      }
      for (const sentence of sentences.push(token)) {
        if (sentencesSpoken >= MAX_SENTENCES_PER_TURN) {
          log.info("capped an over-long turn", { seq, sentences: sentencesSpoken });
          current.llmDone = true;
          current.cancelLlm?.();
          return;
        }
        sentencesSpoken += 1;
        enqueue(current, sentence);
      }
    });

    completion.onDone((full) => {
      if (turn?.seq !== seq) return;
      current.llmDone = true;
      const tail = sentences.flush();
      // A tail with no terminal punctuation is a truncated fragment, not a sentence.
      // Speaking it means the caller hears the reply stop mid-word.
      const isFragment = tail.length < 15 && !/[.!?]$/.test(tail);
      if (tail.length > 0 && !isFragment && sentencesSpoken < MAX_SENTENCES_PER_TURN) {
        enqueue(current, tail);
      }
      log.info("agent turn", { seq, chars: full.length });
      // Nothing to say and nothing queued: without this a turn with no audio at all
      // would never close.
      finishIfComplete(current);
    });

    completion.onError((error) => {
      if (turn?.seq !== seq) return;
      log.error("llm failed", { seq, error: error.message });
      // Cancels the in-flight synthesis rather than letting it stop mid-word behind a
      // guard, and clears whatever is queued at the carrier.
      stopSpeaking("llm failed");
      sayRecovery("llm failed");
    });
  };

  /** Compare speech the way a transcriber renders it: no case, no punctuation. */
  const normalise = (text: string): string =>
    text
      .toLowerCase()
      .replace(/[^a-z0-9 ]+/g, " ")
      .replace(/\s+/g, " ")
      .trim();

  deps.listen.transcripts.onFinal((transcript) => {
    const text = transcript.text.trim();
    // Silence and line noise transcribe as a stray mark or a single letter. Answering
    // those produces a conversation with itself.
    if (text.length < 2) {
      log.debug("ignored empty transcript", { text });
      return;
    }

    // Layer 1: this segment's speech-start was already judged to be echo. Exact match,
    // because both numbers are the same offset from the same event.
    if (echoSegments.delete(transcript.offsetMs)) {
      log.info("ignored echoed agent audio", { text, offsetMs: transcript.offsetMs });
      return;
    }

    // Backchannel while the agent is speaking is listening, not interrupting.
    if (turn !== null && BACKCHANNEL.has(normalise(text))) {
      log.debug("ignored backchannel", { text });
      return;
    }

    // Layer 2: the guard only covers segments whose speech-start it saw. This catches
    // the rest by content — but only against our own recent words, never as a blanket
    // "ignore transcripts while speaking", which would swallow real barge-in.
    if (turn !== null) {
      const heardBack = normalise(text);
      if (heardBack.length > 0 && normalise(spokenWindow).includes(heardBack)) {
        log.info("ignored transcript matching our own speech", { text });
        return;
      }
      // Whatever this is, it is worth seeing: it tells us on the next call whether the
      // filter above is over- or under-firing.
      log.info("transcript during agent audio", { text, spokenWindow });
    }

    log.info("caller said", { text, offsetMs: transcript.offsetMs });
    respondTo(text);
  });

  stream.onClosed((reason) => {
    cancelFiller();
    cancelWatchdog();
    echoSegments.clear();
    stopSpeaking("call ended");
    deps.listen.close();
    log.info("conversation ended", { reason, turns: turnSeq });
  });

  // ---- open the call -------------------------------------------------------
  turnSeq += 1;
  const greetingTurn: AgentTurn = {
    seq: turnSeq,
    queue: [],
    synthesis: null,
    cancelLlm: null,
    bytesSent: 0,
    bytesHeard: 0,
    spoken: [],
    inFlight: null,
    llmDone: true,
    sentenceAudioAt: null,
  };
  turn = greetingTurn;

  const cached = deps.greetingAudio ?? null;
  if (cached !== null && cached.length > 0) {
    // Pre-rendered: the caller hears the greeting immediately rather than after a
    // network round trip. Accounting mirrors the live path exactly so barge-in, marks
    // and history behave identically.
    greetingTurn.sentenceAudioAt = Date.now();
    spokenWindow = `${spokenWindow} ${deps.forSpeech(deps.greeting)}`.slice(-400);
    let markedAt = 0;
    for (const chunk of cached) {
      stream.send(chunk);
      greetingTurn.bytesSent += chunk.data.length;
      if (durationMs(greetingTurn.bytesSent - markedAt, stream.format) >= 200) {
        markedAt = greetingTurn.bytesSent;
        stream.mark(`${greetingTurn.seq}:${greetingTurn.bytesSent}`);
      }
    }
    greetingTurn.spoken.push({
      text: deps.greeting,
      startByte: 0,
      endByte: greetingTurn.bytesSent,
    });
    stream.mark(`${greetingTurn.seq}:${greetingTurn.bytesSent}`);
  } else {
    // The greeting commits through the same recorder as every other turn. That asymmetry
    // is what hid the history bug: it was the one utterance added before it was spoken.
    enqueue(greetingTurn, deps.greeting);
  }
  log.info("conversation started");
};
