import "reflect-metadata";

import type { Server } from "node:http";

import { createLogger, type Logger } from "@ansa/shared";
import { NestFactory } from "@nestjs/core";

import { AppModule } from "./app.module";
import type { AppConfig } from "./config/env";
import { MediaGateway } from "./telephony/media.gateway";
import { APP_CONFIG, LOGGER } from "./telephony/tokens";

const bootstrap = async (): Promise<void> => {
  // Nest's own logger is off: every line this process writes is structured JSON from
  // @ansa/shared, so a call can be reconstructed from logs alone.
  const app = await NestFactory.create(AppModule, { logger: false });
  app.enableShutdownHooks();

  const config = app.get<AppConfig>(APP_CONFIG);
  const log = app.get<Logger>(LOGGER);

  await app.listen(config.port);

  // ws attaches to a listening server, so this comes after listen() rather than in a
  // Nest lifecycle hook.
  app.get(MediaGateway).attachTo(app.getHttpServer() as Server);

  log.info("api listening", {
    port: config.port,
    publicBaseUrl: config.publicBaseUrl,
    verifySignatures: config.verifySignatures,
  });
};

// Last line of defence. Deliberately does NOT exit: there is no supervisor here, and
// exiting drops every call in progress to save one. A logged anomaly on a live call is
// recoverable; a dead process is not.
const fatal = createLogger({ component: "api" });
process.on("unhandledRejection", (reason: unknown) => {
  fatal.error("unhandled rejection", {
    error: reason instanceof Error ? reason.message : String(reason),
  });
});
process.on("uncaughtException", (error: Error) => {
  fatal.error("uncaught exception", { error: error.message, stack: error.stack });
});

bootstrap().catch((error: unknown) => {
  createLogger({ component: "api" }).error("api failed to start", {
    error: error instanceof Error ? error.message : String(error),
  });
  process.exitCode = 1;
});
