import type { LlmProvider } from "@ansa/llm";
import type { TranscriberSession } from "@ansa/transcriber";
import type { TurnSession } from "@ansa/turn-detector";
import type { AudioChunk, BusinessHours, CallDirection, Logger, OrganizationId } from "@ansa/shared";
import type { CallMediaStream } from "@ansa/telephony";
import { durationMs, type SynthesisStream, type TtsProvider } from "@ansa/tts";
import {
  modelMessage,
  type HoldingSpeech,
  type ToolArgs,
  type ToolDispatcher,
  type ToolRegistry,
} from "@ansa/tools";

import { ACKNOWLEDGEMENTS, createFillerPicker } from "../telephony/filler";
import { createSilenceFill } from "../telephony/silence-fill";
import { classify } from "./action";
import {
  advance,
  expecting,
  confirmedUtterance,
  idle,
  isAffirmative,
  type CaptureState,
  type EntityKind,
} from "./capture";
import type { CallerHistory } from "@ansa/db";

import type { CallFactsStore, IdentifierField } from "../conversation/call-facts";
import type { CollectedField } from "../tenancy/captured-fields";
import { createForm } from "./form";
import { renderFacts } from "../conversation/facts-prompt";
import { OUTBOUND_LAYER } from "../prompts/outbound";
import {
  createReadStripper,
  parseRead,
  renderRead,
  type EmotionalRead,
} from "../conversation/emotional-read";
import { describeSituation, renderSituation } from "../conversation/situation";
import { asksToNotBeCalled } from "../outbound/stop-calling";
import { computeConstraints, type TurnConstraints } from "./dialogue-policy";
import { driftIn } from "./drift";
import { guardOutput, HOLDING_LINE } from "./output-guard";
import type { Handoff } from "../handoff/handoff";
import { createEscalationWatch, type EscalationTrigger } from "../handoff/triggers";
import { asksAfterYou, COURTESY_REPLIES, withCourtesy } from "./courtesy";
import { endsMidThought, isBareGreeting } from "./completeness";
import { createSpeechGate } from "./speech-gate";
import { nullRecorder, type CallRecorder } from "../telephony/event-log";
import { createConversation } from "./conversation";
import { interpret, normalise } from "./hearing";
import { budgetFor, budgetMs } from "./turn-budget";
import { createSentenceBuffer } from "./sentences";
import { createCallState } from "./call-state/machine";

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

/**
 * The two things a tool set needs that only the orchestrator can supply.
 *
 * Both are about timing rather than about tools. Holding speech has to begin when the
 * tool is dispatched and not when it returns, and a call can only end once the caller has
 * actually heard the goodbye — and the orchestrator is the only thing that knows when a
 * sentence has been heard, because it is the only thing that sees the marks.
 */
export interface ToolHooks {
  /** R5.4.2. Passed to the dispatcher, which calls it before the adapter runs. */
  readonly holding: HoldingSpeech;
  /**
   * The caller is finished. Hangs up once the last words have played out, never
   * immediately: audio queued at the carrier is measured at ~1.8s on this project's own
   * calls, and hanging up on top of it deletes the goodbye.
   */
  readonly endCall: (reason: string) => void;
}

/** This call's registry and dispatcher. Both per call — see the note in `makeTools`. */
export interface CallTools {
  readonly registry: ToolRegistry;
  readonly dispatcher: ToolDispatcher;
}

export interface OrchestratorDeps {
  readonly listen: ListenSession;
  readonly llm: LlmProvider;
  readonly tts: TtsProvider;
  readonly voiceId: string;
  /**
   * Undefined leaves the voice at its own pace, which is the default for every agent.
   *
   * Required rather than optional, and that distinction is the reason this comment exists.
   * It was optional and the gateway simply never passed it, so the rate was stored,
   * versioned, diffed and shown in the console, the adapter had a branch to send it, and no
   * call ever used one. Nothing failed, because an object missing an optional field is a
   * valid object. Writing `undefined` here is one word; forgetting the pace of every call
   * cost this feature entirely.
   */
  readonly speakingRate: number | undefined;
  readonly log: Logger;
  readonly greeting: string;
  /**
   * The composed system prompt for this call — base, locale, organization, task. The turn layer
   * is appended per turn below, which is how it already worked.
   *
   * Required, not defaulted. A organization's persona has been loaded, validated and composed on
   * every config load since the prompt layers landed, and the orchestrator used the
   * default anyway; a field with a fallback is how that happens again quietly.
   */
  readonly systemPrompt: string;
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
   * Whether the caller may cut the agent off mid-sentence (migration 0020).
   *
   * Defaults to true, which is how every call behaved before this was settable and how a
   * person expects a telephone to work. False is for the line that must finish saying
   * something before it stops — a disclosure, a confirmation being read back.
   *
   * Turning it off does not stop us LISTENING while the agent speaks; the transcript still
   * arrives and the turn still commits at the end of it. It only stops the audio being
   * torn down mid-sentence, which is the part a caller experiences as being interrupted.
   */
  readonly bargeIn?: boolean;
  /**
   * The agent's configured form (migration 0021), in the order it asks.
   *
   * Absent or empty leaves capture exactly as it was — reactive, driven by `classify`, and
   * routed through the two built-in identifiers. That is what every agent without a form
   * gets, and it must stay identical or this change breaks calls that worked.
   */
  readonly fields?: readonly CollectedField[];
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
  /** See `STALLED_TURN_MS`. The caller is talking and no turn boundary is arriving. */
  readonly stalledTurnMs?: number;
  /**
   * Least speech that can produce a real transcript. Zero disables the check, which is
   * what most orchestrator tests want: they drive transcripts directly to exercise turn
   * logic and never fan in audio at all.
   */
  readonly minSpeechMs?: number;
  /**
   * Audio the carrier delivered before this conversation was constructed.
   *
   * Outbound meets its organization on the media socket and has to load configuration before a
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
  /** Named on every transcript, so a corpus can tell which provider produced what. */
  readonly listenProvider?: string;
  /**
   * Model, language and endpointing, exactly as configured. Opaque on purpose: the
   * orchestrator must not learn a vendor's settings vocabulary, it only has to record it.
   */
  readonly transcriptionConfig?: Readonly<Record<string, string | number | boolean>>;
  /**
   * What the agent knows about this call, and how well it knows it.
   *
   * Constructed by the gateway rather than here, because the organization is resolved on the
   * media socket and the orchestrator has never needed to know it. Absent on a call whose
   * number has no organization configuration — the same calls for which the recorder is already
   * skipped.
   */
  readonly facts?: CallFactsStore;
  /**
   * When this organisation's own line is staffed, in WAT.
   *
   * Already resolved for the business-hours tool; the situation block reads the same value,
   * so the agent's sense of the hour and the answer it gives when asked cannot disagree.
   * Null means the organisation configured none, and the block then says nothing about
   * opening hours rather than inventing a nine to five.
   *
   * Required and nullable rather than optional, for the same reason `organizationId` below
   * is: an optional field on this interface is a wire a construction site can forget, and
   * the symptom is not a compile error but an agent that quietly never knows the time. A
   * deployment with no hours has to say so.
   */
  /**
   * Who rang whom.
   *
   * Required and nullable-free, like `organizationId`: an optional direction defaults to
   * inbound, and the failure is an outbound call conducted with an inbound agent's
   * instructions — one that asks a stranger to confirm their date of birth. That is the
   * single worst thing this codebase can do, so it is not a wire anybody may forget.
   */
  /**
   * Whether to make small noises while the caller is still talking.
   *
   * Off unless a deployment turns it on, and that default is deliberate rather than
   * cautious boilerplate. Their absence is a real part of why calls feel like walkie-talkie
   * exchanges — but the failure mode when the gate below is wrong is the agent reacting to
   * its own noise, which is the barge-in defect Phase 2 removed, rebuilt by the feature
   * meant to make calls warmer. It is off until somebody has heard it on a phone.
   */
  readonly backchannel?: boolean;
  readonly direction: CallDirection;
  readonly businessHours: BusinessHours | null;
  /**
   * What this number has done before, or null when it is not known.
   *
   * A getter and not a value, because the read is started as the call connects and this is
   * read on every turn — the greeting is playing while it is in flight, so turn one may
   * find it and may not. Null covers a withheld number, no database, a read still running
   * and a read that failed, and the agent's correct behaviour is identical in all four.
   *
   * A function rather than a promise on purpose. A promise invites an `await`, and an
   * `await` here would put a database round trip on the turn the caller is waiting
   * through. Nothing may wait for this.
   */
  readonly callerHistory: () => CallerHistory | null;
  /**
   * Put this caller's number on the do-not-call list, permanently and everywhere.
   *
   * Fire and forget, and required rather than optional: an optional field here is a wire a
   * construction site can forget, and the symptom would be a suppression that was heard,
   * acknowledged out loud, and never written down. A deployment with no database supplies a
   * no-op and says so.
   *
   * Takes the caller's words rather than a reason string. What they actually said is the
   * only honest record of why the row exists, and it is what somebody reviewing a complaint
   * six months from now will want to read.
   */
  readonly recordDoNotCall: (saidWhat: string) => void;
  /**
   * Builds the thing that hands the call to a person. Absent means escalation only logs,
   * as it did before there was anywhere to transfer to.
   *
   * A factory rather than a built `Handoff` because of the one ordering constraint that
   * only a phone call punishes: the departure line must be HEARD before the transfer
   * replaces the carrier instruction and tears down the media stream. Only the
   * orchestrator knows when a line has been heard, so it supplies `say` and the gateway
   * supplies everything else.
   */
  readonly makeHandoff?: (say: (text: string) => Promise<void>) => Handoff;
  /**
   * Who this call belongs to.
   *
   * Required and nullable, not optional. A tool dispatch without a organization is a query that
   * could return another organization's row (CLAUDE.md rule 3), so null does not mean "look it
   * up later" — it means an unregistered number, and **tool calling is disabled outright**
   * for the whole call. Such a caller may hold a conversation and must not touch anybody's
   * systems.
   */
  readonly organizationId: OrganizationId | null;
  /**
   * Builds this call's tools. Absent leaves the agent exactly as it was before tools
   * existed, which is what every test that does not care about them gets.
   *
   * A factory rather than a built dispatcher, for two reasons that both come down to
   * lifetime. The hooks above only exist inside a call. And the dispatcher must be per
   * call rather than per process: it holds the confirmation store, and a shared one would
   * let a "yes" given on one call redeem a write queued on another. `ConfirmationStore`
   * binds the call id and would refuse it, but building one per call means the question
   * never arises.
   */
  readonly makeTools?: (hooks: ToolHooks) => CallTools;
}

/**
 * Which slot in the call record a captured entity belongs in, or null when the record has
 * no slot for it.
 *
 * Keyed on the entity kind capture reports, never on the shape of the value: the previous
 * version of this decision was a regex over the confirmed string, and it filed a confirmed
 * date under "number". Null is the honest answer for the kinds the store has no field for
 * — writing an email address or an amount into `policyNumber` would put a confidently
 * wrong label in front of the model, which is worse than the model not being told.
 */
/**
 * What the agent says when a value was heard correctly and is not the right shape.
 *
 * The operator's own wording is reused, because they wrote it to describe the format and
 * repeating it is the most useful thing that can be said. The pattern itself is never read
 * out — a caller cannot act on a regular expression, and it would take longer to say than
 * the number it describes.
 */
const retryLine = (field: { readonly prompt: string }): string =>
  field.prompt === ""
    ? "That does not look like the right format. Could you give it to me again?"
    : `That does not look like the right format. ${field.prompt}`;

/**
 * The line when the attempts are used up and there is nobody to transfer to.
 *
 * Says what is true and does not promise a callback the agent has no way to make. The call
 * continues, because hanging up on someone who has answered three times is worse than
 * carrying on without the value.
 */
const GAVE_UP =
  "I am still not getting that in a form I can use, and I do not want to keep you repeating it. Let us carry on without it for now.";

/*
 * Exported for one guard test, and for one reason: `apps/web/.../tools-tab.tsx` keeps its
 * own copy of this rule as `WITHOUT_A_FIELD`, to tell an operator which of a tool's
 * identifiers this agent can never supply. The web app cannot import from the API, so the
 * duplication is real; a test asserting the two agree is what stops the console confidently
 * describing a rule the call path no longer follows.
 */
export const FACT_FIELD_FOR: Readonly<Partial<Record<EntityKind, IdentifierField>>> = {
  name: "callerName",
  reference: "policyNumber",
};

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
  /** When this turn first had audio queued. Stamped in enqueue, the one funnel all turns share. */
  startedAtMs?: number;
  /**
   * The sentence currently being synthesised. Its total audio length is not yet known,
   * so what the caller has heard of it is estimated from duration rather than measured.
   */
  inFlight: { readonly text: string; readonly startByte: number } | null;
  llmDone: boolean;
  /** When audio for the sentence currently playing began. Anchors the echo guard. */
  sentenceAudioAt: number | null;
}

/**
 * How long to wait for the caller to say something before deciding they did not.
 *
 * A transcript trails its StartOfTurn by roughly 300-1200ms on this stack, so the window
 * has to clear the slow end or a real interruption gets talked over by its own recovery.
 * Much beyond a second and the gap stops reading as a pause and starts reading as a
 * dropped call, which is the thing R6.2 exists to prevent.
 */
const FALSE_INTERRUPTION_MS = 1000;

/**
 * A noise over somebody's first four words is not listening, it is barging in. Twelve is
 * roughly where a caller has committed to explaining something rather than answering.
 */
const BACKCHANNEL_AFTER_WORDS = 12;
/** Overdone, this is far worse than silence. One every few seconds at most. */
const BACKCHANNEL_GAP_MS = 4000;
/** Our own audio takes a moment to come back through the handset. */
const BACKCHANNEL_GATE_TAIL_MS = 150;

/**
 * The tools the model is shown, once the policy layer has had its say.
 *
 * Filtering rather than replacing: the registry decides what exists and this decides what
 * is reachable, and inventing a list here would be a second source of truth for the first
 * question. A constraint naming a tool this organisation never registered simply matches
 * nothing, which is the right outcome — it cannot conjure a transfer that was not
 * configured.
 */
const offerable = <T extends { readonly name: string }>(
  registered: readonly T[],
  constraints: TurnConstraints,
): readonly T[] =>
  constraints.allowedTools === null
    ? registered
    : registered.filter((tool) => constraints.allowedTools?.includes(tool.name) === true);

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
 *
 * Several of them, because this was one constant spoken word for word however many times
 * a call needed it, and hearing the identical sentence twice is how a caller learns they
 * are talking to a machine. `capture.ts` already varies its second readback for the same
 * reason. They are deliberately not a progression — nothing here knows whether this is the
 * first failure or the third, and a line that said so would be wrong half the time — only
 * different ways of asking the same short thing.
 */
const RECOVERY_LINES: readonly string[] = [
  "Sorry, I did not catch that. Could you say it again?",
  "Sorry — I missed that. Come again?",
  // Every one of them apologises. Two tests assert it and they are right to: a turn that
  // produced nothing is our failure, and varying the wording is not licence to drop that.
  "Sorry, I did not get that one. Say it again for me?",
  "Sorry, the line is not clear. One more time?",
];

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
 * How long the caller may be audibly talking with no turn boundary before the agent says
 * something anyway.
 *
 * The transcript watchdog is armed at end-of-turn, so it cannot help when end-of-turn is
 * the thing that never comes: on the calls of 2026-08-23 the caller spoke, partials
 * arrived, Flux never closed the turn, and the agent sat silent for the rest of the call.
 * No error, no recovery line, nothing — the one failure CLAUDE.md forbids above all
 * others.
 *
 * Generous on purpose. Flux's own silence backstop is 4s, so a healthy detector has
 * already closed the turn well inside this; anything past it is a detector that is not
 * going to.
 */
const STALLED_TURN_MS = 8_000;

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
  const bargeInEnabled = deps.bargeIn ?? true;
  /* `CAPTURE_WIRING.md` §7: who decides when to ask. It is the agent's configuration now,
     and an agent with no form gets a director that is inert in every direction. */
  const form = createForm(deps.fields ?? []);

  /**
   * Point the engine at the next field the form wants, without speaking.
   *
   * `expecting()` returns the question too, and it is deliberately not used: the prompt
   * already tells the model what to collect and in what order, and having the engine say
   * it as well would give the caller the same question twice — once conversationally and
   * once as a form. What is taken is the `awaiting` state, and that is the whole point of
   * §7 in CAPTURE_WIRING: directed parsing. "The fourteenth", "Sikiru" and a letter-only
   * reference are unrecognisable in free speech and unambiguous as the answer to a
   * question, and `parseDirected` only runs from `awaiting`.
   *
   * Only from idle. Arming mid-readback would throw away a value the caller is part-way
   * through confirming, which is worse than parsing the next turn less well.
   *
   * An agent with no form never arms anything: `outstanding()` is null, capture stays
   * reactive, and the call behaves exactly as it did before any of this existed.
   */
  const armNextField = (): void => {
    if (capture.kind !== "idle") return;
    const next = form.outstanding();
    if (next === null) return;
    capture = expecting(next.entity).state;
    form.beginAsking(next);
    log.debug("expecting a configured field", { key: next.key, entity: next.entity });
  };

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
  /** Same picker, same reason: random, but never the same line twice running. */
  const pickRecovery = createFillerPicker();
  /** Its own, so a backchannel and a thinking filler do not exhaust each other. */
  const pickBackchannel = createFillerPicker();
  const pickCourtesy = createFillerPicker();
  /** When the filler currently playing will have finished. Zero when none is. */
  let fillerPlayingUntilMs = 0;
  /**
   * Whether the caller has been answered about how the agent is.
   *
   * Once per call. Somebody who asks twice is making conversation, and the second answer
   * would be the agent steering into small talk rather than out of it.
   */
  let courtesyOffered = false;

  let watchdog: ReturnType<typeof setTimeout> | null = null;
  let stalledTurn: ReturnType<typeof setTimeout> | null = null;

  const cancelWatchdog = (): void => {
    if (watchdog !== null) clearTimeout(watchdog);
    watchdog = null;
  };

  /**
   * The caller is talking and the turn detector is not closing the turn.
   *
   * Deferred on every partial rather than counted from the first: somebody mid-sentence is
   * still talking and must not be spoken over, and while partials keep arriving this keeps
   * standing down. It only fires once the caller has gone quiet to us — no partials, no
   * end-of-turn — which is a detector that has stopped working, not a long answer.
   */
  const armStalledTurn = (): void => {
    cancelStalledTurn();
    stalledTurn = setTimeout(() => {
      stalledTurn = null;
      /* Logged rather than returned silently. On the call of 2026-08-23 21:15 the caller
         spoke, this armed, and nothing was heard for 25 seconds — and a bare `return` left
         no way to tell a timer that never fired from one that fired and found a turn
         open. */
      if (turn !== null) {
        log.debug("the stall timer found a turn already open", { seq: turn.seq });
        return;
      }
      log.error("caller spoke but the turn never ended");
      sayRecovery("turn never ended");
    }, deps.stalledTurnMs ?? STALLED_TURN_MS);
    stalledTurn.unref();
  };

  const cancelStalledTurn = (): void => {
    if (stalledTurn !== null) clearTimeout(stalledTurn);
    stalledTurn = null;
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
    /* A filler is the one thing the agent says that no turn owns: no `turn`, no
       `bytesSent`, nothing for `stopSpeaking` to cancel. So a caller answering into "let
       me see" was talked over — the noise meant to cover a gap became an interruption of
       the reply it was covering. Remembered here so speech-start can cut it. */
    fillerPlayingUntilMs = Date.now() + durationMs(
      chunks.reduce((total, chunk) => total + chunk.data.length, 0),
      stream.format,
    );
    // Added to the spoken window so the echo filter recognises it coming back, but
    // never to bytesSent, never marked, never remembered: the agent did not say
    // anything it should be held to.
    spokenWindow = `${spokenWindow} ${phrase}`.slice(-400);
    log.debug("played thinking filler", { phrase });
  };

  /**
   * Small noises while the caller is still speaking.
   *
   * A person listening makes them; their absence is a large part of why an agent feels
   * like it is taking turns rather than having a conversation. Nothing about them comes
   * from the model — it only speaks on its own turn — so this is a separate path that
   * plays a pre-rendered acknowledgement and remembers nothing.
   *
   * Three conditions, each earning its place. Only while nothing is being said by us, or
   * the "noise" is the agent interrupting its own sentence. Only once every few seconds,
   * because overdone this is far worse than silence. And only once the caller has been
   * going for a while, because a noise over somebody's first four words is not listening,
   * it is barging in.
   */
  let lastBackchannelAt = 0;
  /**
   * Until when a speech start is our own backchannel coming back.
   *
   * The existing echo guard cannot cover this: it is anchored on `sentenceAudioAt`, which
   * only exists while the agent has a turn, and a backchannel plays precisely when it does
   * not. Without this the turn detector hears our "mm-hm", and the transcriber offers it
   * back as something the caller said.
   */
  let backchannelUntilMs = 0;

  const maybeBackchannel = (text: string): void => {
    if (deps.backchannel !== true) return;
    // Only while listening. Over our own sentence this is not a backchannel, it is a clash.
    if (turn !== null) return;

    const words = text.trim().split(/\s+/).filter((w) => w.length > 0).length;
    if (words < BACKCHANNEL_AFTER_WORDS) return;

    const at = Date.now();
    if (at - lastBackchannelAt < BACKCHANNEL_GAP_MS) return;

    const rendered = deps.fillers;
    if (rendered === undefined || rendered.size === 0) return;
    const available = ACKNOWLEDGEMENTS.filter((phrase) => rendered.has(phrase));
    const phrase = pickBackchannel.next(available);
    if (phrase === null) return;
    const chunks = rendered.get(phrase);
    if (chunks === undefined) return;

    let bytes = 0;
    for (const chunk of chunks) {
      stream.send(chunk);
      bytes += chunk.data.length;
    }
    lastBackchannelAt = at;
    /* The gate, and the whole reason this is safe to switch on. Our own audio takes a
       moment to come back through the handset, so anything the turn detector reports
       inside it plus a beat is us. */
    backchannelUntilMs = at + durationMs(bytes, stream.format) + BACKCHANNEL_GATE_TAIL_MS;
    /* Into the spoken window as well, so the transcript filter recognises the words coming
       back. Never into bytesSent, never marked, never remembered: the agent has not said
       anything it can be held to. */
    spokenWindow = `${spokenWindow} ${phrase}`.slice(-400);
    log.debug("played a backchannel", { phrase, words });
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

  /**
   * R5.4.2. Holding speech for a tool is the filler scheduler, which already exists.
   *
   * A tool call is the thinking gap with a known cause, so it takes the same registers and
   * skips the timer: `start` fires inside `dispatch()` before the adapter is invoked,
   * which is the entire requirement — by the time the promise settles the silence has
   * already happened.
   *
   * Below `playFiller` and `cancelFiller` on purpose. They are function expressions and do
   * not hoist, so this cannot move above them.
   */
  const toolHolding: HoldingSpeech = {
    start: () => {
      cancelFiller();
      // Tier 1 (acknowledgements) is wrong here. "Mm-hm" does not explain a two-second
      // pause that has a reason behind it; progress does.
      playFiller(deps.fillerTiers?.[1] ?? []);
    },
    slow: () => {
      playFiller(deps.fillerTiers?.[2] ?? []);
    },
    stop: () => {
      cancelFiller();
    },
  };

  /**
   * Why the call is ending, held until the caller has heard the last thing said to them.
   *
   * `end_call` cannot hang up when it returns. The tool runs while the model is still
   * composing the goodbye, and even once the goodbye is synthesised the audio sits queued
   * at the carrier — measured at ~1.8s on this project's own calls. Hanging up on the
   * tool's return would truncate the last words of every call the agent ever ends. So the
   * tool records the intent and `finishIfComplete` acts on it, on the mark.
   */
  let hangUpAfterSpeaking: string | null = null;

  const endCallWhenHeard = (reason: string): void => {
    // Idempotent. A model that asks twice — or asks again in the goodbye turn — must not
    // queue two hangups, and the first reason is the true one.
    if (hangUpAfterSpeaking !== null) return;
    hangUpAfterSpeaking = reason;
    log.info("the call will end once the caller has heard the goodbye", { reason });
    record.event("end_call_requested", { reason });
  };

  /**
   * This call's organization, captured once.
   *
   * Null disables tool calling for the whole call rather than per dispatch: nothing is
   * built, so there is no dispatcher to reach and no list to offer the model.
   */
  const toolOrganizationId = deps.organizationId;
  const toolset: CallTools | null =
    toolOrganizationId === null
      ? null
      : (deps.makeTools?.({ holding: toolHolding, endCall: endCallWhenHeard }) ?? null);

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
    const ms = Date.now() - started;
    log.info("latency", { stage, ms, ...extra });
    /* Both, from one place. The event log keeps this turn's story with its `seq` and its
       character counts; `latencies` keeps the bare number where a range across a week can
       index it. Two writes off one measurement cannot drift; two measurements would. */
    record.event("latency", { stage, ms, ...extra });
    /* `provider` when the stage belongs to one, which is what makes an A/B between two
       vendors readable: "tts_first_byte p90" across a week of mixed traffic is one number
       for two products. `turn_to_audio` stays null on purpose — it is the end-to-end
       figure and no single vendor owns it. */
    record.latency({
      stage,
      ms,
      provider: typeof extra["provider"] === "string" ? extra["provider"] : null,
    });
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

  /**
   * The call's state as one named value. It decides nothing — every branch below still
   * makes the decision it makes today and reports what it did. See call-state/machine.ts.
   */
  const callState = createCallState((transition) => {
    log.info("call state", { ...transition });
    record.event("call_state", { ...transition });
  });

  // The transcriber is already connected by the time the orchestrator runs; this marks
  // when audio actually starts reaching it, which is the number that matters.
  let audioSeen = false;

  /**
   * Turn numbering for the record, shared across both speakers.
   *
   * Separate from turnSeq, which counts the agent's turns and skips the caller's. The
   * table is unique on (call, seq), so a shared counter is the only numbering that cannot
   * collide.
   *
   * It is an insertion counter and NOT a chronology. A caller turn is numbered when its
   * transcript lands, which can be seconds after the caller started speaking and after an
   * agent turn has already been recorded — a live call produced #11 starting at 57.7s
   * immediately before #12 starting at 49.8s. Anything ordering turns must sort on
   * started_offset_ms, which is when they actually began.
   */
  let recordedTurns = 0;
  const streamStartedAt = Date.now();
  const sinceStart = (): number => Date.now() - streamStartedAt;
  /** Where the caller's current turn began, from the turn detector rather than guessed. */
  let callerTurnStartedMs: number | null = null;

  /**
   * How the caller sounded on the last two turns.
   *
   * Two rather than one because the trajectory is the useful part: the same caller at
   * "frustrated" is a different call depending on whether they were calm or angry a minute
   * ago. Both survive a malformed marker — a turn the model forgot to annotate keeps the
   * pair it had rather than blanking it, which is what stops one bad line erasing the
   * whole arc.
   */
  let read: EmotionalRead | null = null;
  let previousRead: EmotionalRead | null = null;

  /**
   * Whether a tool has actually run since the caller last spoke.
   *
   * The output guard's only hard rule rests on this: a turn that dispatched a tool has done
   * something and may say so, and a turn that only talked has not, whatever it claims. Held
   * here rather than on the turn because a tool result comes back as a caller message and
   * starts a *new* agent turn — the claim and the tool call are one exchange to the caller
   * and two turns to this file, and reading it per turn would block exactly the sentence
   * that is entitled to be said.
   */
  let toolRanThisExchange = false;

  /**
   * What the agent is allowed to do right now.
   *
   * Recomputed rather than held, because every input moves during a call. Consulted twice
   * and deliberately so: once to decide what the model is even shown, and once at the
   * dispatch site — the first stops it asking, the second is what makes the answer no. A
   * model naming a tool it was not offered would otherwise still resolve, because the
   * registry has no idea a conversation is going wrong.
   */
  const constraintsNow = (): TurnConstraints =>
    computeConstraints({
      failedTurns: watch.failedTurns(),
      escalationOffered: watch.handedOver(),
      read,
      contactsThisWeek: deps.callerHistory()?.contactsThisWeek ?? 0,
    });

  const speechGate = createSpeechGate();
  let speechMsSinceTranscript = 0;

  /**
   * Silence the caller's network did not send, for the turn detector's benefit only.
   *
   * Flux ends a turn by hearing the caller stop. Networks that suppress silence send
   * nothing rather than quiet, so it hears neither and the turn never closes — the agent
   * goes mute for the rest of the call. This hands it the quiet it is listening for.
   *
   * Written straight to `deps.listen`, deliberately bypassing the speech gate and the
   * `audio_received` stamp: invented frames are not evidence, and a noise floor computed
   * partly from audio we made up is not a noise floor.
   */
  const silenceFill = createSilenceFill({
    format: stream.format,
    frameMs: FRAME_MS,
    emit: (chunk) => deps.listen.write(chunk),
    now: () => Date.now(),
    schedule: (fn, ms) => {
      const handle = setTimeout(fn, ms);
      handle.unref();
      return handle;
    },
    cancel: (handle) => clearTimeout(handle),
  });

  const takeAudio = (chunk: AudioChunk): void => {
    if (!audioSeen) {
      audioSeen = true;
      record.event("audio_received", { offsetMs: chunk.offsetMs }, chunk.offsetMs);
      record.event("stt_start", {});
    }
    if (speechGate.push(chunk.data).length > 0) speechMsSinceTranscript += FRAME_MS;
    silenceFill.seen(chunk);
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

  /**
   * The complement of `heardText`: everything the caller was going to hear and did not.
   *
   * Needed because a false interruption cannot be undone by resuming playback. Twilio has
   * no pause — `clear` discards the carrier's buffer outright — so the only way back is to
   * say the rest again. This is the text to say.
   *
   * Deliberately reconstructed from the same byte offsets `heardText` uses, so the two
   * cannot disagree about where the cut fell and leave a word spoken twice or dropped.
   */
  const unheardText = (current: AgentTurn): string => {
    const parts: string[] = [];

    for (const sentence of current.spoken) {
      if (current.bytesHeard >= sentence.endByte) continue;
      if (current.bytesHeard <= sentence.startByte) {
        parts.push(sentence.text);
        continue;
      }
      // Partly heard. Resume from the word boundary `heardText` stopped at, so the seam
      // is a whole word either side.
      const span = sentence.endByte - sentence.startByte;
      const ratio = (current.bytesHeard - sentence.startByte) / span;
      const heardPrefix = toWordBoundary(sentence.text, Math.floor(sentence.text.length * ratio));
      parts.push(sentence.text.slice(heardPrefix.length).trim());
    }

    const live = current.inFlight;
    if (live !== null) {
      if (current.bytesHeard <= live.startByte) parts.push(live.text);
      else {
        const msHeard = durationMs(current.bytesHeard - live.startByte, stream.format);
        const chars = Math.floor((msHeard / 1000) * CHARS_PER_SECOND);
        const heardPrefix = toWordBoundary(live.text, Math.min(chars, live.text.length));
        parts.push(live.text.slice(heardPrefix.length).trim());
      }
    }

    // Never synthesised at all.
    parts.push(...current.queue);

    return parts.filter((part) => part.length > 0).join(" ").trim();
  };

  /**
   * Updates the conversation with what the caller has actually heard so far.
   *
   * It does NOT record the turn, and used to. Every mark the carrier acknowledges runs
   * this, so on the first one the turn was written down with no barge offset and
   * `startedAtMs` cleared — and `stopSpeaking`'s own call, the one that knows where the
   * caller cut in, then found nothing left to stamp. `barged_in_at_ms` was null on every
   * interruption on every real call because of it. The turn is written at its two real
   * exits instead: played out, and cut off.
   */
  const commitHeard = (current: AgentTurn): void => {
    conversation.recordAgentTurn(current.seq, heardText(current));
  };

  /** Retry counter per sentence, so a transient TTS failure costs one repeat, not the turn. */
  const attempts = new Map<string, number>();

  /**
   * Waiters for turns whose caller has to have HEARD them, keyed by turn sequence.
   *
   * Only the handoff needs this so far, and it needs it badly: the transfer replaces the
   * call's carrier instruction, which tears down the media stream. Audio still queued at
   * the carrier — measured at ~1.8s on this project's own calls — is discarded with it, so
   * "let me put you through" has to be heard, not merely sent.
   */
  const playedOut = new Map<number, () => void>();

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
    // The normalised text, not the raw sentence: characters are what a voice provider
    // bills for and this is the string actually sent, respellings and all. It is also the
    // only place the number exists — a retry after a failure is a second charge for the
    // same sentence, and the log has to show both.
    const spoken = deps.forSpeech(sentence);
    record.event("tts_start", { seq: current.seq, chars: spoken.length });
    const synthesis = deps.tts.synthesize({
      text: spoken,
      voiceId: deps.voiceId,
      speakingRate: deps.speakingRate,
      format: stream.format,
    });
    current.synthesis = synthesis;

    let first = true;
    synthesis.onAudio((chunk) => {
      if (turn?.seq !== current.seq) return;
      if (first) {
        first = false;
        current.sentenceAudioAt = Date.now();
        callState.apply({ kind: "agent.audio.started", seq: current.seq });
        // The agent is speaking for real now; no acknowledgement should land on top.
        cancelFiller();
        cancelWatchdog();
        measure("tts_first_byte", { seq: current.seq, provider: deps.tts.name });
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
      // The voice failing left no trace in the event log whatsoever, so a call where the
      // caller heard half an answer scored identically to one that went perfectly.
      record.event("tts_failed", { seq: current.seq, attempt, error: error.message });
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
      // Twice is enough; this sentence is not going to be said.
      //
      // Where it hurts is the middle of a turn: the caller has heard a fragment, the queue
      // moves on, and `finishIfComplete` closes the turn as though it played out. That is
      // recorded as `turn_complete` and is indistinguishable from success — so a truncated
      // answer is invisible to every metric and to the review queue. It is named here.
      //
      // Deliberately NOT rescued with a spoken apology: the provider that would have to
      // synthesise it has just failed twice, which is the same reasoning as the branch
      // below. The caller is left with a partial sentence rather than a dead line, and the
      // next thing they say is answered normally.
      record.event("tts_sentence_dropped", { seq: current.seq, chars: sentence.length });
      speakNext(current);
      if (current.bytesSent === 0 && current.queue.length === 0 && current.synthesis === null) {
        // Nothing was said and nothing can be: do not synthesise a fallback through the
        // provider that just failed twice. An open silent line is worse than ending.
        log.error("turn produced no audio, ending the call", { seq: current.seq });
        turn = null;
        callState.apply({
          kind: "agent.turn.interrupted",
          seq: current.seq,
          reason: "tts failed twice",
        });
        callState.apply({ kind: "call.hangup.requested", reason: "tts failed twice" });
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
  /** Called on both exits: played out, and cut off. */
  const recordAgentTurn = (current: AgentTurn, bargedInAtMs: number | null): void => {
    if (current.startedAtMs === undefined) return; // never spoke, so never a turn
    recordedTurns += 1;
    record.turn({
      seq: recordedTurns,
      speaker: "agent",
      startedOffsetMs: current.startedAtMs,
      endedOffsetMs: sinceStart(),
      bargedInAtMs,
    });
    current.startedAtMs = undefined; // recorded once, whichever exit runs first
  };

  const finishIfComplete = (current: AgentTurn): void => {
    if (turn?.seq !== current.seq) return;
    if (!current.llmDone) return;
    if (current.queue.length > 0 || current.synthesis !== null) return;
    if (current.bytesHeard < current.bytesSent) return;

    record.event("turn_complete", { seq: current.seq });
    // Played out in full, so there is no barge offset. The other exit is stopSpeaking,
    // which stamps one; between them every agent turn that made a sound is recorded once.
    recordAgentTurn(current, null);
    log.info("agent turn played", {
      seq: current.seq,
      ms: Math.round(durationMs(current.bytesHeard, stream.format)),
    });
    playedOut.get(current.seq)?.();
    playedOut.delete(current.seq);
    turn = null;
    callState.apply({ kind: "agent.turn.completed", seq: current.seq });

    // The caller asked to finish and has now heard the last of it. This is the only place
    // `end_call` actually ends anything, and it is on the mark rather than on the tool's
    // return for the reason recorded where the flag is declared.
    if (hangUpAfterSpeaking !== null) {
      const reason = hangUpAfterSpeaking;
      hangUpAfterSpeaking = null;
      log.info("ending the call, the goodbye has played out", { reason });
      record.event("call ended by the agent", { reason });
      callState.apply({ kind: "call.hangup.requested", reason });
      stream.hangUp();
    }
  };

  const enqueue = (current: AgentTurn, sentence: string): void => {
    /**
     * The last check before anything is spoken.
     *
     * Here rather than at the token stream because a sentence is the smallest unit that can
     * be judged or withheld — half a claim is not a claim, and audio already sent cannot be
     * taken back. `forSpeech` below still does the stripping; this only decides whether the
     * sentence is said at all.
     */
    const verdict = guardOutput({ sentence, toolRanThisTurn: toolRanThisExchange });
    if (verdict.kind === "block") {
      log.warn("blocked an unbacked claim", { seq: current.seq, reason: verdict.reason, sentence });
      record.event("output_blocked", { seq: current.seq, reason: verdict.reason, text: sentence });
      /* Nothing further from this turn. The model has said something it could not support,
         so the rest of what it was about to say is not to be trusted either — and a person
         takes it from here rather than the agent trying again. */
      current.queue.length = 0;
      current.llmDone = true;
      escalate(watch.needsAPerson(verdict.reason));
      sentence = HOLDING_LINE;
    } else if (verdict.flagged.length > 0) {
      /* Logged, never withheld. One of these does not ruin a call; the same one across most
         of a week's calls is a catchphrase the prompt needs fixing for. */
      record.event("banned_phrase", { seq: current.seq, phrases: verdict.flagged, text: sentence });
    }

    current.startedAtMs ??= sinceStart();
    // The window holds what TTS was actually given, so the comparison is against the
    // words that were spoken — including the "An-Sah" respelling, which is what a
    // transcriber will hear.
    spokenWindow = `${spokenWindow} ${deps.forSpeech(sentence)}`.slice(-400);
    current.queue.push(sentence);
    speakNext(current);
  };

  // ---- barge-in ------------------------------------------------------------

  /**
   * A turn we tore down for the caller, before knowing whether they meant it.
   *
   * Barge-in fires on `StartOfTurn`, which is a sound, not a sentence — the transcript is
   * 300-1200ms behind it. Stopping has to happen on the sound or the agent talks over a
   * real interruption, so by the time we can tell "mm-hmm" from "no, wait" the audio is
   * already discarded at the carrier. This holds what it would take to undo that.
   *
   * It also fixes a guard that could not fire. `BACKCHANNEL` was consulted as
   * `turn !== null && BACKCHANNEL.has(flat)` — but `stopSpeaking` nulls the turn before
   * the transcript arrives, so with barge-in on (the default) the condition was never true
   * when it mattered. Saying "mm-hmm" over the agent both cut it off and then got answered
   * as though it were a question.
   */
  interface PendingInterruption {
    readonly seq: number;
    /** What the caller heard, for the em-dash if this turns out to be real. */
    readonly heard: string;
    /** What they did not, for saying again if it turns out not to be. */
    readonly unheard: string;
    readonly timer: ReturnType<typeof setTimeout>;
  }
  let interrupted: PendingInterruption | null = null;

  const forgetInterruption = (): void => {
    if (interrupted === null) return;
    clearTimeout(interrupted.timer);
    interrupted = null;
  };

  const stopSpeaking = (reason: string, recoverable = false): void => {
    const current = turn;
    if (current === null) return;
    turn = null;
    // After the null guard, deliberately: stopSpeaking is called from paths that find no
    // turn at all, and reporting above it would invent an interruption on a call where
    // nothing was playing.
    callState.apply({ kind: "agent.turn.interrupted", seq: current.seq, reason });

    // Read before the teardown below empties the queue and cancels the synthesis: both
    // are inputs to what the caller has not heard yet.
    const unheard = recoverable ? unheardText(current) : "";
    const heard = recoverable ? heardText(current) : "";

    // Order matters: stop producing before discarding, or audio synthesised in the gap
    // lands at the carrier after the clear and plays over the caller.
    current.cancelLlm?.();
    current.synthesis?.cancel();
    current.queue.length = 0;
    cancelFiller();
    cancelWatchdog();
    stream.clear();

    // Where the caller cut in, in milliseconds of audio they had heard. This is the only
    // place that number exists.
    recordAgentTurn(current, Math.round(durationMs(current.bytesHeard, stream.format)));
    commitHeard(current);

    /* Hold the evidence for a moment before believing it. A cough, a door, a carrier
       click and a "mm-hmm" all look identical at StartOfTurn; only the transcript tells
       them apart, and it has not arrived. If nothing arrives at all within the window,
       nobody interrupted — the agent stopped for a noise and would otherwise sit in
       silence for the rest of the call. */
    forgetInterruption();
    if (recoverable && unheard.length > 0) {
      interrupted = {
        seq: current.seq,
        heard,
        unheard,
        timer: setTimeout(() => {
          resumeInterrupted("nothing was said");
        }, FALSE_INTERRUPTION_MS),
      };
    }

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
    /* Our own backchannel returning. Checked before the guard below, which cannot help
       here: that one is anchored on an agent turn, and a backchannel plays precisely when
       there is none. Without this the agent reacts to its own "mm-hm", which is the
       barge-in defect Phase 2 removed, rebuilt by the feature meant to make calls warmer. */
    if (Date.now() < backchannelUntilMs) {
      echoSegments.add(event.offsetMs);
      log.debug("ignored speech start inside the backchannel gate");
      return;
    }

    /* Cut the filler. Nothing else will: it belongs to no turn, so `stopSpeaking` below
       returns without doing anything, and the carrier would keep playing "one moment" over
       the answer the caller is giving. Safe to clear the whole queue — with no agent turn
       in flight the filler is the only thing in it. */
    if (Date.now() < fillerPlayingUntilMs) {
      fillerPlayingUntilMs = 0;
      if (turn === null) {
        stream.clear();
        log.debug("cut a filler short, the caller started talking");
      }
    }

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
        callState.apply({ kind: "caller.speech.started", handling: "echo" });
        log.debug("ignored speech start inside barge-in guard", { speakingFor });
        return;
      }
    }

    // Below the echo guard, deliberately. Above it, a segment the guard then judged to be
    // our own audio coming back had already stamped the caller's turn start, and their
    // next turn was filed as having begun at the moment of the echo.
    callerTurnStartedMs ??= event.offsetMs;

    // The agent has made no sound yet, so there is nothing to interrupt. Tearing the
    // turn down here would cancel an LLM that was milliseconds from its first token —
    // the dead air manufacturing the interruption that deletes the answer.
    if (current !== null && current.sentenceAudioAt === null) {
      log.debug("caller spoke while the agent was still thinking", {
        offsetMs: event.offsetMs,
      });
      callState.apply({ kind: "caller.speech.started", handling: "over-thinking" });
      return;
    }

    log.debug("caller speech start", { offsetMs: event.offsetMs });
    // Reported whether or not a turn is open: it is the caller taking the floor, and
    // stopSpeaking reports the interruption separately on the next line.
    callState.apply({ kind: "caller.speech.started", handling: "barge-in" });
    // They have started again, so the transcript we were waiting on is no longer what
    // they are owed. Left armed, the recovery line fires five seconds into their next
    // sentence — the failure the watchdog exists to prevent, pointed the other way. Only
    // when nothing is playing: with a turn open, stopSpeaking cancels it on the next line
    // and the turn watchdog it may be holding has to survive until then.
    if (current === null) cancelWatchdog();
    // The agent finishes its sentence when barge-in is off. Everything above still ran —
    // the turn start is stamped and the state machine has been told the caller took the
    // floor — so the transcript that follows is handled normally. Only the teardown of
    // audio already playing is withheld, which is the whole of what "interrupt" means to
    // somebody on the phone.
    if (current !== null && bargeInEnabled) stopSpeaking("caller interrupted", true);

    /* From here the caller has the floor and something has to end their turn. If nothing
       does, this is what breaks the silence. */
    armStalledTurn();
  });

  deps.listen.turns.onEndOfTurn(() => {
    // The boundary arrived, so the stall never happened. The transcript watchdog below
    // covers what comes next.
    cancelStalledTurn();
    callState.apply({ kind: "caller.turn.ended" });
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
    // Recorded, not merely logged. Going deaf is the single most expensive thing that can
    // happen to a call and until now it left no trace in the event log at all, so no
    // metric could count it and the review queue could not surface the calls it ruined.
    record.event("listen_failed", { reason });

    // Everything armed on behalf of a conversation that is now over.
    //
    // Found by drilling it: a turn held back for a continuation kept its 1.1s timer, so
    // roughly a second after the goodbye the call started an LLM request and opened a new
    // turn — on a line it had already asked the carrier to hang up. The filler timers are
    // the same shape of bug pointed at the audio path.
    clearPending();
    cancelFiller();
    cancelWatchdog();
    stopSpeaking("listen connection lost");
    // Say something before going: an open line the agent cannot hear is worse than a
    // clean ending, but ending mid-air with no explanation is worse than either.
    sayRecovery("listen connection lost");
    const farewell = turn;
    if (farewell === null) {
      callState.apply({ kind: "call.hangup.requested", reason: "listen connection lost" });
      stream.hangUp();
      return;
    }
    stream.onMark(() => {
      if (farewell.bytesHeard >= farewell.bytesSent && farewell.bytesSent > 0) {
        callState.apply({ kind: "call.hangup.requested", reason: "listen connection lost" });
        stream.hangUp();
      }
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
    // The agent is speaking for real now, so nothing is left to cut.
    fillerPlayingUntilMs = 0;
    // `capture` and only capture: readbacks, spell prompts and keypad prompts all arrive
    // here, and nothing else does.
    callState.apply({ kind: "agent.turn.started", seq: direct.seq, reason: "capture" });
    // No model round trip is coming, so there is no gap for a filler to cover.
    cancelFiller();
    log.info("speaking without the model", { reason, seq: direct.seq, text });
    record.event("agent said", { reason, seq: direct.seq, text });
    enqueue(direct, text);
  };

  /**
   * It was not an interruption. Say the rest.
   *
   * "Resume" is the wrong word for what Twilio allows and the right word for what the
   * caller experiences. There is no pause to release — `clear` discarded the buffer — so
   * the remainder is synthesised again as a fresh turn. The seam lands on a word boundary
   * because `unheardText` cuts where `heardText` cut.
   *
   * The history is left alone. What the caller heard was already recorded without an
   * em-dash, and this turn records the rest, so the model sees two adjacent assistant
   * turns — which is what happened: it said a sentence in two pieces with a gap.
   */
  const resumeInterrupted = (why: string): void => {
    const pending = interrupted;
    if (pending === null) return;
    interrupted = null;
    clearTimeout(pending.timer);

    // A turn started in the meantime — the caller really did say something and it has
    // already been answered. Saying the old remainder now would talk over the answer.
    if (turn !== null) return;

    log.info("false interruption, resuming", {
      why,
      seq: pending.seq,
      chars: pending.unheard.length,
    });
    record.event("false_interruption", { why, seq: pending.seq });
    callState.apply({ kind: "agent.turn.interrupted", seq: pending.seq, reason: "resumed" });
    sayNow(pending.unheard, "resumed after false interruption");
  };

  /**
   * It was an interruption. Mark the turn as cut off.
   *
   * The em-dash is the whole point: without it the model reads its last turn as a
   * complete sentence it chose to end there, and carries on as though nothing happened.
   * With it, it can tell it was cut off and let the caller speak.
   *
   * Nothing to mark when the caller heard nothing — `recordAgentTurn` with an empty
   * string has already removed the turn, and a lone dash is not a thing anybody said.
   */
  const confirmInterruption = (): void => {
    const pending = interrupted;
    if (pending === null) return;
    interrupted = null;
    clearTimeout(pending.timer);
    if (pending.heard.length === 0) return;
    conversation.recordAgentTurn(pending.seq, `${pending.heard}—`);
  };

  /**
   * Says one line and resolves once the caller has heard it.
   *
   * Resolves early — without waiting — when the turn was superseded or never opened, since
   * nothing more is coming for it. `createHandoff` guards the other side with its own
   * timeout, so a mark that never arrives costs a warning rather than a stranded caller;
   * that timeout is the backstop and this is the mechanism.
   */
  const sayAndWait = (text: string, reason: string): Promise<void> =>
    new Promise((resolve) => {
      sayNow(text, reason);
      const spoken = turn;
      if (spoken === null) {
        resolve();
        return;
      }
      playedOut.set(spoken.seq, resolve);
    });

  /**
   * The one path from "the agent has given up" to "a person is on the line". Absent
   * handoff means the triggers still count and still log, and nothing transfers — which is
   * exactly what this call did before.
   */
  const handoff = deps.makeHandoff?.((text) => sayAndWait(text, "handoff")) ?? null;
  const watch = createEscalationWatch();
  const escalate = (trigger: EscalationTrigger | null): boolean => {
    if (trigger === null) return false;
    void handoff?.escalate(trigger);
    return handoff !== null;
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
    callState.apply({ kind: "agent.turn.started", seq: recovery.seq, reason: "recovery" });
    const line = pickRecovery.next(RECOVERY_LINES) ?? RECOVERY_LINES[0] ?? "";
    log.warn("speaking a recovery line", { reason, seq: recovery.seq, line });
    // Every one of these is a turn that produced nothing and had to be covered with an
    // apology — the closest thing the event log has to "the caller nearly heard silence".
    // The reason is the whole value of it: a call full of `no transcript` is a listening
    // problem and a call full of `llm failed` is not, and a log line cannot be counted.
    record.event("recovery_line", { reason, seq: recovery.seq });
    enqueue(recovery, line);
    // A turn that went nowhere. Three of these and the caller gets a person (R6.4) — the
    // counter resets on any turn that produced real speech, so three scattered failures
    // across an otherwise fine call do not transfer someone who was doing fine.
    escalate(watch.misunderstood(reason));
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
    callState.apply({ kind: "agent.turn.started", seq: repeat.seq, reason: "repeat" });
    log.info("repeating the previous utterance", { seq: repeat.seq, chars: text.length });
    enqueue(repeat, text);
  };

  /**
   * A write the caller has been read and has not yet answered. One at a time.
   *
   * The arguments are kept beside the id because the dispatcher fingerprints them and
   * refuses a confirmation whose arguments moved after the caller heard them (R4.3.1).
   * Quoting the id back is proof the caller said yes to *something*; quoting the same
   * arguments back is proof of what.
   */
  let pendingWrite: {
    readonly confirmationId: string;
    readonly name: string;
    readonly args: ToolArgs;
  } | null = null;

  const respondTo = (
    callerText: string,
    forModel: string = callerText,
    /** A tool result is not a caller turn, however it enters the conversation. */
    from: "caller" | "tool" = "caller",
  ): void => {
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

    // Only for a real caller turn. The stage was marked at end-of-turn and consumed by
    // the turn that asked for the tool; measuring it again on the follow-up would warn
    // about a mark nobody set and attribute the tool's time to transcription.
    if (from === "caller") measure("stt_final", { chars: callerText.length });
    conversation.addCaller(forModel);
    // They have answered. Whatever we were waiting on is no longer outstanding. A tool
    // result answers nothing the agent asked the caller, so it does not clear it.
    if (from === "caller") deps.facts?.clear("pendingQuestion");

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
    callState.apply({ kind: "agent.turn.started", seq, reason: "model" });

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
    /* Sits in front of the sentence buffer, not behind it. The marker has no terminal
       punctuation, so the buffer would hold it to the end of the stream and then flush it
       as the tail — straight to TTS, and the caller hears the angle brackets read out. */
    const stripper = createReadStripper();
    // Empty until something is known, so turn one is byte-for-byte the prompt that was
    // sent before this existed.
    /* Before the prompt is built, so both what the model is told and what it is offered are
       decided by the same reading of the call. */
    const constraints = constraintsNow();
    if (constraints.escalationRequired) {
      log.info("policy requires a person", { seq, reason: constraints.reason });
      record.event("escalation_required", { seq, reason: constraints.reason });
    }

    const known = deps.facts === undefined ? "" : renderFacts(deps.facts.facts);
    // Order is deliberate. Standing instructions, then what is known about this call, then
    // how long this particular reply may be — the per-turn instruction sits nearest the
    // generation because it is the one that changes every turn. The instruction is the soft
    // half; the word cap below is the half that holds.
    /* Where the call is, as opposed to what the caller said. Recomputed every turn because
       every field of it moves: the clock, how long they have been on, how many turns have
       gone nowhere. Pure arithmetic over values already in hand — no clock lookup beyond
       `Date.now()`, no query, nothing that could sit on the real-time path. */
    const situation = renderSituation(
      describeSituation({
        now: new Date(),
        callStartedAtMs: streamStartedAt,
        businessHours: deps.businessHours ?? null,
        failedTurns: watch.failedTurns(),
        escalationOffered: watch.handedOver(),
        /* Whatever has arrived. A read started as the call connected, so on turn one it is
           usually there and occasionally not — and "not" renders nothing rather than
           waiting, because a turn that waits on a query is the two-loop rule broken. */
        history: deps.callerHistory(),
      }),
    );
    /* Order is deliberate. Standing instructions, then what is known about this call, then
       where the call is, then how long this particular reply may be — each nearer the
       generation than the last, in the order they change. The instruction is the soft
       half; the word cap below is the half that holds. */
    /* Its own block rather than a line inside the situation, because its provenance is
       different and the difference matters: everything in the situation block is computed
       here and is therefore true, while this is the model's own guess about the caller
       handed back to it. Keeping them apart stops the guess reading as a fact. */
    const feeling = renderRead(read, previousRead) ?? "";
    /* Straight after the base prompt, and before anything that changes per turn. It is
       static for the whole call, so it sits inside the stable prefix and costs the prompt
       cache nothing — and it belongs near the top for the same reason the base does, since
       what it carries are prohibitions rather than details. */
    const outbound = deps.direction === "outbound" ? OUTBOUND_LAYER : "";
    const system = [deps.systemPrompt, outbound, known, situation, feeling, budget.instruction]
      .filter((s) => s !== "")
      .join("\n\n");
    /**
     * What this turn costs to ask, in characters.
     *
     * Characters and not tokens, and the difference is not cosmetic: the vendor bills
     * tokens and the interface does not report them, so this is a proxy that moves with
     * the real number rather than the real number. It is recorded because the growth is
     * the interesting part — history is resent whole every turn, so turn twelve of a call
     * costs several times what turn one did, and nothing until now could show that.
     */
    const promptChars =
      system.length + conversation.messages.reduce((n, m) => n + m.content.length, 0);
    record.event("llm_start", { seq, promptChars, messages: conversation.messages.length });
    const completion = deps.llm.complete({
      system,
      messages: conversation.messages,
      // A guard against runaway generation, not a length control. A tight token cap
      // guillotines mid-clause and the caller hears a cut-off word.
      maxTokens: budget.maxTokens,
      // Offering a tool is not permission to run it. The tier is enforced in the dispatch
      // path (R5.3), so a tool listed here can still be refused, confirmed or transferred.
      // Absent — an unregistered number — and the model may only speak.
      tools:
        toolset === null || toolOrganizationId === null
          ? undefined
          : offerable(toolset.registry.listFor(toolOrganizationId), constraints),
    });
    current.cancelLlm = () => {
      completion.cancel();
    };

    /**
     * What the turn cost, once the vendor says so.
     *
     * After the last token, so it is on no measured stage and nothing waits for it. The
     * number that matters is `cachedTokens`: the system prompt is a little over a thousand
     * tokens and is resent on every turn of every call, and whether the vendor serves that
     * prefix from cache is the difference between paying for it once per call and once per
     * turn — in money and in the time-to-first-token the caller sits through.
     *
     * A zero here on turn three of a call is the alarm. It means the prefix moved, and the
     * likeliest cause is something new being prepended to the system prompt rather than
     * appended after it.
     */
    completion.onUsage((usage) => {
      log.info("llm usage", {
        seq,
        promptTokens: usage.promptTokens,
        cachedTokens: usage.cachedTokens,
        completionTokens: usage.completionTokens,
      });
      record.event("llm_usage", {
        seq,
        promptTokens: usage.promptTokens,
        cachedTokens: usage.cachedTokens,
        completionTokens: usage.completionTokens,
      });
    });

    let firstToken = true;
    let sentencesSpoken = 0;
    let wordsSpoken = 0;
    // What went to TTS. `current.spoken` lags — it is filled as audio emits — so at the
    // cap site it is empty for sentences still synthesising.
    const enqueued: string[] = [];
    completion.onDelta((token) => {
      if (turn?.seq !== seq) return;
      if (firstToken) {
        firstToken = false;
        measure("llm_first_token", { seq, provider: deps.llm.name });
      }
      const speakable = stripper.push(token);
      if (speakable === "") return;
      for (const sentence of sentences.push(speakable)) {
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
        //
        // `wordsSpoken > 0` was true after "Okay." and cut the answer behind it. On the
        // call at 11:10 that was seq 8: two words against a polar budget of eight, and the
        // question the model was about to ask went with the cancelled completion — the
        // caller waited twelve seconds and asked "Are you there?".
        //
        // The threshold is words rather than sentences because the two cases sit either
        // side of one boundary. "Yes, it is." is three words and a whole answer, and
        // capping after it is the point of the mechanism. "Okay." is two and answers
        // nothing. A turn that has said less than an interjection has not spoken yet.
        const wouldExceedWords = wordsSpoken + sentenceWords > budget.maxWords;
        const outOfUnits = sentencesSpoken >= budget.maxUnits;
        if (wordsSpoken >= INTERJECTION_WORDS && (wouldExceedWords || outOfUnits)) {
          log.info("turn capped", {
            seq,
            action: budget.action,
            wordsSpoken,
            budgetWords: budget.maxWords,
          });
          /**
           * A capped turn is an over-long reply, and this is the only place that knows.
           *
           * `driftIn` runs in `onDone` against the model's whole output — but the next line
           * cancels the completion, so on exactly the turns that ran long there is no
           * `onDone` and no whole output to measure. Cancelling is right: it stops us
           * paying for tokens nobody will hear. Recording the drift here is what stops that
           * saving costing the measurement.
           *
           * `sentences` is what was spoken rather than what was written, because what was
           * written no longer exists. It is a floor, and the flag is the fact.
           */
          record.event("drift", {
            seq,
            sentences: sentencesSpoken,
            tooLong: true,
            screenFormatting: false,
            capped: true,
          });
          // The only record this turn will get. `record.event("agent said")` for a model
          // turn lives in `onDone`, and the next line cancels the completion, so a capped
          // turn was absent from the call log entirely — the caller heard words nothing
          // kept.
          record.event("agent said", {
            seq,
            text: enqueued.join(" "),
            action: budget.action,
            capped: true,
          });
          current.llmDone = true;
          current.cancelLlm?.();
          return;
        }

        // "Okay." or "Sure." is an opener, not an answer, so it does not consume a unit.
        // Three turns in ten were cut off at a single word because it did.
        if (sentenceWords > INTERJECTION_WORDS) sentencesSpoken += 1;
        wordsSpoken += sentenceWords;
        enqueued.push(sentence);
        enqueue(current, sentence);
      }
    });

    completion.onDone((full) => {
      if (turn?.seq !== seq) return;
      current.llmDone = true;
      /* Anything the stripper held back that turned out not to be a marker — a stray `<`
         at the very end of a reply. Pushed through the sentence buffer so the tail below
         is assembled from the whole utterance rather than losing its last character. */
      const held = stripper.flush();
      if (held !== "") for (const sentence of sentences.push(held)) enqueue(current, sentence);

      /* The read, parsed after the speech is already playing. This is the whole reason the
         marker goes last: by the time it exists the caller has been listening for a
         second, so nothing here is on any stage anybody measures. */
      const parsed = parseRead(stripper.marker());
      if (parsed !== null) {
        previousRead = read;
        read = parsed;
      } else if (stripper.marker() !== null) {
        /* A marker that arrived and did not parse. Worth a line, because the vocabularies
           are shared between the prompt and the parser and this is what drift looks like:
           the read silently stops updating and nothing else says why. */
        log.debug("emotional read did not parse", { seq, marker: stripper.marker() });
      }

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
      // A turn that produced real speech is a turn that worked. R6.4 is three failures on
      // the same intent, not three across a six-minute call that was otherwise fine.
      if (full.trim().length > 0) watch.understood();
      lastUtterance = full.trim().length > 0 ? full.trim() : lastUtterance;
      // The text, not just its length. Judging whether a call felt human is impossible
      // from a character count, and Slice 4a's review loop needs the words anyway.
      // Recorded, not merely logged. Without this the stored call is one-sided: every
      // caller turn present and no reply to any of them, which is not a conversation
      // anyone can review.
      record.event("agent said", { seq, text: full.trim(), action: budget.action });

      /* Written down, not acted on. The normalizer has already stripped the formatting and
         the budget has already capped the words, so the caller heard a fine turn either
         way — what was missing is any record that the prompt had to be rescued. `seq` is
         the point: a handful of these scattered through a call is a model having a moment,
         and a cluster after turn fifteen is the history growing past what it can follow,
         which is a different fix from rewording anything. */
      /* The other half. This sees the model's whole output and so can judge formatting and
         a reply that ran long without running past the budget; the cap site above catches
         the ones cancelled before `full` ever existed. Between them every turn is covered
         once — a capped turn never reaches here, because a cancelled completion has no
         `onDone`. */
      const drift = driftIn(full);
      if (drift.drifted) {
        log.info("reply drifted from the prompt", {
          seq,
          sentences: drift.sentences,
          tooLong: drift.tooLong,
          screenFormatting: drift.screenFormatting,
        });
        record.event("drift", {
          seq,
          sentences: drift.sentences,
          tooLong: drift.tooLong,
          screenFormatting: drift.screenFormatting,
        });
      }
      // A turn ending in a question mark is a question by construction, so this is a
      // code-side rule and not a prompt one: the model does not have to cooperate for the
      // agent to know what it is still waiting on. The last question in the turn is the
      // one outstanding — the caller answers what they heard last.
      const asked = full.trim();
      if (asked.endsWith("?")) {
        deps.facts?.observe({
          field: "pendingQuestion",
          value: asked.split(/(?<=[.!?])\s+/).filter((s) => s.endsWith("?")).at(-1) ?? asked,
          source: "model",
          atMs: Date.now(),
        });
      }
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

    completion.onToolCall((calls) => {
      // Barged in, so the request that produced this is void. Nothing may be dispatched
      // on behalf of a turn the caller has already talked over.
      if (turn?.seq !== seq) return;
      if (calls.length === 0) return;

      /**
       * The half that makes the filter a guarantee rather than a hint.
       *
       * Filtering the offered list stops the model asking; it does not stop it naming a
       * tool it was never shown, and the registry would resolve that name perfectly happily
       * because it has no idea the conversation is coming apart. Recomputed here rather
       * than reusing the value from prompt time, because a tool result can arrive several
       * seconds later and the call may have gone wrong in between.
       */
      const allowed = constraintsNow();
      const refused = calls.filter(
        (call) => allowed.allowedTools !== null && !allowed.allowedTools.includes(call.name),
      );
      if (refused.length > 0) {
        log.warn("refused a tool the policy layer had withdrawn", {
          seq,
          reason: allowed.reason,
          tools: refused.map((c) => c.name),
        });
        record.event("tool_withheld", {
          seq,
          reason: allowed.reason,
          tools: refused.map((c) => c.name),
        });
        /* The caller is not left with silence and the model is not given another go: this
           call needs a person, which is what the policy said in the first place. */
        current.llmDone = true;
        if (!escalate(watch.needsAPerson(allowed.reason ?? "policy withdrew every tool"))) {
          sayNow(HOLDING_LINE, "policy withdrew the tool");
        }
        return;
      }

      if (toolset === null || toolOrganizationId === null) {
        // Unreachable while `tools` is only sent when a dispatcher exists, and handled
        // rather than ignored: a silently dropped tool call leaves the turn open with
        // nothing coming, and the caller hears four seconds of nothing before the
        // watchdog rescues it.
        log.error("the model asked for a tool on a call with no organization", {
          seq,
          tools: calls.map((c) => c.name),
        });
        current.llmDone = true;
        stopSpeaking("tool call with no organization");
        sayRecovery("tool call with no organization");
        return;
      }

      const organizationId = toolOrganizationId;
      const dispatcher = toolset.dispatcher;
      // The model asked instead of answering, so this turn produces no text of its own.
      current.llmDone = true;
      record.event("tool_batch", { organizationId, seq, tools: calls.map((c) => c.name) });
      log.info("the model asked for tools", { seq, tools: calls.map((c) => c.name) });

      void Promise.all(
        // R5.4.4. Independent lookups run together; the tier gate is per tool, so a read
        // and a write in the same batch still behave differently from each other.
        // Holding speech starts inside dispatch, before any adapter runs.
        calls.map((call) =>
          dispatcher.dispatch({
            organizationId,
            callId: stream.callId,
            direction: deps.direction,
            name: call.name,
            args: call.args,
          }),
        ),
      ).then((outcomes) => {
        if (turn?.seq !== seq) return;

        for (const outcome of outcomes) {
          /* A tool ran, so a claim to have done something is now backed by something.
             Set beside the event rather than inside the dispatcher: the guard's question is
             "did anything happen on this exchange", which is this file's to answer. */
          toolRanThisExchange = true;
          record.event("tool_call", {
            organizationId,
            tool: outcome.name,
            tier: outcome.tier,
            outcome: outcome.kind,
            latencyMs: outcome.latencyMs,
          });
        }

        /**
         * What the model is told. Never optional and never softened: a failed tool that
         * reaches the model as silence becomes a success in the next sentence.
         *
         * Written here on the branches that do not go back to the model, and by
         * `respondTo` on the one that does — the same string either way, added once.
         */
        const notes = outcomes.map(modelMessage).join("\n");
        const remember = (): void => {
          conversation.addCaller(notes);
        };

        // Two failures in a call means the thing the caller rang about cannot be done
        // here, and asking them more questions about it wastes their time.
        for (const outcome of outcomes) {
          if (outcome.kind !== "failed") continue;
          if (escalate(watch.toolFailed(outcome.name, outcome.reason))) {
            remember();
            return;
          }
        }

        const transferAt = outcomes.findIndex((o) => o.kind === "transfer");
        const transfer = outcomes[transferAt];
        if (transfer !== undefined && transfer.kind === "transfer") {
          remember();
          // R5.3. Irreversible: the dispatcher already refused to run it. The handoff
          // module owns everything that happens next — the departure line, waiting for
          // the caller to hear it, the whisper, and apologising out loud if the carrier
          // refuses. Going back to the model here would give it the chance to talk itself
          // into an alternative.
          /* One tool means something the others do not: the caller may be in danger. It
             goes to its own trigger so the handoff can dial the line that answers at any
             hour and say something other than "I cannot do that myself". */
          const trigger =
            transfer.name === "transfer_urgently"
              ? watch.callerInCrisis(transfer.reason)
              : watch.needsAPerson(transfer.reason);
          if (escalate(trigger)) return;
          // Nothing configured to transfer to. Say the dispatcher's own line, which is
          // honest about what will not happen.
          sayNow(transfer.speech, "tool needs a human");
          return;
        }

        const confirmAt = outcomes.findIndex((o) => o.kind === "confirm");
        const confirm = outcomes[confirmAt];
        const asked = calls[confirmAt];
        if (confirm !== undefined && confirm.kind === "confirm" && asked !== undefined) {
          remember();
          // R4.3.1. The readback is spoken verbatim rather than paraphrased by the model,
          // and `pendingWrite` is what the caller's next "yes" is matched against. The
          // arguments travel with it because the dispatcher refuses a confirmation whose
          // arguments moved after the caller heard them.
          pendingWrite = {
            confirmationId: confirm.confirmationId,
            name: confirm.name,
            args: asked.args,
          };
          sayNow(confirm.speech, "tool readback");
          return;
        }

        // Reads, and writes the caller already agreed to. The model turns the notes into a
        // reply; they are already sentences, so a failure here still degrades into speech.
        respondTo("", notes, "tool");
      });
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
  const captureHandled = (
    text: string,
    forModel: string,
    confidence: number | null,
  ): boolean => {
    // No gate in front of the machine any more. The old one could only reach capture
    // through a name cue or a digit run, so email, address, date, time and amount were
    // unreachable whatever the caller said. `advance` classifies the turn itself and
    // reports the answer on `handled`.
    //
    // Confidence travels with the turn and can only add checking: below a floor an
    // identifier gets one spoken attempt before the keypad instead of two. Null is passed
    // through unchanged — null is not low.
    const previous = capture;
    const result = advance(capture, {
      kind: "speech",
      text,
      confidence,
      at: Date.now(),
    });
    capture = result.state;

    // Capture is not involved in this turn — nothing to capture, or capture is over.
    //
    // Releasing rather than swallowing is what keeps an escalated caller audible. On a
    // real call at 12:12:42 on 2026-08-08 the state reached `escalate`, `advance` returned
    // it unchanged with nothing to say, this function still reported the turn as handled,
    // and the caller — who had just been told a colleague was coming — talked to a dead
    // line for the rest of the call. The state stays `escalate`, so they are never dragged
    // back into a readback; the model simply answers them like any other caller.
    if (!result.handled) return false;

    const captured = result.captured;
    const capturedKind = result.capturedKind;
    if (captured !== null && capturedKind !== null) {
      capture = idle;
      callState.apply({ kind: "capture.updated", previous, next: capture });
      log.info("value confirmed by the caller", { kind: capturedKind, chars: captured.length });
      record.event("value confirmed", { kind: capturedKind, chars: captured.length });

      /* Where the value belongs. The field the agent actually asked for wins over the
         first outstanding one of that kind: two `reference` fields are indistinguishable
         from a value, and only the question tells them apart.

         Falling back to `FACT_FIELD_FOR` is not legacy cruft — an agent with no form still
         captures reactively, and a caller who volunteers their name on a formless call
         should still have it recorded. */
      const target = form.asking() ?? form.forVolunteered(capturedKind);

      /* The organisation's own format check, run on a value the caller has already agreed
         to. Deliberately after the readback rather than before it: the engine's job is to
         establish what was said, and asking "did I hear PM eight five nine two" about a
         value that is about to be thrown away is the only way the caller learns the agent
         heard them correctly and their number is still wrong. Checking first would produce
         "sorry, say that again" to someone who said it perfectly. */
      if (target !== null && target !== undefined && !target.matches(captured)) {
        const { again } = form.reject(target.key);
        log.warn("a confirmed value did not match the configured pattern", {
          key: target.key,
          again,
        });
        // The value never appears: the pattern exists because this field carries something
        // like a policy number, and a rejected one is still a caller's identifier.
        record.event("value rejected by pattern", { key: target.key, again });

        if (again) {
          // Back to asking for the same field rather than moving on. Re-arming through
          // `expecting` is what keeps the next turn parsed as an answer to this question.
          capture = expecting(target.entity).state;
          form.beginAsking(target);
          sayNow(retryLine(target), "pattern rejected");
          return true;
        }

        // Out of attempts. `captureFailed` rather than a trigger of its own, because that
        // is what happened — the value cannot be captured, and the caller has now said it
        // correctly as many times as the operator allowed.
        if (escalate(watch.captureFailed())) return true;

        /* Nothing to transfer to. Skipping is the only honest move left: asking again is
           the loop the attempt limit exists to end, and holding the field open would stop
           the call reaching anything downstream. What the caller gave is not stored, so a
           tool needing it refuses rather than acting on a value the organisation's own
           rules reject. */
        form.skip(target.key);
        sayNow(GAVE_UP, "pattern rejected, no handoff");
        armNextField();
        return true;
      }

      const field = target?.key ?? FACT_FIELD_FOR[capturedKind];
      if (target !== null && target !== undefined) {
        form.satisfy(target.key, captured, true);
      }

      /* The answer, kept as data.
       *
       * Here rather than at `value confirmed` because here is where the field is known:
       * the pattern check has passed and `target` says which question this answers. The
       * event log records the same moment without the value, and reconstructing the pair
       * from it means matching character counts — a guess whenever two fields have answers
       * the same length.
       *
       * Buffered by the recorder like every other call-path write. Nothing here waits on
       * Postgres.
       *
       * Reactive captures on a formless agent are recorded too, under the fact field the
       * value landed in: a caller who volunteers their name has still given it. */
      if (field !== undefined) {
        record.capture({
          fieldKey: field,
          fieldType: capturedKind,
          value: captured,
          attempts: target === null || target === undefined ? 1 : form.attemptsFor(target.key),
        });
      }
      if (field !== undefined) {
        const change = deps.facts?.observe(
          target !== null && target !== undefined
            ? {
                captured: field,
                value: captured,
                source: "caller-confirmation",
                atMs: Date.now(),
              }
            : {
                // Confirmed by the caller against a readback, so it may now be used. Source
                // matters more than the value: this is one of the five provenances allowed
                // to write an identifier, and the model is not among them.
                field: FACT_FIELD_FOR[capturedKind] as IdentifierField,
                value: captured,
                source: "caller-confirmation",
                atMs: Date.now(),
              },
        );
        // A confirmed value contradicting a confirmed value is not applied — the caller
        // may be correcting themselves and the way to tell is to ask. Counted rather than
        // assumed rare; re-opening the readback belongs to capture, which owns the loop.
        if (change?.reason === "contested") {
          log.warn("a confirmed value was contradicted and not applied", { field });
          record.event("fact contested", { field });
        }
      }
      // Whatever the form wants next, so the caller's following turn is parsed as an
      // answer to it rather than guessed at.
      armNextField();

      // The model finally sees the value, and sees it as confirmed. Routed through
      // respondTo so it is recorded, budgeted and spoken like any other turn. The kind
      // comes from capture rather than from the shape of the value: shape-sniffing turned
      // a confirmed date into "My number is 2026-08-14."
      respondTo(text, confirmedUtterance(capturedKind, captured));
      return true;
    }

    callState.apply({ kind: "capture.updated", previous, next: capture });

    // Recorded here because respondTo is not running for this turn, and a history with
    // the agent's readback but not the caller's number makes no sense to the model.
    conversation.addCaller(forModel);

    if (capture.kind === "escalate") {
      log.error("capture failed, caller needs a human", { text });
      record.event("escalated to a human", { text });
      // Returning here matters: capture produces "Let me get a colleague for you" as its
      // own `say`, and the handoff speaks its own departure line. Without the early return
      // the caller hears both. With no handoff configured, capture's line is still the
      // right thing to say and is still said.
      if (escalate(watch.captureFailed())) return true;
    }

    if (capture.kind === "confirming") {
      /* In the clear, including a NIN, a BVN and a one-time code. `logSafe` masked these
         until 2026-08-15; it was removed with R5.2.4 on the rule that no caller value is
         redacted anywhere. The organisation is the data controller and the event log is
         their record of their own call. What follows from it: the log is now identifying
         data, and `recordings/` was already gitignored for exactly that reason. */
      record.event("entity_candidate", {
        subject: capture.subject,
        value: capture.value,
      });
      record.event("confirmation_requested", { subject: capture.subject, attempt: capture.attempt });
      // Recorded while it is still a candidate, so the agent does not ask for a name it is
      // at that moment in the middle of confirming. The value never reaches the model:
      // `renderFacts` renders an unconfirmed identifier as "they have given it and you are
      // still checking it", with no value in the line.
      const field = FACT_FIELD_FOR[capture.subject];
      if (field !== undefined) {
        deps.facts?.observe({
          field,
          value: capture.value,
          source: "stt",
          atMs: Date.now(),
        });
      }
      // A third go at the same thing is the point where asking again stops being useful.
      if (capture.attempt >= 3) {
        escalate(watch.misunderstood(`third readback of the ${capture.subject}`));
      }
    }
    if (result.say !== null) {
      // This turn ends here rather than at `respondTo`, so measure the stage that path
      // measures. Without it a readback turn contributes to `turn_to_audio` and to no
      // component of it — seven of nine turns on the 2026-08-23 call had a total and no
      // breakdown, which is why the three seconds could not be attributed.
      measure("stt_final", { chars: text.length, path: "capture" });
      /* They asked how you are, and this turn belongs to the form. Answer them first, in
         the same breath, or the agent reads a name back at somebody who just said hello —
         which is what the call at 17:32 did. The prompt cannot fix this: capture returns
         before the model sees the turn. */
      const courtesy =
        !courtesyOffered && asksAfterYou(text) ? pickCourtesy.next(COURTESY_REPLIES) : null;
      if (courtesy !== null) courtesyOffered = true;
      sayNow(
        courtesy === null ? result.say : withCourtesy(courtesy, result.say),
        `readback:${capture.kind}`,
      );
    }
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

    const previous = capture;
    const result = advance(capture, { kind: "keypad", digit });
    capture = result.state;

    const captured = result.captured;
    const capturedKind = result.capturedKind;
    if (captured !== null && capturedKind !== null) {
      capture = idle;
      callState.apply({ kind: "capture.updated", previous, next: capture });
      log.info("value entered on the keypad", { kind: capturedKind, chars: captured.length });
      // Tones are unambiguous, which is why `dtmf` is a confirming source in its own
      // right. The keypad is only ever offered after speech has already failed twice, so
      // this is the call most likely to need the value later.
      const field = FACT_FIELD_FOR[capturedKind];
      if (field !== undefined) {
        deps.facts?.observe({
          field,
          value: captured,
          source: "dtmf",
          atMs: Date.now(),
        });
      }
      // Mirrors the speech path so a typed reference is as visible in the log as a spoken
      // one — the handoff summary reads these, and the keypad is reached exactly when a
      // call is heading for a person.
      record.event("entity_candidate", {
        subject: capturedKind,
        value: captured,
      });
      record.event("value confirmed", { kind: capturedKind, chars: captured.length });
      respondTo(captured, confirmedUtterance(capturedKind, captured));
      return;
    }
    // Every press reports, including the ones that only lengthen `digits` — those are
    // the presses CAPTURING_ENTITY is made of.
    callState.apply({ kind: "capture.updated", previous, next: capture });
    if (result.say !== null) sayNow(result.say, "keypad");
  });

  // Recorded but never acted on. K asks that the agent not answer partials, and the
  // way to keep that honest is to be able to see how many arrived and that none of them
  // moved the conversation.
  deps.listen.transcripts.onInterim((transcript) => {
    record.event("stt_partial", { chars: transcript.text.length }, transcript.offsetMs);

    /* Still talking, so stand the stall timer down. Counting from the first word instead
       would cut across anyone giving a long answer. */
    if (transcript.text.trim() !== "") armStalledTurn();

    /* Somebody is part-way through explaining something. This is where a person would make
       a noise, and it is the only place we can: a final transcript arrives when they have
       already stopped, which is too late to be listening. */
    maybeBackchannel(transcript.text);

    /* Somebody is actually talking, so stop counting down to "nobody said anything".
     *
     * The timer exists for a cough, where no transcript ever arrives. But a *final*
     * transcript only lands at end-of-turn — when the caller stops — so a caller who cuts
     * in and then speaks for three seconds would have had the agent resume over them at
     * the one-second mark. That is precisely the defect this phase removes, rebuilt inside
     * its own recovery.
     *
     * The pending interruption is deliberately kept. Cancelling the clock is not deciding
     * the question: the final still arrives, and a backchannel still resumes through the
     * path below rather than through this timer. */
    const pending = interrupted;
    if (pending === null || transcript.text.trim().length === 0) return;
    clearTimeout(pending.timer);
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
      callState.apply({ kind: "caller.transcript.discarded", reason: "no-speech" });
      return;
    }

    const heard = interpret(transcript.text);
    if (heard.kind === "noise") {
      // Conservative on purpose: letting noise through wastes one turn, but ignoring a
      // caller who spoke makes the agent look like it is not listening.
      log.info("ignored non-speech", { reason: heard.reason, text: transcript.text });
      callState.apply({ kind: "caller.transcript.discarded", reason: "noise" });
      return;
    }
    const text = heard.raw;

    // Layer 1: this segment's speech-start was already judged to be echo. Exact match,
    // because both numbers are the same offset from the same event.
    if (echoSegments.delete(transcript.offsetMs)) {
      log.info("ignored echoed agent audio", { text, offsetMs: transcript.offsetMs });
      callState.apply({ kind: "caller.transcript.discarded", reason: "echo" });
      resumeInterrupted("echo");
      return;
    }

    const flat = normalise(text);

    /* Backchannel while the agent is speaking is listening, not interrupting.
     *
     * `turn !== null` covers the barge-in-off case, where the agent is still talking. With
     * barge-in on it is already null — `stopSpeaking` cleared it before this transcript
     * arrived — so `interrupted` covers that case, and this is the moment the guess made
     * at StartOfTurn gets settled. Both are needed; neither is redundant. */
    if ((turn !== null || interrupted !== null) && BACKCHANNEL.has(flat)) {
      log.debug("ignored backchannel", { text });
      callState.apply({ kind: "caller.transcript.discarded", reason: "backchannel" });
      resumeInterrupted("backchannel");
      return;
    }

    // A bare particle carries no proposition to answer. Checked before repair, because
    // "eh" as a continuer used to fall through and make the agent repeat itself.
    if (NIGERIAN_PARTICLES.has(flat)) {
      log.debug("ignored bare particle", { text, speaking: turn !== null });
      callState.apply({ kind: "caller.transcript.discarded", reason: "particle" });
      resumeInterrupted("particle");
      return;
    }

    /* Past the guards above, so the caller said something with content in it — the
       interruption was real. Mark the turn they cut off with an em-dash before anything
       answers them, so the model reading its own last line can tell it was cut off rather
       than that it chose to stop there. */
    confirmInterruption();

    // Layer 2: the guard only covers segments whose speech-start it saw. This catches
    // the rest by content — but only against our own recent words, never as a blanket
    // "ignore transcripts while speaking", which would swallow real barge-in.
    if (turn !== null) {
      const heardBack = flat;
      if (heardBack.length > 0 && normalise(spokenWindow).includes(heardBack)) {
        log.info("ignored transcript matching our own speech", { text });
        callState.apply({ kind: "caller.transcript.discarded", reason: "self-speech" });
        return;
      }
      // Whatever this is, it is worth seeing: it tells us on the next call whether the
      // filter above is over- or under-firing.
      log.info("transcript during agent audio", { text, spokenWindow });
    }

    // They are still talking, so they are not finished. An `end_call` the model asked for
    // before the caller's last word is not licence to hang up on them mid-sentence.
    if (hangUpAfterSpeaking !== null) {
      log.info("caller spoke again, so the call is not ending", { reason: hangUpAfterSpeaking });
      record.event("end_call_cancelled", { reason: hangUpAfterSpeaking });
      hangUpAfterSpeaking = null;
    }

    // The caller did not hear us. Say it again rather than answering something else —
    // and do it without a model round trip, because they want it now.
    if (lastUtterance !== null && isRepairRequest(flat)) {
      log.info("caller asked us to repeat", { text });
      conversation.addCaller(text);
      callState.apply({ kind: "caller.turn.dispatched" });
      // The caller not hearing us is the same broken call as us not hearing them, counted
      // in the same place.
      escalate(watch.misunderstood("caller asked us to repeat"));
      repeatLast();
      return;
    }

    // The raw text is logged and stored — it is the eval corpus and the review loop's
    // ground truth. Only the model sees the repaired version.
    log.info("caller said", { text, offsetMs: transcript.offsetMs });
    // The raw text, never the repaired one: this is the eval corpus ground truth (R9.2.3).
    record.event("caller said", { text, corrections: heard.corrections }, transcript.offsetMs);
    recordedTurns += 1;
    record.turn({
      seq: recordedTurns,
      speaker: "caller",
      // The detector's speech-start when we have it; the transcript's own offset when we
      // do not, which is late but never wrong in the other direction.
      startedOffsetMs: callerTurnStartedMs ?? transcript.offsetMs,
      endedOffsetMs: transcript.offsetMs,
      bargedInAtMs: null,
    });
    callerTurnStartedMs = null;

    record.transcript({
      text,
      confidence: transcript.confidence,
      offsetMs: transcript.offsetMs,
      provider: deps.listenProvider ?? "unknown",
    });
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

    /* They asked never to be called again. Before the handoff check and before capture,
       because this is the one thing on the caller path that outlives the call: a request
       answered with a transfer, or with another readback, is a request that never reached
       the suppression list. Recording it does not end the turn — the agent still has to
       acknowledge it out loud, and the prompt is what decides how. */
    /* A fresh thing said by the caller starts a fresh exchange, and nothing has been done
       for them yet in it. This block runs only for real caller speech — a tool result comes
       back further up and never reaches here — so the flag it just set survives. */
    toolRanThisExchange = false;

    if (asksToNotBeCalled(whole)) deps.recordDoNotCall(whole);

    // They asked to leave. Placed after the echo, backchannel, particle and repair
    // filters, so "put me through" echoed back from our own audio cannot transfer a call —
    // and before both the continuation hold and capture, because a caller mid-readback who
    // says "just give me a person" is answered today with another readback, which is the
    // exact loop R6.4 forbids.
    if (escalate(watch.callerSaid(whole))) {
      // The ask belongs in the record; no model turn follows, because they are leaving.
      conversation.addCaller(whole);
      callState.apply({ kind: "caller.turn.dispatched" });
      return;
    }

    // The answer to a readback for a write (R5.3). Before capture and before the
    // continuation hold, because "yes" is a complete answer and a caller who has just
    // been read their own details back must not be made to wait for a sentence they have
    // already finished.
    const awaiting = pendingWrite;
    if (awaiting !== null) {
      // Consumed either way. A yes fires one write, and anything else is a no.
      pendingWrite = null;
      conversation.addCaller(whole);
      callState.apply({ kind: "caller.turn.dispatched" });

      if (!isAffirmative(whole)) {
        // Defaulting to no is the safe direction, and the dispatcher enforces it anyway:
        // without the id, nothing fires. "Yeah, but…" lands here, which is correct.
        log.info("the caller did not agree to the write", { tool: awaiting.name });
        record.event("tool_confirmation_declined", { tool: awaiting.name });
        sayNow("No problem, I have left it as it is.", "confirmation declined");
        return;
      }

      if (toolset === null || toolOrganizationId === null) {
        // Unreachable: nothing can be pending without a dispatcher. Says so rather than
        // going quiet on a caller who just agreed to something.
        log.error("a write was agreed to on a call with no dispatcher", { tool: awaiting.name });
        sayRecovery("confirmed write with no dispatcher");
        return;
      }

      const organizationId = toolOrganizationId;
      const seqAtYes = turnSeq;
      record.event("tool_confirmed", { organizationId, tool: awaiting.name });
      void toolset.dispatcher
        .dispatch({
          organizationId,
          callId: stream.callId,
          /* Carried on the redemption too, not just the first attempt. The dispatcher
             refuses a write outbound before it ever looks at a confirmation id, so this is
             belt and braces — but a redemption that quietly claimed to be inbound would be
             exactly the hole the refusal exists to close. */
          direction: deps.direction,
          name: awaiting.name,
          // The same arguments, deliberately. The dispatcher fingerprints them and refuses
          // a confirmation whose arguments moved after the caller heard them.
          args: awaiting.args,
          confirmationId: awaiting.confirmationId,
        })
        .then((done) => {
          /* A tool ran, so a claim to have done something is now backed by something.
             Set beside the event rather than inside the dispatcher: the guard's question is
             "did anything happen on this exchange", which is this file's to answer. */
          toolRanThisExchange = true;
          record.event("tool_call", {
            organizationId,
            tool: done.name,
            tier: done.tier,
            outcome: done.kind,
            latencyMs: done.latencyMs,
          });
          // Recorded whatever happened next on the line: the write either fired or it did
          // not, and the model must not be able to round that off.
          conversation.addCaller(modelMessage(done));
          // The caller started a new turn while the write was in flight. Interrupting
          // them to announce it would be worse than letting the model mention it.
          if (turnSeq !== seqAtYes) {
            log.warn("the write finished after the caller had moved on", { tool: done.name });
            return;
          }
          sayNow(done.speech, "write done");
        })
        .catch((error: unknown) => {
          // `dispatch` is written not to reject. If it ever does, the caller has agreed to
          // something and is owed a sentence rather than silence.
          log.error("the dispatcher rejected, which it is not supposed to do", {
            tool: awaiting.name,
            error: error instanceof Error ? error.message : String(error),
          });
          sayRecovery("dispatcher rejected");
        });
      return;
    }

    // Never hold a turn back while a number is being confirmed. "No" and "yes" are
    // complete answers, and a caller correcting a digit must not be made to wait.
    const flatWhole = normalise(whole);
    if (capture.kind === "idle" && (endsMidThought(flatWhole) || isBareGreeting(flatWhole))) {
      log.info("caller has not finished, waiting", { text: whole });
      cancelFiller();
      callState.apply({ kind: "caller.turn.held" });
      const timer = setTimeout(() => {
        pending = null;
        log.info("caller did not continue, answering what we have", { text: whole });
        callState.apply({ kind: "caller.turn.dispatched" });
        if (!captureHandled(whole, wholeForModel, transcript.confidence)) {
          respondTo(whole, wholeForModel);
        }
      }, CONTINUATION_WAIT_MS);
      timer.unref();
      pending = { text: whole, forModel: wholeForModel, timer };
      return;
    }

    callState.apply({ kind: "caller.turn.dispatched" });

    // Before the model, never after. R4.3.1 is a gate, and a gate the model can answer
    // around is not a gate.
    if (captureHandled(whole, wholeForModel, transcript.confidence)) return;

    respondTo(whole, wholeForModel);
  });

  stream.onClosed((reason) => {
    // First, deliberately. The machine is terminal once closed, so the interruption
    // `stopSpeaking("call ended")` reports three lines down is ignored rather than logged
    // as a state change on a call that has already ended.
    callState.apply({ kind: "call.closed", reason });
    clearPending();
    cancelFiller();
    cancelWatchdog();
    cancelStalledTurn();
    /* Before `listen.close()`: a filler still armed writes into a closed session. */
    silenceFill.stop();
    echoSegments.clear();
    stopSpeaking("call ended");
    deps.listen.close();
    log.info("conversation ended", {
      reason,
      turns: turnSeq,
      /* Non-zero means the caller's network suppresses silence, which is worth knowing
         per call: it changes what the turn detector was actually working from. */
      silenceFilledFrames: silenceFill.filled(),
    });
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
  callState.apply({ kind: "agent.turn.started", seq: greetingTurn.seq, reason: "greeting" });
  lastUtterance = deps.greeting;

  /* The form's first field, armed as the greeting goes out.
     Here rather than after the caller's first turn, because a caller who opens with "hi,
     it's about policy PM eight five nine two" has already answered the first question —
     and directed parsing is exactly what turns that run of digits into a reference rather
     than a number heard in passing. Costs nothing on an agent with no form. */
  armNextField();

  /* Pay the model's setup cost now, against the greeting rather than against the caller's
     first question. The real system prompt goes with it so the vendor's prompt cache is
     primed with the prefix every turn of this call will resend. Returns nothing and cannot
     throw — see `LlmProvider.warmUp`. */
  deps.llm.warmUp(deps.systemPrompt);

  const cached = deps.greetingAudio ?? null;
  if (cached !== null && cached.length > 0) {
    // Pre-rendered: the caller hears the greeting immediately rather than after a
    // network round trip. Accounting mirrors the live path exactly so barge-in, marks
    // and history behave identically.
    greetingTurn.sentenceAudioAt = Date.now();
    // The live-synthesis branch needs nothing: it goes through enqueue -> speakNext and
    // reports from there.
    callState.apply({ kind: "agent.audio.started", seq: greetingTurn.seq });
    spokenWindow =`${spokenWindow} ${deps.forSpeech(deps.greeting)}`.slice(-400);
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
  // Recorded once per call, because a transcript is uninterpretable without it. Two
  // calls that disagree are only evidence if you know what differed between them, and
  // until now nothing wrote down which model, format or endpointing produced a line.
  record.event("call configuration", {
    listenProvider: deps.listenProvider ?? "unknown",
    encoding: stream.format.encoding,
    sampleRate: stream.format.sampleRate,
    ...(deps.transcriptionConfig ?? {}),
  });
  log.info("conversation started");
};
