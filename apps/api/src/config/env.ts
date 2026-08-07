export interface AppConfig {
  readonly port: number;
  /**
   * The externally reachable origin, e.g. the ngrok URL in local dev. The carrier signs
   * the URL it called, so this must match exactly or every webhook is rejected.
   */
  readonly publicBaseUrl: string;
  readonly twilioAuthToken: string;
  readonly verifySignatures: boolean;
}

function required(env: NodeJS.ProcessEnv, key: string): string {
  const value = env[key];
  if (value === undefined || value.trim().length === 0) {
    throw new Error(`Missing required environment variable: ${key}`);
  }
  return value.trim();
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const verifySignatures = env["TWILIO_VERIFY_SIGNATURES"] !== "false";

  return {
    port: Number(env["PORT"] ?? 3000),
    // Trailing slash would produce a double slash in the signed URL and fail validation.
    publicBaseUrl: required(env, "PUBLIC_BASE_URL").replace(/\/+$/, ""),
    twilioAuthToken: verifySignatures ? required(env, "TWILIO_AUTH_TOKEN") : "",
    verifySignatures,
  };
}
