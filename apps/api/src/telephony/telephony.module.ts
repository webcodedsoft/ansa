import { createLogger, type Logger } from "@ansa/shared";
import { createDataSource, type Db } from "@ansa/db";

import { createTwilioTelephonyProvider } from "@ansa/telephony";
import { createOpenAiLlm } from "@ansa/llm";
import { createElevenLabsTts } from "@ansa/tts";
import { Module } from "@nestjs/common";

import { type AppConfig, loadConfig } from "../config/env";
import { MediaGateway } from "./media.gateway";
import { createAgentRegistry } from "../tenancy/agent-registry";
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
  ORGANIZATION_REGISTRY,
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
          ...(config.elevenLabsModelId === undefined
            ? {}
            : { modelId: config.elevenLabsModelId }),
          /* Spread one key at a time so an unset knob stays absent from the object. A
             `stability: undefined` would be a key ElevenLabs sees, and it merges what it
             is sent over the voice's own settings. */
          voiceSettings: {
            ...(config.elevenLabsStability === undefined
              ? {}
              : { stability: config.elevenLabsStability }),
            ...(config.elevenLabsSimilarityBoost === undefined
              ? {}
              : { similarityBoost: config.elevenLabsSimilarityBoost }),
            ...(config.elevenLabsStyle === undefined ? {} : { style: config.elevenLabsStyle }),
            ...(config.elevenLabsSpeakerBoost === undefined
              ? {}
              : { useSpeakerBoost: config.elevenLabsSpeakerBoost }),
            ...(config.elevenLabsSpeed === undefined ? {} : { speed: config.elevenLabsSpeed }),
          },
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
      provide: ORGANIZATION_REGISTRY,
      inject: [DATA_SOURCE, LOGGER, APP_CONFIG],
      useFactory: (dataSource: Db | null, log: Logger, config: AppConfig) =>
        createAgentRegistry({ dataSource, log, credentialKey: config.toolCredentialKey }),
    },
    {
      // One registry per process, not per call: the carrier fetches the summary from
      // outside the call's own lifetime, over the public internet.
      provide: WHISPER_REGISTRY,
      useFactory: () => createWhisperRegistry(),
    },
    {
      // Null when unconfigured, and escalation then says so out loud rather than
      // transferring to a placeholder. R6.5 moves this into per-organization config; the shape
      // here is the one a organizations row will fill.
      provide: HANDOFF_DESTINATION,
      inject: [LOGGER],
      useFactory: (log: Logger) => resolveHandoffDestination(process.env, log),
    },
    MediaGateway,
  ],
  exports: [MediaGateway, APP_CONFIG, LOGGER, DATA_SOURCE, WHISPER_REGISTRY, HANDOFF_DESTINATION,
    // EventsModule injects the registry to resolve a call's webhook subscriptions.
    // Providing it without exporting it is a boot failure, not a lint error.
    ORGANIZATION_REGISTRY],
})
export class TelephonyModule {}
