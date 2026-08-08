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
   * "openai" or "deepgram". Both stay available so they can be compared on real calls;
   * Gate A decides. Deepgram is the only one of the two that offers keyterm boosting
   * (R4.1.3) or per-word confidence (R4.1.5).
   */
  readonly listenProvider: string;
  /**
   * With listenProvider = "composite", which vendor supplies words and which supplies
   * turn boundaries. They are different problems with different winners, which is why
   * Transcriber and TurnDetector were separate interfaces from the start.
   */
  /**
   * Send OpenAI 24kHz PCM instead of the carrier's mu-law. Their docs specify PCM;
   * mu-law is accepted but undocumented. A hypothesis under measurement, not a default.
   */
  readonly openAiSendPcm: boolean;
  readonly listenWords: string;
  readonly listenTurns: string;
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
}

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

/** Whether this configuration will actually open a Deepgram connection. */
const usesDeepgram = (env: NodeJS.ProcessEnv): boolean => {
  const provider = env["LISTEN_PROVIDER"]?.trim() ?? "openai";
  if (provider === "deepgram") return true;
  if (provider !== "composite") return false;
  return (env["LISTEN_WORDS"]?.trim() ?? "openai") === "deepgram"
    || (env["LISTEN_TURNS"]?.trim() ?? "deepgram") === "deepgram";
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

    listenProvider: optional(env, "LISTEN_PROVIDER") ?? "openai",
    openAiSendPcm: env["OPENAI_SEND_PCM"] === "true",
    listenWords: optional(env, "LISTEN_WORDS") ?? "openai",
    listenTurns: optional(env, "LISTEN_TURNS") ?? "deepgram",
    // Only required when actually selected, so an OpenAI-only deployment needs no key.
    deepgramApiKey: usesDeepgram(env) ? required(env, "DEEPGRAM_API_KEY") : (optional(env, "DEEPGRAM_API_KEY") ?? ""),
    deepgramModel: optional(env, "DEEPGRAM_MODEL") ?? "flux-general-en",
    deepgramHost: optional(env, "DEEPGRAM_HOST") ?? "api.deepgram.com",
    deepgramEotThreshold: Number(env["DEEPGRAM_EOT_THRESHOLD"] ?? 0.8),
    deepgramEotTimeoutMs: Number(env["DEEPGRAM_EOT_TIMEOUT_MS"] ?? 3000),

    databaseUrl: optional(env, "DATABASE_URL"),
    viewerToken: optional(env, "VIEWER_TOKEN"),
  };
};
