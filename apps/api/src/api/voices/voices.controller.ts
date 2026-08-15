import type { Voice, VoiceAvailability } from "@ansa/tts";
import { createLogger } from "@ansa/shared";
import { Controller, Get, Inject, ServiceUnavailableException } from "@nestjs/common";

import { Endpoint } from "../http/endpoint";
import { apiRoute } from "../http/request";
import { choice, flag, list, nullable, object, text, type Infer } from "../http/schema";
import { OrganizationContext } from "../tenancy/organization-context";

import { listingCatalogue } from "./catalogue";

/**
 * The voices an operator may choose between, so that choosing one is not typing an id.
 *
 * A voice id is the one configuration field with no shape to check and no forgiving
 * failure. `docs/ONBOARDING_RUNBOOK.md` records what a wrong one costs: it publishes
 * happily, the first call synthesises nothing, retries once and hangs up. `GET /readiness`
 * catches that afterwards. This catches it before, by making the wrong id unpickable.
 *
 * **Not organization data, and deliberately so.** The list describes the deployment's own
 * speech account, so every organisation asking gets the same answer and the answer is
 * cached for the process. `config:read` all the same — it is the vocabulary of the field it
 * fills in, and inventing a `voices:read` would mean two names for one permission.
 *
 * Read-only, and it adds nothing to the speech account. Adding a library voice is an act at
 * the vendor with a billing consequence, and an endpoint that could do it on a `config:read`
 * would be a spend button wearing a read capability.
 */

/**
 * A record keyed by the type rather than a bare array: a state added to `VoiceAvailability`
 * stops compiling here, which is a better place to find out than a 500 from the response
 * validator when the first voice in that state comes back.
 */
const AVAILABILITY = {
  usable: true,
  addable: true,
  "beyond-plan": true,
} satisfies Record<VoiceAvailability, true>;

const availability = choice(Object.keys(AVAILABILITY) as readonly VoiceAvailability[]);

/**
 * No `maxLength` on anything here. Every string is the vendor's, projected outward rather
 * than accepted inward, and a bound on the way out is not a guard — it is a way to turn one
 * unusually long publisher biography into a 500 that blames us.
 */
const voice = object({
  voiceId: text(),
  name: text(),
  /** The publisher's own sentence. Null when they wrote none. */
  description: nullable(text()),
  availability,
  /**
   * A clip of the voice speaking the publisher's sample, fetchable without our credentials.
   *
   * It is not this agent's greeting in this voice, and whatever plays it has to say so.
   * Nothing on this surface synthesises: a preview endpoint would put the TTS provider, its
   * key and its per-character bill behind a button anybody with `config:read` can hold down.
   */
  previewUrl: nullable(text()),
  /** What the list is navigated by. Every one is the publisher's metadata, so every one is nullable. */
  labels: object({
    accent: nullable(text()),
    gender: nullable(text()),
    age: nullable(text()),
    useCase: nullable(text()),
    language: nullable(text()),
  }),
});

const voiceListing = object({
  /** Usable first, then what could be added. Ordered by the catalogue, not re-sorted here. */
  voices: list(voice),
  /**
   * The public library did not answer, so this is only what is on the account.
   *
   * Reported rather than swallowed. Everything in `voices` is still correct; what is
   * missing is the "what else could I have" half, and a short list with no flag on it reads
   * as though the library were empty.
   */
  libraryUnread: flag(),
});

const log = createLogger({ component: "api-voices" });

const toResponse = (entry: Voice): Infer<typeof voice> => ({
  voiceId: entry.voiceId,
  name: entry.name,
  description: entry.description,
  availability: entry.availability,
  previewUrl: entry.previewUrl,
  labels: {
    accent: entry.labels.accent,
    gender: entry.labels.gender,
    age: entry.labels.age,
    useCase: entry.labels.useCase,
    language: entry.labels.language,
  },
});

@Controller(apiRoute("voices"))
export class VoicesController {
  constructor(@Inject(OrganizationContext) private readonly db: OrganizationContext) {}

  @Get()
  @Endpoint({
    summary: "The voices this deployment's speech account can speak with",
    description:
      "Two populations in one list. `usable` is on the account and safe to save right now; `addable` is in the vendor's public library and has to be added there first; `beyond-plan` is in the library and this plan may not add it. Nothing here is organisation-specific and nothing here is written. A 503 means the account could not be read at all, which is deliberately not the same answer as an empty list.",
    capability: "config:read",
    response: voiceListing,
  })
  async list(): Promise<Infer<typeof voiceListing>> {
    const catalogue = listingCatalogue();
    if (catalogue === null) {
      throw new ServiceUnavailableException(
        "this deployment holds no speech account credentials, so its voices cannot be listed",
      );
    }

    try {
      const listing = await catalogue.list();
      return { voices: listing.voices.map(toResponse), libraryUnread: listing.libraryUnread };
    } catch (error) {
      /* The vendor's own text stays in the log and out of the response, for the reason
         `probes.ts` gives: a speech vendor's error can carry a key prefix, and this response
         is read by an organisation's staff rather than by whoever holds the key. */
      log.warn("the speech account could not be listed", {
        organization_id: this.db.caller.organizationId,
        provider: catalogue.name,
        error: error instanceof Error ? error.message : String(error),
      });
      throw new ServiceUnavailableException(
        `the ${catalogue.name} account could not be read, so the voices it holds cannot be listed`,
      );
    }
  }
}
