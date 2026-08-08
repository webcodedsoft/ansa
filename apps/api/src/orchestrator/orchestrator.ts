import type { LlmProvider } from "@ansa/llm";
import type { TranscriberSession } from "@ansa/transcriber";
import type { TurnSession } from "@ansa/turn-detector";
import type { AudioChunk, Logger } from "@ansa/shared";
import type { CallMediaStream } from "@ansa/telephony";
import { durationMs, type SynthesisStream, type TtsProvider } from "@ansa/tts";

import { createFillerPicker } from "../telephony/filler";
import { classify } from "./action";
import { advance, idle, nameFrom, worthConfirming, type CaptureState } from "./capture";
import { endsMidThought } from "./completeness";
import { createSpeechGate } from "./speech-gate";
import { nullRecorder, type CallRecorder } from "../telephony/event-log";
import { parseSpokenDigits } from "@ansa/normalizer";
import { createConversation } from "./conversation";
import { interpret, normalise } from "./hearing";
import { budgetFor, budgetMs } from "./turn-budget";
import { createSentenceBuffer } from "./sentences";
import { SYSTEM_PROMPT } from "./system-prompt";

/**
 * Everything the orchestrator needs in order to listen, and nothing about who is
 * providing it.
 *
 * Declared here rather than imported from a vendor package, because the orchestrator
 * previously imported `OpenAiListenSession` by name — a vendor word in orchestration
 * code, which is precisely what CLAUDE.md rule 2 exists to prevent. Both adapters
 * satisfy this structurally, so swapping providers is a config value.
 *
 * The two streams stay separate: they are correlated by offsetMs and nothing here lets
 * the orchestrator assume they share a connection (R4.1.7), even though today they do.
 */
export interface ListenSession {
  readonly transcripts: TranscriberSession;
  readonly turns: TurnSession;
  write(chunk: AudioChunk): void;
  onFailure(listener: (reason: string) => void): void;
  onVendorError(listener: (message: string) => void): void;
  close(): void;
}

export interface OrchestratorDeps {
  readonly listen: ListenSession;
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
   * Pre-rendered filler audio by phrase. Played into the thinking gap; empty disables it.
   * Keyed by phrase so the orchestrator can choose a register rather than a queue
   * position — an acknowledgement first, a progress line once the wait is real.
   */
  readonly fillers?: ReadonlyMap<string, readonly AudioChunk[]>;
  /** Phrase pools, in the order they are used as a turn drags on. */
  readonly fillerTiers?: readonly (readonly string[])[];
  /** Play the first filler if no reply audio has gone out this long after end-of-turn. */
  readonly fillerAfterMs?: number;
  /** Speak a recovery line if the caller finishes and no transcript arrives in time. */
  readonly transcriptWatchdogMs?: number;
  /**
   * Least speech that can produce a real transcript. Zero disables the check, which is
   * what most orchestrator tests want: they drive transcripts directly to exercise turn
   * logic and never fan in audio at all.
   */
  readonly minSpeechMs?: number;
  /**
   * Audio the carrier delivered before this conversation was constructed.
   *
   * Outbound meets its tenant on the media socket and has to load configuration before a
   * listen session can be opened with the right vocabulary. Frames arriving in that
   * window used to be dropped: a fast lookup makes the window small, but "small" is not
   * "cannot lose a word", and only replaying them makes that true.
   */
  readonly initialAudio?: readonly AudioChunk[];
  /**
   * Writes the call down. Defaults to doing nothing, so a deployment without a database
   * behaves exactly as before and every existing test stays valid.
   */
  readonly recorder?: CallRecorder;
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

/** At most this many words is an opener ("Okay.", "Yes, it is."), not a whole answer. */
const INTERJECTION_WORDS = 3;

const countWords = (text: string): number =>
  text.split(/\s+/).filter((w) => w.length > 0).length;

/** First acknowledgement. Early enough that the caller never hears a full second of nothing. */
const DEFAULT_FILLER_AFTER_MS = 450;
/** Progress, not another acknowledgement. R6.2's two-second rule, made literal. */
const SECOND_FILLER_AFTER_MS = 2200;
/** Well past comfortable: acknowledge the wait rather than pretend it is normal. */
const THIRD_FILLER_AFTER_MS = 4500;

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
/**
 * How long to wait for a caller to finish a sentence the detector cut short.
 *
 * Bounded by the no-silence rule: this plus the filler delay must stay under two
 * seconds, and it only ever applies to a turn that could not be answered sensibly.
 */
const CONTINUATION_WAIT_MS = 1_100;

/** One carrier frame. */
const FRAME_MS = 20;

/**
 * The least speech that can produce a real transcript.
 *
 * Every transcriber tried has invented fluent text from silence and line noise, each
 * with the language pinned to English: Deepgram returned Malayalam and Māori, OpenAI
 * returned "Ay, mi nombre es Pikachu" and a sentence of Japanese. Three vendors failing
 * identically is not three vendor bugs — Whisper-family models are trained to emit text,
 * so given nothing they emit something.
 *
 * Filtering on the text cannot work. "Not latin script" caught the Japanese; nothing
 * catches "Pikachu" or "Biology is that again?", because a hallucination that happens to
 * be plausible English is indistinguishable downstream. The only durable signal is
 * whether the caller actually made a sound.
 *
 * 160ms is deliberately below the shortest real turn that matters — a bare "no" runs
 * about 300ms — because the costs are not symmetric. Dropping a real transcript costs
 * one "sorry, I didn't catch that". Accepting an invented one derails the call.
 */
const MIN_SPEECH_MS = 160;

const TURN_WATCHDOG_MS = 4_000;

/**
 * The caller stopped speaking and no transcript ever arrived.
 *
 * Seen on a live call: speech produced an end-of-turn, two fillers played, and then ten
 * seconds of nothing, because the watchdog was armed inside respondTo — which only runs
 * once a transcript exists. The case that most needs a safety net was the one case
 * without one. Longer than the turn watchdog because a slow transcript is still coming.
 */
const TRANSCRIPT_WATCHDOG_MS = 5_000;

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
/**
 * "Sorry, what?", "come again", "I didn't catch that" — the caller did not hear, and
 * wants the same thing again rather than a new answer.
 *
 * Two tiers, because the first version of this only matched the WHOLE utterance and so
 * caught almost nothing in practice. Real repair requests arrive inside longer turns —
 * "Sorry, I didn't hear you. Can you say that again?" — especially now the transcriber
 * returns multi-sentence turns rather than fragments.
 */

/**
 * Distinctive enough to match anywhere in a turn. None of these appear in an ordinary
 * question, so a substring match cannot hijack a real request.
 */
const REPAIR_PHRASES: readonly string[] = [
  "repeat that",
  "repeat it",
  "say that again",
  "say it again",
  "said that again",
  "come again",
  "one more time",
  "what did you say",
  "what did you just say",
  "what was that",
  "didn t hear",
  "did not hear",
  "didn t catch",
  "did not catch",
  // Deliberately absent: "did not get that". It means "did not receive" at least as
  // often as "did not hear" — "I did not get that discount you mentioned" is a real
  // question, and a caught test proved the substring hijacks it. "catch" and "hear" are
  // unambiguous; the prompt covers the phrasings this list misses.
  "couldn t hear",
  "could not hear",
  "can t hear you",
  "cant hear you",
  "i missed that",
  // Pidgin, distinctive enough to match inside a longer turn.
  "wetin you talk",
  "wetin you say",
  "talk am again",
  "say am again",
  "i no hear you",
  "i no hear",
];

/**
 * Ambiguous on their own, so these must BE the whole utterance. "What can you do for
 * me" is a question; "what?" is a request to repeat.
 */
const REPAIR_ALONE = new Set([
  // NOT bare "sorry". In Nigerian English it is a sympathy token — "sorry o" to someone
  // who stubbed their toe — not an apology or a request to repeat. Treating it as repair
  // meant: agent refuses, caller says "sorry" meaning "that's a shame", and the agent
  // re-says the refusal they heard perfectly well.
  "sorry what",
  "pardon",
  "pardon me",
  "excuse me",
  "what",
  // "huh" is deliberately in BOTH this set and BACKCHANNEL, and the split is correct:
  // BACKCHANNEL is only consulted while the agent is speaking, so "huh" over the agent
  // is listening and "huh" into silence is repair.
  "huh",
  "again",
  "come again",
  // Pidgin repair. "wetin" alone is a repair; "wetin be my balance" is a question, which
  // is why it belongs here and not in the substring list.
  "wetin",
  "you say",
  "come again jare",
]);

/** `text` must already be normalised: lower case, punctuation stripped. */
const isRepairRequest = (text: string): boolean => {
  if (REPAIR_ALONE.has(text)) return true;
  return REPAIR_PHRASES.some((phrase) => text.includes(phrase));
};

const BACKCHANNEL = new Set([
  "mm", "mmm", "mhm", "mmhm", "hmm", "hm", "uh", "uh huh", "uhhuh", "huh",
  "yeah", "yep", "yes", "ok", "okay", "right", "sure", "aha", "ah", "oh", "i see",
  // Measured from ICE-Nigeria phone calls rather than assumed. Their real top tokens are
  // mhm, okay, yeah, yes, erm, eh, aha — and "uh-huh", which was in this list on the
  // strength of American intuition, does not appear in the top forty at all.
  "erm", "eh", "ehen", "eh heh", "ehen now", "na so", "no wahala", "okay o", "oya",
  "yes now", "correct", "true", "oh ho",
]);

/**
 * Nigerian pragmatic particles, whole-utterance only.
 *
 * "o" alone accounts for around a tenth of all question tags in the ICE-Nigeria spoken
 * corpus. Before this, a bare particle fell through to the model and burned a whole turn
 * — plus its latency — answering a token with no propositional content in it.
 */
const NIGERIAN_PARTICLES = new Set([
  "o", "sha", "abi", "sef", "ba", "na so", "no be so", "shey", "abeg",
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

  /**
   * The last thing the agent set out to say, in full — not what the caller heard.
   *
   * Conversation history deliberately holds only the heard portion, so replaying from
   * there would repeat the fragment they already got rather than the part they missed.
   * A repeat has to be of the intent.
   */
  let lastUtterance: string | null = null;

  /** Timers for the thinking-gap acknowledgements, cleared the moment real audio starts. */
  let fillerTimers: ReturnType<typeof setTimeout>[] = [];
  const pickFiller = createFillerPicker();

  let watchdog: ReturnType<typeof setTimeout> | null = null;
  const cancelWatchdog = (): void => {
    if (watchdog !== null) clearTimeout(watchdog);
    watchdog = null;
  };

  /**
   * A caller turn that ended mid-sentence, held back until they finish or the wait
   * expires. See completeness.ts for what this cost before it existed.
   *
   * The wait stays well under the two-second silence rule: 1100ms plus the 450ms filler
   * delay means sound within 1.55s, and only on turns that were syntactically impossible
   * to answer anyway.
   */
  let pending: { text: string; forModel: string; timer: NodeJS.Timeout } | null = null;

  const clearPending = (): void => {
    if (pending === null) return;
    clearTimeout(pending.timer);
    pending = null;
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
  const playFiller = (tier: readonly string[]): void => {
    // Never while the agent is already speaking.
    //
    // A filler is a thinking noise: it covers the gap before a reply exists. Once any
    // real audio has gone out it is not covering anything, it is interrupting. On a live
    // call the agent said "Let me make sure I have that right. Aditi. Have I got that?"
    // and then, mid-utterance, "Okay." and "One moment." — and promptly heard its own
    // filler back as a caller turn.
    //
    // The timers are armed at end-of-turn and a turn that never consults the model, like
    // a readback, was never cancelling them.
    if (turn !== null && turn.bytesSent > 0) return;

    // Never while a turn is being held for a continuation. The filler fires 450ms after
    // end-of-turn regardless of why we are silent, so on a live call the agent said
    // "Alright." into the pause it was deliberately leaving for the caller to finish
    // their name — the exact interruption the wait exists to prevent.
    if (pending !== null) return;

    const rendered = deps.fillers;
    if (rendered === undefined || rendered.size === 0) return;

    const available = tier.filter((phrase) => rendered.has(phrase));
    const phrase = pickFiller.next(available);
    if (phrase === null) return;
    const chunks = rendered.get(phrase);
    if (chunks === undefined) return;

    for (const chunk of chunks) stream.send(chunk);
    // Added to the spoken window so the echo filter recognises it coming back, but
    // never to bytesSent, never marked, never remembered: the agent did not say
    // anything it should be held to.
    spokenWindow = `${spokenWindow} ${phrase}`.slice(-400);
    log.debug("played thinking filler", { phrase });
  };

  const armFiller = (): void => {
    cancelFiller();
    const tiers = deps.fillerTiers ?? [];
    if (tiers.length === 0 || deps.fillers === undefined || deps.fillers.size === 0) return;

    const at = [deps.fillerAfterMs ?? DEFAULT_FILLER_AFTER_MS, SECOND_FILLER_AFTER_MS, THIRD_FILLER_AFTER_MS];
    fillerTimers = tiers.slice(0, at.length).map((tier, i) =>
      setTimeout(() => {
        playFiller(tier);
      }, at[i] ?? SECOND_FILLER_AFTER_MS),
    );
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
    const ms = Date.now() - started;
    log.info("latency", { stage, ms, ...extra });
    record.event("latency", { stage, ms, ...extra });
  };

  // ---- audio in: the single fan-out point ---------------------------------
  /**
   * Measures how much real speech the caller has produced, so a transcript that came
   * from silence can be recognised as invented.
   *
   * The audio itself is forwarded UNCHANGED. It is tempting to forward only the frames
   * the gate opens on, and for the transcriber alone that would be right — but with a
   * provider that serves both listen interfaces from one connection, withholding silence
   * starves the turn detector of the very thing it listens for, and end-of-turn never
   * fires. So the gate is a measurement here, not a valve.
   */
  const record = deps.recorder ?? nullRecorder;

  const speechGate = createSpeechGate();
  let speechMsSinceTranscript = 0;

  const takeAudio = (chunk: AudioChunk): void => {
    if (speechGate.push(chunk.data).length > 0) speechMsSinceTranscript += FRAME_MS;
    deps.listen.write(chunk);
  };

  // Replayed in order and through the same path, so the speech gate's noise floor and
  // the hallucination filter see the start of the call rather than beginning mid-stream.
  for (const chunk of deps.initialAudio ?? []) takeAudio(chunk);
  if ((deps.initialAudio?.length ?? 0) > 0) {
    log.info("replayed audio buffered before the listener opened", {
      frames: deps.initialAudio?.length ?? 0,
    });
  }

  stream.onAudio(takeAudio);

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
    record.event("barge-in", { reason, seq: current.seq });
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

    // The caller has finished and is owed a reply. If no transcript ever arrives — the
    // audio was unclear, or the vendor simply dropped it — nothing downstream will ever
    // run, and the filler buys two seconds before the line goes dead. respondTo
    // replaces this with its own watchdog the moment a transcript does arrive.
    cancelWatchdog();
    watchdog = setTimeout(() => {
      if (turn !== null) return;
      log.error("caller finished but no transcript arrived");
      sayRecovery("no transcript");
    }, deps.transcriptWatchdogMs ?? TRANSCRIPT_WATCHDOG_MS);
    watchdog.unref();
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
  /**
   * Readback state (R4.3.1). Lives for the whole call: a caller gives a policy number
   * early and a phone number later, and each has to be confirmed on its own terms.
   */
  let capture: CaptureState = idle;

  /**
   * Says something the model had no part in, superseding whatever is playing.
   *
   * Unlike sayRecovery this interrupts, because a readback is a reply to what the caller
   * just said and arriving after the next sentence would be worse than not arriving.
   */
  const sayNow = (text: string, reason: string): void => {
    if (turn !== null) stopSpeaking(reason);
    turnSeq += 1;
    const direct: AgentTurn = {
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
    turn = direct;
    // No model round trip is coming, so there is no gap for a filler to cover.
    cancelFiller();
    log.info("speaking without the model", { reason, seq: direct.seq, text });
    record.event("agent said", { reason, seq: direct.seq, text });
    enqueue(direct, text);
  };

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

  /**
   * Says the previous utterance again, without consulting the model.
   *
   * Faster than a normal turn by the whole LLM round trip (~700ms), which is the right
   * shape: someone who missed what you said wants it repeated now, not thought about.
   * It is also exactly what was said before rather than a fresh paraphrase, which is
   * what "sorry, what?" is asking for.
   */
  const repeatLast = (): void => {
    const text = lastUtterance;
    if (text === null) return;

    if (turn !== null) stopSpeaking("superseded by repeat request");
    turnSeq += 1;
    const repeat: AgentTurn = {
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
    turn = repeat;
    log.info("repeating the previous utterance", { seq: repeat.seq, chars: text.length });
    enqueue(repeat, text);
  };

  const respondTo = (callerText: string, forModel: string = callerText): void => {
    // What the caller just did decides how long the reply may be. A fixed cap cannot be
    // right for both "is it still active?" and "how do I make a claim?" — people vary
    // turn length enormously by what was asked, and so must this.
    const budget = budgetFor(classify(normalise(forModel)));
    // A transcript can arrive while the agent is still speaking — the echo guard
    // suppresses the speech-start but not the transcript behind it. Without this the
    // old turn is orphaned: its LLM and TTS keep streaming and billing, and the audio
    // already queued at the carrier (measured at ~1.8s on real calls) plays over the
    // new reply. Ordering matters: the heard text must be committed against the
    // assistant turn before the new caller message lands.
    if (turn !== null) stopSpeaking("superseded by caller turn");

    measure("stt_final", { chars: callerText.length });
    conversation.addCaller(forModel);

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
      // The instruction is the soft half. The word cap below is the half that holds.
      system: `${SYSTEM_PROMPT}\n\n${budget.instruction}`,
      messages: conversation.messages,
      // A guard against runaway generation, not a length control. A tight token cap
      // guillotines mid-clause and the caller hears a cut-off word.
      maxTokens: budget.maxTokens,
    });
    current.cancelLlm = () => {
      completion.cancel();
    };

    let firstToken = true;
    let sentencesSpoken = 0;
    let wordsSpoken = 0;
    completion.onDelta((token) => {
      if (turn?.seq !== seq) return;
      if (firstToken) {
        firstToken = false;
        measure("llm_first_token", { seq });
      }
      for (const sentence of sentences.push(token)) {
        // Words, not tokens, and not sentences alone: one long sentence is still too
        // long. Enforced here rather than asked for in the prompt, because prompts can
        // be talked out of things and dispatch paths cannot.
        // Words govern; sentences are only a secondary brake.
        //
        // Capping on the unit count alone cut three turns in ten off at a single word,
        // because the model opened with "Okay." and that interjection consumed the whole
        // allowance. A sentence boundary may only end a turn that has already said
        // enough to be an answer.
        const sentenceWords = countWords(sentence);

        // The decision is made with the whole sentence in hand, because a sentence
        // cannot be truncated mid-way without the caller hearing a cut-off word. So the
        // question is whether to speak this sentence at all, not where to stop inside it.
        //
        // The first sentence always goes: cutting a turn to nothing is worse than any
        // length. After that both limits must allow it, and the word check includes THIS
        // sentence — letting a 14-word sentence follow a 3-word one produced a 17-word
        // answer to a yes/no question.
        const wouldExceedWords = wordsSpoken + sentenceWords > budget.maxWords;
        const outOfUnits = sentencesSpoken >= budget.maxUnits;
        if (wordsSpoken > 0 && (wouldExceedWords || outOfUnits)) {
          log.info("turn capped", {
            seq,
            action: budget.action,
            wordsSpoken,
            budgetWords: budget.maxWords,
          });
          current.llmDone = true;
          current.cancelLlm?.();
          return;
        }

        // "Okay." or "Sure." is an opener, not an answer, so it does not consume a unit.
        // Three turns in ten were cut off at a single word because it did.
        if (sentenceWords > INTERJECTION_WORDS) sentencesSpoken += 1;
        wordsSpoken += sentenceWords;
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
      if (
        tail.length > 0 &&
        !isFragment &&
        sentencesSpoken < budget.maxUnits &&
        wordsSpoken < budget.maxWords
      ) {
        enqueue(current, tail);
      }
      lastUtterance = full.trim().length > 0 ? full.trim() : lastUtterance;
      // The text, not just its length. Judging whether a call felt human is impossible
      // from a character count, and Slice 4a's review loop needs the words anyway.
      log.info("agent turn", {
        seq,
        text: full.trim(),
        words: full.trim().split(/\s+/).filter((w) => w.length > 0).length,
        action: budget.action,
        budgetWords: budget.maxWords,
        budgetMs: budgetMs(budget, 15),
      });
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

  /**
   * Applies the readback gate to a caller turn.
   *
   * Returns true when capture has taken the turn, in which case the model must not run:
   * a number under confirmation is not yet a fact, and letting the model answer around
   * it is exactly the failure R4.3.1 exists to prevent.
   */
  const captureHandled = (text: string, forModel: string): boolean => {
    // Whether to engage capture at all. The state machine decides what to do once it is
    // engaged; this decides whether the turn is worth confirming in the first place.
    //
    // A name always is. Nigerian names cannot be transcribed reliably on this channel and
    // keyterms cannot help — the caller's name is unknown by definition, so there is
    // nothing to boost. Confirming is the only way to discover we heard it wrong.
    if (capture.kind === "idle" && nameFrom(text) === null) {
      const value = parseSpokenDigits(text);
      if (value === null || !worthConfirming(value, text)) return false;
    }

    const result = advance(capture, { kind: "speech", text });
    capture = result.state;

    if (result.captured !== null) {
      capture = idle;
      log.info("value confirmed by the caller", { chars: result.captured.length });
      record.event("value confirmed", { chars: result.captured.length });
      // The model finally sees the value, and sees it as confirmed. Routed through
      // respondTo so it is recorded, budgeted and spoken like any other turn.
      const asName = /^[A-Za-z][A-Za-z' -]*$/.test(result.captured);
      respondTo(
        text,
        asName
          ? `Yes, that is right. My name is ${result.captured}.`
          : `Yes, that is correct. My number is ${result.captured}.`,
      );
      return true;
    }

    // Recorded here because respondTo is not running for this turn, and a history with
    // the agent's readback but not the caller's number makes no sense to the model.
    conversation.addCaller(forModel);

    if (capture.kind === "escalate") {
      // Nothing to transfer to yet — Slice 6 owns the warm handoff. Saying so and
      // logging it beats pretending the transfer happened.
      log.error("capture failed, caller needs a human", { text });
      record.event("escalated to a human", { text });
    }

    if (result.say !== null) sayNow(result.say, `readback:${capture.kind}`);
    return true;
  };

  /**
   * Keypad tones (R4.3.3). Ignored unless the keypad was actually offered — a caller who
   * fidgets with their phone mid-sentence must not have it read as a reference.
   */
  stream.onDigit((digit) => {
    if (capture.kind !== "keypad") {
      log.debug("ignored keypad tone outside capture", { digit });
      return;
    }

    // They are typing, so anything still playing is in the way.
    if (turn !== null) stopSpeaking("caller is using the keypad");

    const result = advance(capture, { kind: "keypad", digit });
    capture = result.state;

    if (result.captured !== null) {
      capture = idle;
      log.info("value entered on the keypad", { chars: result.captured.length });
      respondTo(result.captured, `My number is ${result.captured}.`);
      return;
    }
    if (result.say !== null) sayNow(result.say, "keypad");
  });

  deps.listen.transcripts.onFinal((transcript) => {
    const speechMs = speechMsSinceTranscript;
    speechMsSinceTranscript = 0;

    if (speechMs < (deps.minSpeechMs ?? MIN_SPEECH_MS)) {
      log.warn("discarded a transcript with no speech behind it", {
        text: transcript.text,
        speechMs,
      });
      // Kept deliberately. A hallucination the filter caught is the clearest evidence
      // the R9.2 review queue could have, and it exists nowhere else.
      record.event("hallucination discarded", { text: transcript.text, speechMs });
      return;
    }

    const heard = interpret(transcript.text);
    if (heard.kind === "noise") {
      // Conservative on purpose: letting noise through wastes one turn, but ignoring a
      // caller who spoke makes the agent look like it is not listening.
      log.info("ignored non-speech", { reason: heard.reason, text: transcript.text });
      return;
    }
    const text = heard.raw;

    // Layer 1: this segment's speech-start was already judged to be echo. Exact match,
    // because both numbers are the same offset from the same event.
    if (echoSegments.delete(transcript.offsetMs)) {
      log.info("ignored echoed agent audio", { text, offsetMs: transcript.offsetMs });
      return;
    }

    const flat = normalise(text);

    // Backchannel while the agent is speaking is listening, not interrupting.
    if (turn !== null && BACKCHANNEL.has(flat)) {
      log.debug("ignored backchannel", { text });
      return;
    }

    // A bare particle carries no proposition to answer. Checked before repair, because
    // "eh" as a continuer used to fall through and make the agent repeat itself.
    if (NIGERIAN_PARTICLES.has(flat)) {
      log.debug("ignored bare particle", { text, speaking: turn !== null });
      return;
    }

    // Layer 2: the guard only covers segments whose speech-start it saw. This catches
    // the rest by content — but only against our own recent words, never as a blanket
    // "ignore transcripts while speaking", which would swallow real barge-in.
    if (turn !== null) {
      const heardBack = flat;
      if (heardBack.length > 0 && normalise(spokenWindow).includes(heardBack)) {
        log.info("ignored transcript matching our own speech", { text });
        return;
      }
      // Whatever this is, it is worth seeing: it tells us on the next call whether the
      // filter above is over- or under-firing.
      log.info("transcript during agent audio", { text, spokenWindow });
    }

    // The caller did not hear us. Say it again rather than answering something else —
    // and do it without a model round trip, because they want it now.
    if (lastUtterance !== null && isRepairRequest(flat)) {
      log.info("caller asked us to repeat", { text });
      conversation.addCaller(text);
      repeatLast();
      return;
    }

    // The raw text is logged and stored — it is the eval corpus and the review loop's
    // ground truth. Only the model sees the repaired version.
    log.info("caller said", { text, offsetMs: transcript.offsetMs });
    // The raw text, never the repaired one: this is the eval corpus ground truth (R9.2.3).
    record.event("caller said", { text, corrections: heard.corrections }, transcript.offsetMs);
    if (heard.corrections.length > 0) {
      log.info("repaired a known mishearing", { corrections: heard.corrections });
    }

    // Rejoin a turn the detector split. The fragments are concatenated rather than
    // answered separately, because the caller said one thing and a reply to half of it
    // is a reply to something they did not say.
    const carried = pending;
    clearPending();
    const whole = carried === null ? text : `${carried.text} ${text}`;
    const wholeForModel =
      carried === null ? heard.forModel : `${carried.forModel} ${heard.forModel}`;

    // Never hold a turn back while a number is being confirmed. "No" and "yes" are
    // complete answers, and a caller correcting a digit must not be made to wait.
    if (capture.kind === "idle" && endsMidThought(normalise(whole))) {
      log.info("caller has not finished, waiting", { text: whole });
      cancelFiller();
      const timer = setTimeout(() => {
        pending = null;
        log.info("caller did not continue, answering what we have", { text: whole });
        if (!captureHandled(whole, wholeForModel)) respondTo(whole, wholeForModel);
      }, CONTINUATION_WAIT_MS);
      timer.unref();
      pending = { text: whole, forModel: wholeForModel, timer };
      return;
    }

    // Before the model, never after. R4.3.1 is a gate, and a gate the model can answer
    // around is not a gate.
    if (captureHandled(whole, wholeForModel)) return;

    respondTo(whole, wholeForModel);
  });

  stream.onClosed((reason) => {
    clearPending();
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
  lastUtterance = deps.greeting;

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
