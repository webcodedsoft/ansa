export interface AppConfig {
  readonly port: number;
  /**
   * The externally reachable origin, e.g. the ngrok URL in local dev. The carrier signs
   * the URL it called, so this must match exactly or every webhook is rejected.
   */
  readonly publicBaseUrl: string;
  readonly twilioAuthToken: string;
  readonly verifySignatures: boolean;
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

export const loadConfig = (env: NodeJS.ProcessEnv = process.env): AppConfig => {
  const verifySignatures = env["TWILIO_VERIFY_SIGNATURES"] !== "false";

  return {
    port: Number(env["PORT"] ?? 3000),
    // Trailing slash would produce a double slash in the signed URL and fail validation.
    publicBaseUrl: required(env, "PUBLIC_BASE_URL").replace(/\/+$/, ""),
    twilioAuthToken: verifySignatures ? required(env, "TWILIO_AUTH_TOKEN") : "",
    verifySignatures,
    // Required rather than optional: an agent that cannot speak has nothing to offer a
    // caller, so failing at boot beats failing mid-call.
    elevenLabsApiKey: required(env, "ELEVENLABS_API_KEY"),
    elevenLabsVoiceId: required(env, "ELEVENLABS_VOICE_ID"),
    elevenLabsBaseUrl: optional(env, "ELEVENLABS_BASE_URL"),
    openAiApiKey: required(env, "OPENAI_API_KEY"),
    transcriptionModel: optional(env, "TRANSCRIPTION_MODEL") ?? "gpt-live-transcribe",
    turnDetectionMode: optional(env, "TURN_DETECTION") ?? "semantic_vad",
    vadEagerness: optional(env, "VAD_EAGERNESS") ?? "auto",
    vadSilenceMs: Number(env["VAD_SILENCE_MS"] ?? 900),
  };
};
