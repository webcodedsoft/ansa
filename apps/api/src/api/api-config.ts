/**
 * The dashboard's configuration, read straight from the environment.
 *
 * Deliberately not `AppConfig` from `../config/env.ts`. That one requires a carrier token,
 * a TTS key and a transcription key, and throws at boot without them — correct for a
 * process whose job is answering calls, wrong as a precondition for serving a call list.
 * Keeping them apart is also what lets the API's integration test boot `ApiModule` on its
 * own with nothing but a database.
 */
export interface ApiConfig {
  /** Must be the `ansa_app` role. See migrations/0002_rls.sql for why that matters. */
  readonly databaseUrl: string | undefined;
  readonly poolSize: number;
}

/**
 * Small on purpose. The dashboard is not on the latency path and its queries are short, so
 * a handful of connections is enough — and the point of a separate pool is that it has a
 * ceiling the call path's pool does not have to share.
 */
const DEFAULT_POOL_SIZE = 5;

export const loadApiConfig = (env: NodeJS.ProcessEnv = process.env): ApiConfig => {
  const url = env["DATABASE_URL"]?.trim();
  const poolSize = Number(env["API_DB_POOL_SIZE"] ?? DEFAULT_POOL_SIZE);
  return {
    databaseUrl: url === undefined || url === "" ? undefined : url,
    poolSize: Number.isInteger(poolSize) && poolSize > 0 ? poolSize : DEFAULT_POOL_SIZE,
  };
};
