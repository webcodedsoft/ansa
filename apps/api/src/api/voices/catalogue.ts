import { withCachedListing, type VoiceCatalogue } from "@ansa/tts";

import { loadNumbersEnvironment } from "../numbers/environment";
import { voiceCatalogueFor } from "../numbers/probes";

/**
 * One catalogue for the process, rather than one per request.
 *
 * `probes.ts` builds its catalogue per request and says why: it is a closure over three
 * environment strings and holds no connection, so there is nothing to reuse and nothing to
 * wire into `api.module.ts`. That argument stops holding the moment a cache is involved. A
 * catalogue rebuilt per request has an empty cache every time, which is the same as having
 * none, and the listing is three vendor round trips.
 *
 * Held here rather than as a Nest provider because it is not organization state and never
 * can be: it describes the deployment's own ElevenLabs account, and every organisation
 * asking gets the same answer. A provider would also mean another edit to the one file
 * every agent working on this surface has open.
 */

/** Built on first use so the environment is read once the process has actually loaded it. */
let held: { readonly catalogue: VoiceCatalogue | null } | undefined;

/**
 * The catalogue this deployment can list with, or null when it holds no speech credentials.
 *
 * Null rather than a throw, and null rather than an empty list: "this deployment was never
 * given a key" is the operator's problem and reads nothing like "this account owns no
 * voices", which is the organisation's. The endpoint keeps them apart.
 */
export const listingCatalogue = (): VoiceCatalogue | null => {
  if (held === undefined) {
    const inner = voiceCatalogueFor(loadNumbersEnvironment());
    held = { catalogue: inner === null ? null : withCachedListing(inner) };
  }
  return held.catalogue;
};
