import type { VoiceCatalogue } from "../types";

/**
 * Does this account hold this voice?
 *
 * One `GET /v1/voices/{id}` rather than listing the account's voices and searching it.
 * The list endpoint returns what has been added to the account and omits shared voices
 * the account can nonetheless speak with, so a valid id would come back "unknown" and a
 * readiness check built on it would tell an organisation their working voice is broken.
 * The single-voice lookup resolves anything synthesis would resolve, which is the actual
 * question.
 */

export interface ElevenLabsVoiceCatalogueOptions {
  readonly apiKey: string;
  readonly baseUrl?: string;
  /** Injected in tests. Defaults to global fetch. */
  readonly fetchImpl?: typeof fetch;
}

const DEFAULT_BASE_URL = "https://api.elevenlabs.io";

/** Behind a dashboard request, so a provider that is not answering has to give up quickly. */
const REQUEST_TIMEOUT_MS = 4_000;

export const createElevenLabsVoiceCatalogue = (
  options: ElevenLabsVoiceCatalogueOptions,
): VoiceCatalogue => ({
  name: "elevenlabs",

  knows: async (voiceId: string): Promise<boolean> => {
    const doFetch = options.fetchImpl ?? globalThis.fetch;
    const base = options.baseUrl ?? DEFAULT_BASE_URL;
    const response = await doFetch(`${base}/v1/voices/${encodeURIComponent(voiceId)}`, {
      headers: { "xi-api-key": options.apiKey, Accept: "application/json" },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });

    if (response.ok) return true;
    // The only status that means "no such voice". 401 is our key, 429 is our quota, and
    // both would be a lie dressed as the organisation's mistake if they landed here.
    if (response.status === 404) return false;

    const detail = await response.text().catch(() => "");
    throw new Error(`Could not check the voice (${response.status}): ${detail.slice(0, 200)}`);
  },
});
