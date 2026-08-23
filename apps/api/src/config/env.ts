export interface AppConfig {
  readonly port: number;
  /**
   * The externally reachable origin, e.g. the ngrok URL in local dev. The carrier signs
   * the URL it called, so this must match exactly or every webhook is rejected.
   */
  readonly publicBaseUrl: string;
  readonly twilioAuthToken: string;
  readonly verifySignatures: boolean;
  /**
   * Account SID (AC…), needed only to place outbound calls. An inbound-only deployment
   * runs without it rather than failing at boot for a capability it never uses.
   */
  readonly twilioAccountSid: string | undefined;
  readonly elevenLabsApiKey: string;
  readonly elevenLabsVoiceId: string;
  /** Overridden in local testing to point at a stub. Defaults to the real API. */
  readonly elevenLabsBaseUrl: string | undefined;
  /**
   * The speech model. `eleven_flash_v2_5` unless overridden — see the adapter for why.
   *
   * Configurable so a slow-sounding call can be tested against another model without a
   * deploy, not so a deployment can quietly end up on `eleven_v3`.
   */
  readonly elevenLabsModelId: string | undefined;
  /**
   * Voice settings, each sent only if set.
   *
   * Unset means "leave the voice as it was tuned in ElevenLabs", which is the right
   * default for a cloned brand voice: the vendor merges this object over the voice's
   * stored settings, so a default here silently replaces somebody's choice.
   */
  readonly elevenLabsStability: number | undefined;
  readonly elevenLabsSimilarityBoost: number | undefined;
  readonly elevenLabsStyle: number | undefined;
  readonly elevenLabsSpeakerBoost: boolean | undefined;
  /** Fallback pace for agents that publish none. The agent's own always wins. */
  readonly elevenLabsSpeed: number | undefined;

  /**
   * Who speaks: `elevenlabs` or `cartesia`.
   *
   * A real switch rather than a legacy escape hatch, and the difference from `LISTEN_WORDS`
   * is worth stating. Flux won turn detection outright, so that setting was deleted. Here
   * neither vendor has won: ElevenLabs Flash is ~75ms with a wider spread, Cartesia Sonic
   * ~40-90ms with a tighter one, and both publish numbers measured from US datacentres
   * which say nothing about a call from Lagos. The switch exists so real traffic can
   * settle it — `tts_first_byte` carries the provider name, so the two are separable in
   * the percentiles.
   *
   * **Switching means republishing the agent's voice.** Voice ids are per-vendor and both
   * are uuids, so nothing can catch a mismatch by inspection; the wrong one is refused on
   * the first turn of the first call.
   */
  /**
   * Small noises while the caller is still talking. Off unless a deployment says otherwise.
   *
   * Their absence is a real part of why calls feel like walkie-talkie exchanges, and the
   * failure mode when the gate around them is wrong is the agent reacting to its own noise
   * — the barge-in defect Phase 2 removed, rebuilt by the feature meant to fix the feel of
   * a call. Off until somebody has heard it on a phone.
   */
  readonly backchannel: boolean;
  readonly ttsProvider: string;
  /** Required only when `TTS_PROVIDER=cartesia`, and checked at boot rather than on a call. */
  readonly cartesiaApiKey: string | undefined;
  readonly cartesiaBaseUrl: string | undefined;
  readonly cartesiaModelId: string | undefined;
  /** Fallback pace, as above. Cartesia accepts 0.6-1.5; the console only publishes 0.7-1.2. */
  readonly cartesiaSpeed: number | undefined;

  readonly openAiApiKey: string;
  readonly transcriptionModel: string;
  /**
   * "semantic_vad" (default) or "server_vad".
   *
   * server_vad is a stopwatch and cannot tell a thinking pause from a finished
   * sentence: at 500ms a live caller was chopped mid-sentence, and raising it only
   * adds latency for everyone else. semantic_vad decides from what was said.
   */
  readonly turnDetectionMode: string;
  /**
   * semantic_vad only: "auto" (default), "low", "medium", "high".
   *
   * Measured on live calls: "low" waited 7.6 seconds before committing a plain
   * greeting, so the caller repeated themselves to check the line was alive. That is a
   * worse failure than being chopped. Lower is not safer, it is just differently wrong.
   */
  readonly vadEagerness: string;
  /** server_vad only. Ignored under semantic_vad. */
  readonly vadSilenceMs: number;

  /**
   * Send OpenAI 24kHz PCM instead of the carrier's mu-law. Their docs specify PCM;
   * mu-law is accepted but undocumented. A hypothesis under measurement, not a default.
   */
  readonly openAiSendPcm: boolean;
  /**
   * Who supplies the words: `deepgram` or `openai`.
   *
   * There is no matching setting for who supplies the *turns*. Flux always does, and
   * `LISTEN_PROVIDER` and `LISTEN_TURNS` are gone rather than defaulted, because the
   * defect this replaced was a deployment quietly running OpenAI's VAD for turn-taking
   * while the Flux adapter sat unused behind a config value.
   *
   * `deepgram` here means one connection serving both — Flux carries the transcript in
   * the same frame as the turn event. `openai` means two connections and two bills,
   * which is worth paying only while a separate transcriber measurably hears Nigerian
   * speech better than Flux does.
   */
  readonly listenWords: string;
  readonly ttsMaxConcurrent: number;
  readonly deepgramApiKey: string;
  /** Only read when `listenWords` selects it, so a deployment without Intron needs no key. */
  readonly intronApiKey: string;
  readonly intronHost: string;
  /** `en`, or a code-switched Nigerian model: `pcm`, `yo`, `ig`, `ha`. */
  readonly intronLanguage: string;
  readonly deepgramModel: string;
  /** `api.deepgram.com`, or `api.eu.deepgram.com` — nearer to Lagos, and worth measuring. */
  readonly deepgramHost: string;
  /** How sure Flux must be the caller finished. 0.5-0.9; higher interrupts less. */
  readonly deepgramEotThreshold: number;
  /** Silence backstop regardless of confidence. Below the 5000 default deliberately. */
  readonly deepgramEotTimeoutMs: number;

  /**
   * Optional. Without it the agent still answers, on default configuration for every
   * number — useful in local development, and the correct degradation if the database
   * is unreachable at boot. Must be the `ansa_app` role, never `postgres` (see 0002).
   */
  readonly databaseUrl: string | undefined;
  /**
   * Shared secret for the internal call viewer. Unset disables the viewer entirely rather
   * than disabling its authentication.
   */
  readonly viewerToken: string | undefined;
  /**
   * Where to write raw caller audio, for replaying one call through several transcribers.
   *
   * Unset means no recording, which is the default deliberately: this is a caller's voice
   * saying their policy number out loud, and `organizations.audio_retention_days` exists but is
   * not yet enforced by anything. Turn it on to diagnose, off again afterwards.
   */
  readonly recordAudioDir: string | undefined;
  /**
   * The key that opens a organization's stored credentials (R5.2.1). 32 bytes, base64.
   *
   * Optional, and null is a working configuration: without it, a organization's tools that need
   * a credential are not registered and the agent says it cannot check — rather than
   * making an anonymous request to somebody's customer API. Tools with no credential at
   * all still work.
   *
   * Never in the database. If it were, a database dump would be a credential leak and the
   * encryption would be decoration.
   */
  readonly toolCredentialKey: Buffer | null;
}

/**
 * 32 bytes or nothing, and it fails at boot rather than on a call.
 *
 * A key of the wrong length means every credential in the vault is unopenable, which
 * would present as "the organization's tools are all broken" three layers away from the cause.
 */
const credentialKey = (env: NodeJS.ProcessEnv): Buffer | null => {
  const raw = env["TOOL_CREDENTIAL_KEY"];
  if (raw === undefined || raw.trim() === "") return null;
  const key = Buffer.from(raw.trim(), "base64");
  if (key.length !== 32) {
    throw new Error("TOOL_CREDENTIAL_KEY must be 32 bytes, base64 encoded (openssl rand -base64 32)");
  }
  return key;
};

const required = (env: NodeJS.ProcessEnv, key: string): string => {
  const value = env[key];
  if (value === undefined || value.trim().length === 0) {
    throw new Error(`Missing required environment variable: ${key}`);
  }
  return value.trim();
};

const optional = (env: NodeJS.ProcessEnv, key: string): string | undefined => {
  const value = env[key];
  return value === undefined || value.trim().length === 0 ? undefined : value.trim();
};

/**
 * Absent stays absent.
 *
 * These read voice settings, where an unset knob must not become a default: ElevenLabs
 * merges what is sent over the voice's own stored settings, so a default here silently
 * replaces what somebody tuned on a cloned voice.
 */
const optionalNumber = (env: NodeJS.ProcessEnv, key: string): number | undefined => {
  const raw = optional(env, key);
  if (raw === undefined) return undefined;
  const value = Number(raw);
  if (!Number.isFinite(value)) {
    throw new Error(`${key} must be a number, got ${JSON.stringify(raw)}`);
  }
  return value;
};

const optionalFlag = (env: NodeJS.ProcessEnv, key: string): boolean | undefined => {
  const raw = optional(env, key);
  return raw === undefined ? undefined : raw === "true";
};

const SPEAKERS: readonly string[] = ["elevenlabs", "cartesia"];

/**
 * Which vendor speaks, refused at boot if it is neither.
 *
 * A typo would otherwise fall through to the default and run the whole A/B against one
 * vendor while the dashboard said it was running both — a wrong answer that looks like a
 * right one. Cartesia's key is demanded here too, for the same reason: a missing key is a
 * deployment mistake, and discovering it on the first turn of a real call means a caller
 * hears the recovery line instead.
 */
const speaker = (env: NodeJS.ProcessEnv): string => {
  const chosen = optional(env, "TTS_PROVIDER") ?? "elevenlabs";
  if (!SPEAKERS.includes(chosen)) {
    throw new Error(`TTS_PROVIDER must be one of ${SPEAKERS.join(", ")}, got ${JSON.stringify(chosen)}`);
  }
  if (chosen === "cartesia" && optional(env, "CARTESIA_API_KEY") === undefined) {
    throw new Error("TTS_PROVIDER=cartesia needs CARTESIA_API_KEY");
  }
  return chosen;
};

export const loadConfig = (env: NodeJS.ProcessEnv = process.env): AppConfig => {
  const verifySignatures = env["TWILIO_VERIFY_SIGNATURES"] !== "false";

  return {
    port: Number(env["PORT"] ?? 3000),
    // Trailing slash would produce a double slash in the signed URL and fail validation.
    publicBaseUrl: required(env, "PUBLIC_BASE_URL").replace(/\/+$/, ""),
    twilioAuthToken: verifySignatures ? required(env, "TWILIO_AUTH_TOKEN") : "",
    verifySignatures,
    twilioAccountSid: optional(env, "TWILIO_ACCOUNT_SID"),
    // Required rather than optional: an agent that cannot speak has nothing to offer a
    // caller, so failing at boot beats failing mid-call.
    elevenLabsApiKey: required(env, "ELEVENLABS_API_KEY"),
    elevenLabsVoiceId: required(env, "ELEVENLABS_VOICE_ID"),
    elevenLabsBaseUrl: optional(env, "ELEVENLABS_BASE_URL"),
    elevenLabsModelId: optional(env, "ELEVENLABS_MODEL_ID"),
    elevenLabsStability: optionalNumber(env, "ELEVENLABS_STABILITY"),
    elevenLabsSimilarityBoost: optionalNumber(env, "ELEVENLABS_SIMILARITY_BOOST"),
    elevenLabsStyle: optionalNumber(env, "ELEVENLABS_STYLE"),
    elevenLabsSpeakerBoost: optionalFlag(env, "ELEVENLABS_SPEAKER_BOOST"),
    elevenLabsSpeed: optionalNumber(env, "ELEVENLABS_SPEED"),
    backchannel: optionalFlag(env, "BACKCHANNEL") ?? false,
    ttsProvider: speaker(env),
    cartesiaApiKey: optional(env, "CARTESIA_API_KEY"),
    cartesiaBaseUrl: optional(env, "CARTESIA_BASE_URL"),
    cartesiaModelId: optional(env, "CARTESIA_MODEL_ID"),
    cartesiaSpeed: optionalNumber(env, "CARTESIA_SPEED"),
    openAiApiKey: required(env, "OPENAI_API_KEY"),
    // gpt-4o-transcribe rather than the mini variant. Measured A/B on the same voice and
    // line: mini rendered "policy" as apology, penalty and course, which is close to
    // fatal for an insurance agent; the larger model got it right twice in one sentence.
    // It costs ~114ms more to a usable transcript and nothing measurable end to end,
    // because the other stages vary by more than that.
    transcriptionModel: optional(env, "TRANSCRIPTION_MODEL") ?? "gpt-4o-transcribe",
    turnDetectionMode: optional(env, "TURN_DETECTION") ?? "semantic_vad",
    vadEagerness: optional(env, "VAD_EAGERNESS") ?? "auto",
    vadSilenceMs: Number(env["VAD_SILENCE_MS"] ?? 900),

    openAiSendPcm: env["OPENAI_SEND_PCM"] === "true",
    listenWords: optional(env, "LISTEN_WORDS") ?? "openai",
    // Only required when actually selected, so an OpenAI-only deployment needs no key.
    /* Required now, not conditional. Flux is the only turn detector, so a deployment
       without this key cannot hear the caller stop talking — it should fail at boot
       rather than answer a call and never reply. */
    /* Below ElevenLabs' per-subscription concurrent-request ceiling, deliberately: the
       remainder is headroom for a live call's own synthesis, so warming can never be the
       reason a caller waits for words. */
    ttsMaxConcurrent: Number(env["TTS_MAX_CONCURRENT"] ?? 4),

    deepgramApiKey: required(env, "DEEPGRAM_API_KEY"),
    deepgramModel: optional(env, "DEEPGRAM_MODEL") ?? "flux-general-en",
    deepgramHost: optional(env, "DEEPGRAM_HOST") ?? "api.deepgram.com",
    deepgramEotThreshold: Number(env["DEEPGRAM_EOT_THRESHOLD"] ?? 0.8),
    deepgramEotTimeoutMs: Number(env["DEEPGRAM_EOT_TIMEOUT_MS"] ?? 4000),

    /* Unlike Deepgram's, optional: Intron is one of the choices for words and a deployment
       that has not chosen it should not need a key to boot. `openWords` refuses at connect
       time when it is selected without one. */
    intronApiKey: optional(env, "INTRON_API_KEY") ?? "",
    intronHost: optional(env, "INTRON_HOST") ?? "infer.voice.intron.io",
    intronLanguage: optional(env, "INTRON_LANGUAGE") ?? "en",

    databaseUrl: optional(env, "DATABASE_URL"),
    viewerToken: optional(env, "VIEWER_TOKEN"),
    recordAudioDir: optional(env, "RECORD_AUDIO_DIR"),
    toolCredentialKey: credentialKey(env),
  };
};
