import { createLogger, type Logger } from "@ansa/shared";
import { createTwilioTelephonyProvider } from "@ansa/telephony";
import { createOpenAiLlm } from "@ansa/llm";
import { createElevenLabsTts } from "@ansa/tts";
import { Module } from "@nestjs/common";

import { type AppConfig, loadConfig } from "../config/env";
import { MediaGateway } from "./media.gateway";
import { APP_CONFIG, LLM_PROVIDER, LOGGER, TELEPHONY_PROVIDER, TTS_PROVIDER } from "./tokens";
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
    MediaGateway,
  ],
  exports: [MediaGateway, APP_CONFIG, LOGGER],
})
export class TelephonyModule {}
