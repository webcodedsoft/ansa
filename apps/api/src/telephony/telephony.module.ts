import { createLogger, type Logger } from "@ansa/shared";
import { createDataSource, type Db } from "@ansa/db";

import { createTwilioTelephonyProvider } from "@ansa/telephony";
import { createOpenAiLlm } from "@ansa/llm";
import { createElevenLabsTts } from "@ansa/tts";
import { Module } from "@nestjs/common";

import { type AppConfig, loadConfig } from "../config/env";
import { MediaGateway } from "./media.gateway";
import { createTenantRegistry } from "../tenancy/tenant-registry";
import { resolveHandoffDestination } from "../handoff/destination";
import { HandoffController } from "../handoff/handoff.controller";
import { HANDOFF_DESTINATION, WHISPER_REGISTRY } from "../handoff/tokens";
import { createWhisperRegistry } from "../handoff/whisper";
import {
  APP_CONFIG,
  DATA_SOURCE,
  LLM_PROVIDER,
  LOGGER,
  TELEPHONY_PROVIDER,
  TENANT_REGISTRY,
  TTS_PROVIDER,
} from "./tokens";
import { ViewerController } from "../viewer/viewer.controller";
import { VoiceController } from "./voice.controller";

/**
 * The only place a carrier is named. Swapping Twilio means changing the factory below
 * and nothing else — which is the whole point of the adapter boundary.
 */
@Module({
  controllers: [VoiceController, ViewerController, HandoffController],
  providers: [
    { provide: APP_CONFIG, useFactory: (): AppConfig => loadConfig() },
    { provide: LOGGER, useFactory: (): Logger => createLogger({ component: "api" }) },
    {
      provide: TELEPHONY_PROVIDER,
      inject: [APP_CONFIG],
      useFactory: (config: AppConfig) =>
        createTwilioTelephonyProvider({
          authToken: config.twilioAuthToken,
          verifySignatures: config.verifySignatures,
          ...(config.twilioAccountSid === undefined
            ? {}
            : { accountSid: config.twilioAccountSid }),
        }),
    },
    {
      provide: TTS_PROVIDER,
      inject: [APP_CONFIG],
      useFactory: (config: AppConfig) =>
        createElevenLabsTts({
          apiKey: config.elevenLabsApiKey,
          ...(config.elevenLabsBaseUrl === undefined
            ? {}
            : { baseUrl: config.elevenLabsBaseUrl }),
        }),
    },
    {
      provide: LLM_PROVIDER,
      inject: [APP_CONFIG],
      useFactory: (config: AppConfig) => createOpenAiLlm({ apiKey: config.openAiApiKey }),
    },
    {
      provide: DATA_SOURCE,
      inject: [APP_CONFIG, LOGGER],
      // Answering calls matters more than reading configuration, so a database that is
      // unreachable at boot degrades to defaults instead of preventing startup.
      useFactory: async (config: AppConfig, log: Logger): Promise<Db | null> => {
        if (config.databaseUrl === undefined) {
          log.warn("no DATABASE_URL: every number answers on default configuration");
          return null;
        }
        try {
          const dataSource = await createDataSource({ url: config.databaseUrl }).initialize();
          // initialize() does not open a connection. The first query of the process pays
          // TCP and TLS to the database's region on top of its own round trip, which was
          // measured at 1.15s on the media socket of the first outbound call after a
          // restart. Paying it here costs a caller nothing.
          await dataSource.query("select 1");
          log.info("database pool warmed");
          return dataSource;
        } catch (error) {
          log.error("database unavailable at boot, answering on defaults", {
            error: error instanceof Error ? error.message : String(error),
          });
          return null;
        }
      },
    },
    {
      provide: TENANT_REGISTRY,
      inject: [DATA_SOURCE, LOGGER, APP_CONFIG],
      useFactory: (dataSource: Db | null, log: Logger, config: AppConfig) =>
        createTenantRegistry({ dataSource, log, credentialKey: config.toolCredentialKey }),
    },
    {
      // One registry per process, not per call: the carrier fetches the summary from
      // outside the call's own lifetime, over the public internet.
      provide: WHISPER_REGISTRY,
      useFactory: () => createWhisperRegistry(),
    },
    {
      // Null when unconfigured, and escalation then says so out loud rather than
      // transferring to a placeholder. R6.5 moves this into per-tenant config; the shape
      // here is the one a tenants row will fill.
      provide: HANDOFF_DESTINATION,
      inject: [LOGGER],
      useFactory: (log: Logger) => resolveHandoffDestination(process.env, log),
    },
    MediaGateway,
  ],
  exports: [MediaGateway, APP_CONFIG, LOGGER, DATA_SOURCE, WHISPER_REGISTRY, HANDOFF_DESTINATION,
    // EventsModule injects the registry to resolve a call's webhook subscriptions.
    // Providing it without exporting it is a boot failure, not a lint error.
    TENANT_REGISTRY],
})
export class TelephonyModule {}
