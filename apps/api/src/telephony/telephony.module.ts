import { createLogger, type Logger } from "@ansa/shared";
import { createDataSource, type Db } from "@ansa/db";

import { createTwilioTelephonyProvider } from "@ansa/telephony";
import { createOpenAiLlm } from "@ansa/llm";
import { createElevenLabsTts } from "@ansa/tts";
import { Module } from "@nestjs/common";

import { type AppConfig, loadConfig } from "../config/env";
import { MediaGateway } from "./media.gateway";
import { createTenantRegistry } from "../tenancy/tenant-registry";
import {
  APP_CONFIG,
  DATA_SOURCE,
  LLM_PROVIDER,
  LOGGER,
  TELEPHONY_PROVIDER,
  TENANT_REGISTRY,
  TTS_PROVIDER,
} from "./tokens";
import { VoiceController } from "./voice.controller";

/**
 * The only place a carrier is named. Swapping Twilio means changing the factory below
 * and nothing else — which is the whole point of the adapter boundary.
 */
@Module({
  controllers: [VoiceController],
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
          return await createDataSource({ url: config.databaseUrl }).initialize();
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
      inject: [DATA_SOURCE, LOGGER],
      useFactory: (dataSource: Db | null, log: Logger) =>
        createTenantRegistry({ dataSource, log }),
    },
    MediaGateway,
  ],
  exports: [MediaGateway, APP_CONFIG, LOGGER],
})
export class TelephonyModule {}
