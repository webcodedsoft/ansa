import "reflect-metadata";

import type { Db } from "@ansa/db";
import { Inject, Injectable, Module } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { afterEach, describe, expect, it } from "vitest";

import { AppModule } from "./app.module";
import { EventDeliverySweeper } from "./events/delivery.sweeper";
import { AudioRetentionSweeper } from "./retention/audio-retention";
import { MediaGateway } from "./telephony/media.gateway";
import { APP_CONFIG, DATA_SOURCE, LOGGER, ORGANIZATION_REGISTRY, TTS_PROVIDER } from "./telephony/tokens";

/**
 * The application starts.
 *
 * This test exists because on 2026-08-09 it did not, and nothing noticed. `EventsModule`
 * injected `ORGANIZATION_REGISTRY`; `TelephonyModule` provided it and did not export it; Nest
 * exited 1 before listening. Two slices had shipped in that state with lint, typecheck and
 * the whole unit suite green, because every test in the repo constructs its collaborators
 * by hand and **nothing asserted that the Nest dependency graph resolves at all**.
 *
 * A missing export is not a type error and it is not a logic error. It is only ever visible
 * at the moment the container is built, so it is only ever caught by building the container.
 *
 * Two configurations, because both are supported and only one of them was ever exercised:
 * with a database, and without one. A deployment with no `DATABASE_URL` answers every
 * number on default configuration by design, and it must start.
 */

/**
 * The minimum a process needs to exist. Not fixtures for behaviour — nothing here reaches a
 * network — only the shape `loadConfig` refuses to start without, so that what this test
 * fails on is the dependency graph rather than a missing variable.
 */
const REQUIRED_ENV: Readonly<Record<string, string>> = {
  PUBLIC_BASE_URL: "https://boot.test.invalid",
  TWILIO_AUTH_TOKEN: "boot-test-token",
  ELEVENLABS_API_KEY: "boot-test-key",
  ELEVENLABS_VOICE_ID: "boot-test-voice",
  OPENAI_API_KEY: "boot-test-key",
  /* Required unconditionally since Flux became the only turn detector. A deployment
     without it cannot hear the caller stop talking, so booting without it and finding
     out on the first call is the wrong failure — this key is now as load-bearing as the
     carrier's. */
  DEEPGRAM_API_KEY: "boot-test-key",
};

/**
 * A database that is configured and refuses connections, which is what "the database is
 * down" looks like at boot. Port 1 is reserved and never listening, so this fails fast with
 * ECONNREFUSED rather than hanging on a DNS lookup.
 */
const UNREACHABLE_DATABASE = "postgres://nobody:nothing@127.0.0.1:1/nothing";

/** A real one, if the environment has it. Absent in a unit-only run, and that is fine. */
const realDatabaseUrl = process.env["DATABASE_URL"];

const restore: (() => void)[] = [];

const withEnv = (values: Readonly<Record<string, string | undefined>>): void => {
  for (const [key, value] of Object.entries({ ...REQUIRED_ENV, ...values })) {
    const previous = process.env[key];
    restore.push(() => {
      if (previous === undefined) delete process.env[key];
      else process.env[key] = previous;
    });
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
};

afterEach(() => {
  while (restore.length > 0) restore.pop()?.();
});

/**
 * Boots exactly as `main.ts` does, minus `listen()`.
 *
 * `logger: ["error", "warn"]` is deliberate and is the second half of the same incident:
 * with `logger: false` a failed boot printed nothing at all, which turned a one-line fix
 * into an hour of bisecting. A test that hid the reason would be repeating the mistake.
 *
 * `abortOnError: false` is the one deviation, and it is forced. Nest's default on an
 * initialisation error is `process.abort()` — a native core dump, not an exception — which
 * a test runner cannot catch and cannot report. Turning it off converts the same failure
 * into a rejected promise with the offending token in its message.
 */
const boot = async (): Promise<Awaited<ReturnType<typeof NestFactory.create>>> =>
  NestFactory.create(AppModule, { logger: ["error", "warn"], abortOnError: false });

describe("the application boots", () => {
  it("resolves every provider in the graph with no database configured", async () => {
    withEnv({ DATABASE_URL: undefined });

    const app = await boot();
    try {
      // Each of these is a real cross-module injection. MediaGateway is what main.ts
      // reaches for after listen(); the two sweepers live in modules that import
      // TelephonyModule purely for what it exports, which is the seam that broke.
      expect(app.get(MediaGateway)).toBeInstanceOf(MediaGateway);
      expect(app.get(EventDeliverySweeper)).toBeInstanceOf(EventDeliverySweeper);
      expect(app.get(AudioRetentionSweeper)).toBeInstanceOf(AudioRetentionSweeper);
      expect(app.get(ORGANIZATION_REGISTRY)).toBeDefined();
      expect(app.get(LOGGER)).toBeDefined();
      expect(app.get(APP_CONFIG)).toBeDefined();
      // The supported degradation, asserted rather than assumed: no database is not an
      // error, it is a deployment that answers every number on default configuration.
      expect(app.get<Db | null>(DATA_SOURCE)).toBeNull();
    } finally {
      await app.close();
    }
  }, 30_000);

  it("still starts when a database is configured and unreachable", async () => {
    withEnv({ DATABASE_URL: UNREACHABLE_DATABASE });

    // Answering calls matters more than reading configuration. A database that cannot be
    // reached at boot must degrade to defaults, not prevent the process from starting —
    // otherwise a database outage becomes a total outage.
    const app = await boot();
    try {
      expect(app.get<Db | null>(DATA_SOURCE)).toBeNull();
      expect(app.get(MediaGateway)).toBeInstanceOf(MediaGateway);
      expect(app.get(EventDeliverySweeper)).toBeInstanceOf(EventDeliverySweeper);
    } finally {
      await app.close();
    }
  }, 30_000);

  /**
   * Which vendor speaks is a boot-time decision, so these belong here rather than in a
   * unit test of `loadConfig`. The failure being guarded against is not a parse error: it
   * is a deployment that reads `TTS_PROVIDER=cartesia`, builds ElevenLabs anyway, and
   * reports a clean A/B of one vendor against itself.
   */
  describe("which vendor speaks", () => {
    it("builds ElevenLabs when nothing says otherwise", async () => {
      withEnv({ DATABASE_URL: undefined, TTS_PROVIDER: undefined });

      const app = await boot();
      try {
        expect(app.get<{ name: string }>(TTS_PROVIDER).name).toBe("elevenlabs");
      } finally {
        await app.close();
      }
    }, 30_000);

    it("builds Cartesia when asked, with everything downstream unchanged", async () => {
      withEnv({
        DATABASE_URL: undefined,
        TTS_PROVIDER: "cartesia",
        CARTESIA_API_KEY: "boot-test-key",
      });

      const app = await boot();
      try {
        expect(app.get<{ name: string }>(TTS_PROVIDER).name).toBe("cartesia");
        // The point of the interface: the media gateway resolves either without knowing.
        expect(app.get(MediaGateway)).toBeInstanceOf(MediaGateway);
      } finally {
        await app.close();
      }
    }, 30_000);

    it("refuses to boot on cartesia with no key, rather than failing on the first call", async () => {
      // A missing key discovered mid-call is a caller hearing the recovery line. This is
      // the same reasoning that made DEEPGRAM_API_KEY required.
      withEnv({ DATABASE_URL: undefined, TTS_PROVIDER: "cartesia", CARTESIA_API_KEY: undefined });

      await expect(boot()).rejects.toThrow(/CARTESIA_API_KEY/);
    }, 30_000);

    it("refuses a vendor it does not have, rather than falling back to the default", async () => {
      /* Falling back would run the whole comparison against ElevenLabs while the
         deployment believed it was running Cartesia — a wrong answer that looks right. */
      withEnv({ DATABASE_URL: undefined, TTS_PROVIDER: "elevenlab" });

      await expect(boot()).rejects.toThrow(/TTS_PROVIDER/);
    }, 30_000);
  });

  it.skipIf(realDatabaseUrl === undefined)(
    "resolves the graph with a real database attached",
    async () => {
      withEnv({ DATABASE_URL: realDatabaseUrl });

      const app = await boot();
      try {
        const dataSource = app.get<Db | null>(DATA_SOURCE);
        expect(dataSource).not.toBeNull();
        // The pool is warmed at boot on purpose, so this is a live handle rather than an
        // object that will pay for TCP and TLS on the first caller's media socket.
        expect(dataSource?.isInitialized).toBe(true);
        expect(app.get(MediaGateway)).toBeInstanceOf(MediaGateway);
        expect(app.get(EventDeliverySweeper)).toBeInstanceOf(EventDeliverySweeper);
      } finally {
        await app.close();
      }
    },
    60_000,
  );
});

/**
 * The canary.
 *
 * A boot test is only worth having if it fails when the graph is broken, and "it passed"
 * proves nothing about that on its own. This reconstructs the exact defect — a provider
 * used across a module boundary that the owning module forgot to export — and asserts the
 * container refuses to build. If Nest ever became tolerant of this, the test above would
 * quietly stop protecting anything and this one would tell us.
 */
describe("a provider used across a module boundary and not exported", () => {
  const SHARED = Symbol("SHARED");

  @Injectable()
  class Consumer {
    constructor(@Inject(SHARED) readonly shared: string) {}
  }

  @Module({ providers: [{ provide: SHARED, useValue: "value" }] })
  class OwnerWithoutExport {}

  @Module({ imports: [OwnerWithoutExport], providers: [Consumer] })
  class Broken {}

  @Module({ providers: [{ provide: SHARED, useValue: "value" }], exports: [SHARED] })
  class OwnerWithExport {}

  @Module({ imports: [OwnerWithExport], providers: [Consumer] })
  class Fixed {}

  it("fails to build the container, loudly", async () => {
    await expect(NestFactory.create(Broken, { logger: false, abortOnError: false })).rejects.toThrow(/SHARED/);
  });

  it("builds once the owning module exports it", async () => {
    const app = await NestFactory.create(Fixed, { logger: false, abortOnError: false });
    expect(app.get(Consumer).shared).toBe("value");
    await app.close();
  });
});
