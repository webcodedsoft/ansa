import type { VoiceCatalogue, VoiceListing } from "@ansa/tts";
import { ServiceUnavailableException } from "@nestjs/common";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { OrganizationContext } from "../tenancy/organization-context";

import { listingCatalogue } from "./catalogue";
import { VoicesController } from "./voices.controller";

vi.mock("./catalogue", () => ({ listingCatalogue: vi.fn() }));

const catalogueIs = vi.mocked(listingCatalogue);

/**
 * The controller reads exactly one thing off the context — the organisation the log line is
 * about — so the double is that one thing. A real `OrganizationContext` would need a
 * request, a guard and a pool for a route that touches no table at all.
 */
const CALLER = {
  caller: { organizationId: "org-1" },
} as unknown as OrganizationContext;

const listing = (voices: VoiceListing["voices"], libraryUnread = false): VoiceListing => ({
  voices,
  libraryUnread,
});

const catalogue = (answer: () => Promise<VoiceListing>): VoiceCatalogue => ({
  name: "elevenlabs",
  knows: async () => true,
  list: answer,
});

const OLABISI = {
  voiceId: "acct-1",
  name: "Olabisi",
  description: "warm, Nigerian",
  availability: "usable",
  previewUrl: "https://clips.test/acct-1.mp3",
  labels: {
    accent: "nigerian",
    gender: "female",
    age: "young",
    useCase: "conversational",
    language: "en",
  },
} as const;

describe("listing the voices an operator may choose between", () => {
  beforeEach(() => {
    catalogueIs.mockReset();
  });

  it("hands back the catalogue's own order and its own field names", async () => {
    catalogueIs.mockReturnValue(catalogue(async () => listing([OLABISI])));

    const response = await new VoicesController(CALLER).list();

    expect(response.libraryUnread).toBe(false);
    expect(response.voices).toEqual([OLABISI]);
  });

  /**
   * The rule this whole seam exists for. `voice_id` reaching the console would make swapping
   * the speech vendor a change to every screen that renders a voice.
   */
  it("emits no vendor field name", async () => {
    catalogueIs.mockReturnValue(catalogue(async () => listing([OLABISI])));

    const [first] = (await new VoicesController(CALLER).list()).voices;

    expect(Object.keys(first ?? {}).sort()).toEqual([
      "availability",
      "description",
      "labels",
      "name",
      "previewUrl",
      "voiceId",
    ]);
  });

  /**
   * "This deployment was never given a key" is the operator's problem and "this account owns
   * no voices" is the organisation's. A 200 with an empty list would say the second while
   * meaning the first, and send somebody to the wrong vendor console.
   */
  it("refuses rather than answering empty when the deployment holds no credentials", async () => {
    catalogueIs.mockReturnValue(null);

    await expect(new VoicesController(CALLER).list()).rejects.toThrow(ServiceUnavailableException);
  });

  it("answers empty, and only empty, for an account that genuinely holds nothing", async () => {
    catalogueIs.mockReturnValue(catalogue(async () => listing([])));

    await expect(new VoicesController(CALLER).list()).resolves.toEqual({
      voices: [],
      libraryUnread: false,
    });
  });

  /**
   * A speech vendor's error text can carry a key prefix, and this response is read by an
   * organisation's staff. The same rule `probes.ts` keeps for the carrier.
   */
  it("does not put the vendor's own error text in the response", async () => {
    catalogueIs.mockReturnValue(
      catalogue(async () => {
        throw new Error("401 Unauthorized: key sk_abc123");
      }),
    );

    await expect(new VoicesController(CALLER).list()).rejects.toThrow(
      /the elevenlabs account could not be read/,
    );
    await expect(new VoicesController(CALLER).list()).rejects.not.toThrow(/sk_abc123/);
  });

  /** A library that did not answer travels with the list rather than being smoothed over. */
  it("carries the library's absence through to the response", async () => {
    catalogueIs.mockReturnValue(catalogue(async () => listing([OLABISI], true)));

    await expect(new VoicesController(CALLER).list()).resolves.toMatchObject({
      libraryUnread: true,
    });
  });
});
