import type { Voice, VoiceAvailability, VoiceCatalogue, VoiceLabels, VoiceListing } from "../types";

/**
 * Does this account hold this voice, and what else could it hold?
 *
 * `knows` is one `GET /v1/voices/{id}` rather than listing the account's voices and
 * searching it. The list endpoint returns what has been added to the account and omits
 * shared voices the account can nonetheless speak with, so a valid id would come back
 * "unknown" and a readiness check built on it would tell an organisation their working
 * voice is broken. The single-voice lookup resolves anything synthesis would resolve,
 * which is the actual question.
 *
 * `list` is the other half of exactly that distinction, and it is why the two endpoints
 * are both here. ElevenLabs has two populations and they answer different questions:
 *
 * - `GET /v1/voices` — the account's own voices. Every one is usable this second.
 * - `GET /v1/shared-voices` — the public library, sixteen thousand of them at the time of
 *   writing. None is usable until somebody adds it to the account, and on a free plan
 *   `free_users_allowed` decides whether they may.
 *
 * A picker that showed only the first would hide every Nigerian voice the product exists
 * to sound like. One that showed both without distinguishing them would let an operator
 * save an id that synthesises silence on the next call. So both are fetched and each voice
 * carries which population it came from.
 *
 * Nothing below this file's exports is an ElevenLabs shape. The wire types are local, the
 * mapping happens here, and what leaves is `Voice` — the same contract any other vendor
 * would have to satisfy.
 */

export interface ElevenLabsVoiceCatalogueOptions {
  readonly apiKey: string;
  readonly baseUrl?: string;
  /**
   * Which slice of the public library is worth showing, by the vendor's accent label.
   *
   * The library is far too large to list and almost all of it is American English. This is
   * the product's own answer to "which hundred are worth a Nigerian operator's attention",
   * and it is an option rather than a constant so a deployment serving somewhere else is a
   * configuration change and not a fork of this file.
   */
  readonly libraryAccent?: string;
  /** Injected in tests. Defaults to global fetch. */
  readonly fetchImpl?: typeof fetch;
}

const DEFAULT_BASE_URL = "https://api.elevenlabs.io";

const DEFAULT_LIBRARY_ACCENT = "nigerian";

/**
 * How much of the library one listing carries.
 *
 * A ceiling rather than a page cursor: this is a list somebody scrolls and filters in one
 * screen, and a second page of a hundred voices is not a thing anybody reads. The accent
 * filter already narrows the library to roughly this many.
 */
const LIBRARY_PAGE_SIZE = 100;

/** Behind a dashboard request, so a provider that is not answering has to give up quickly. */
const REQUEST_TIMEOUT_MS = 4_000;

/**
 * Longer than a single lookup, because a hundred library entries is a hundred times the
 * body. Still short enough that a stalled vendor loses the library rather than the page.
 */
const LIST_TIMEOUT_MS = 8_000;

// --------------------------------------------------------------------------
// The vendor's shapes. Local, and they do not leave this file.
// --------------------------------------------------------------------------

/** `GET /v1/voices`. Labels are a free-form map; the four we read are the four it sets. */
interface AccountVoiceBody {
  readonly voice_id?: unknown;
  readonly name?: unknown;
  readonly description?: unknown;
  readonly preview_url?: unknown;
  readonly labels?: unknown;
}

/** `GET /v1/shared-voices`. The same labels, flattened onto the entry rather than nested. */
interface SharedVoiceBody {
  readonly voice_id?: unknown;
  readonly name?: unknown;
  readonly description?: unknown;
  readonly preview_url?: unknown;
  readonly accent?: unknown;
  readonly gender?: unknown;
  readonly age?: unknown;
  readonly use_case?: unknown;
  readonly language?: unknown;
  readonly free_users_allowed?: unknown;
  readonly is_added_by_user?: unknown;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Anything that is not a non-empty string is absent. The vendor sends both `null` and `""`. */
const asText = (value: unknown): string | null =>
  typeof value === "string" && value.trim() !== "" ? value.trim() : null;

const asList = (value: unknown): readonly unknown[] => (Array.isArray(value) ? value : []);

const labelsFrom = (source: Record<string, unknown>): VoiceLabels => ({
  accent: asText(source["accent"]),
  gender: asText(source["gender"]),
  age: asText(source["age"]),
  useCase: asText(source["use_case"]),
  language: asText(source["language"]),
});

const NO_LABELS: VoiceLabels = {
  accent: null,
  gender: null,
  age: null,
  useCase: null,
  language: null,
};

/**
 * One account voice, or null if it carries no id.
 *
 * A voice with no id cannot be selected and cannot be spoken with, so it is dropped rather
 * than shown as an unselectable row — there would be nothing to say about it.
 */
const accountVoice = (entry: unknown): Voice | null => {
  if (!isRecord(entry)) return null;
  const body = entry as AccountVoiceBody;
  const voiceId = asText(body.voice_id);
  if (voiceId === null) return null;
  return {
    voiceId,
    name: asText(body.name) ?? voiceId,
    description: asText(body.description),
    availability: "usable",
    previewUrl: asText(body.preview_url),
    labels: isRecord(body.labels) ? labelsFrom(body.labels) : NO_LABELS,
  };
};

/**
 * One library voice, priced against the plan.
 *
 * `free_users_allowed` is only a gate on a free plan. Reading it as "paid voice" on a paid
 * plan would grey out most of the library for an account that can add every entry in it.
 */
const libraryVoice = (entry: unknown, planIsFree: boolean): Voice | null => {
  if (!isRecord(entry)) return null;
  const body = entry as SharedVoiceBody;
  const voiceId = asText(body.voice_id);
  if (voiceId === null) return null;
  const allowed = body.free_users_allowed === true;
  const availability: VoiceAvailability = planIsFree && !allowed ? "beyond-plan" : "addable";
  return {
    voiceId,
    name: asText(body.name) ?? voiceId,
    description: asText(body.description),
    availability,
    previewUrl: asText(body.preview_url),
    labels: labelsFrom(entry),
  };
};

/** Usable first, then what could be added, then what could not. Alphabetical inside each. */
const RANK: Readonly<Record<VoiceAvailability, number>> = {
  usable: 0,
  addable: 1,
  "beyond-plan": 2,
};

const byUsefulness = (left: Voice, right: Voice): number =>
  RANK[left.availability] - RANK[right.availability] ||
  left.name.localeCompare(right.name, "en");

export const createElevenLabsVoiceCatalogue = (
  options: ElevenLabsVoiceCatalogueOptions,
): VoiceCatalogue => {
  const doFetch = (): typeof fetch => options.fetchImpl ?? globalThis.fetch;
  const base = (): string => options.baseUrl ?? DEFAULT_BASE_URL;

  const get = async (path: string, timeoutMs: number): Promise<Response> =>
    doFetch()(`${base()}${path}`, {
      headers: { "xi-api-key": options.apiKey, Accept: "application/json" },
      signal: AbortSignal.timeout(timeoutMs),
    });

  /**
   * Read a JSON body, or throw with the status on it.
   *
   * The status is in the message because it is the part that says whose problem this is:
   * 401 is our key, 429 is our quota, and neither is something the organisation can fix by
   * choosing a different voice.
   */
  const readJson = async (response: Response, what: string): Promise<unknown> => {
    if (!response.ok) {
      const detail = await response.text().catch(() => "");
      throw new Error(`Could not read ${what} (${response.status}): ${detail.slice(0, 200)}`);
    }
    return response.json();
  };

  return {
    name: "elevenlabs",

    knows: async (voiceId: string): Promise<boolean> => {
      const response = await get(`/v1/voices/${encodeURIComponent(voiceId)}`, REQUEST_TIMEOUT_MS);

      if (response.ok) return true;
      // The only status that means "no such voice". 401 is our key, 429 is our quota, and
      // both would be a lie dressed as the organisation's mistake if they landed here.
      if (response.status === 404) return false;

      const detail = await response.text().catch(() => "");
      throw new Error(`Could not check the voice (${response.status}): ${detail.slice(0, 200)}`);
    },

    list: async (): Promise<VoiceListing> => {
      /* Two reads of the account, and both must succeed. The plan is part of reading the
         account rather than a separate courtesy: without the tier there is no honest
         answer to "may I add this", and guessing "yes" would put an operator in front of a
         voice their plan refuses at the moment they try to use it. */
      const [voicesBody, planBody] = await Promise.all([
        get("/v1/voices", LIST_TIMEOUT_MS).then((r) => readJson(r, "this account's voices")),
        get("/v1/user/subscription", REQUEST_TIMEOUT_MS).then((r) => readJson(r, "this account")),
      ]);

      const onAccount = asList(isRecord(voicesBody) ? voicesBody["voices"] : [])
        .map(accountVoice)
        .filter((voice): voice is Voice => voice !== null);

      const planIsFree = isRecord(planBody) && asText(planBody["tier"]) === "free";

      /* The library is a nicety and the account is not, so its failure is reported rather
         than thrown. Everything already gathered is correct and usable; what is lost is the
         list of what could be added, and `libraryUnread` is how the console says so instead
         of quietly showing a short list as though it were the whole world. */
      const accent = options.libraryAccent ?? DEFAULT_LIBRARY_ACCENT;
      const query = new URLSearchParams({
        accent,
        language: "en",
        page_size: String(LIBRARY_PAGE_SIZE),
      });

      let libraryBody: unknown;
      try {
        libraryBody = await readJson(
          await get(`/v1/shared-voices?${query.toString()}`, LIST_TIMEOUT_MS),
          "the voice library",
        );
      } catch {
        return { voices: [...onAccount].sort(byUsefulness), libraryUnread: true };
      }

      // A library entry the account has already copied is the same voice twice, and one of
      // the two says "add this first" about a voice that is already there.
      const held = new Set(onAccount.map((voice) => voice.voiceId));
      const fromLibrary = asList(isRecord(libraryBody) ? libraryBody["voices"] : [])
        .map((entry) => libraryVoice(entry, planIsFree))
        .filter((voice): voice is Voice => voice !== null && !held.has(voice.voiceId));

      return {
        voices: [...onAccount, ...fromLibrary].sort(byUsefulness),
        libraryUnread: false,
      };
    },
  };
};
