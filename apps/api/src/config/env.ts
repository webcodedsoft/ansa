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
  readonly deepgramApiKey: string;
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
    deepgramApiKey: required(env, "DEEPGRAM_API_KEY"),
    deepgramModel: optional(env, "DEEPGRAM_MODEL") ?? "flux-general-en",
    deepgramHost: optional(env, "DEEPGRAM_HOST") ?? "api.deepgram.com",
    deepgramEotThreshold: Number(env["DEEPGRAM_EOT_THRESHOLD"] ?? 0.8),
    deepgramEotTimeoutMs: Number(env["DEEPGRAM_EOT_TIMEOUT_MS"] ?? 4000),

    databaseUrl: optional(env, "DATABASE_URL"),
    viewerToken: optional(env, "VIEWER_TOKEN"),
    recordAudioDir: optional(env, "RECORD_AUDIO_DIR"),
    toolCredentialKey: credentialKey(env),
  };
};
