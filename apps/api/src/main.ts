import "reflect-metadata";

import type { Server } from "node:http";

import { createLogger, type Logger } from "@ansa/shared";
import { NestFactory } from "@nestjs/core";
import { Agent, setGlobalDispatcher } from "undici";

import { AppModule } from "./app.module";
import type { AppConfig } from "./config/env";
import { MediaGateway } from "./telephony/media.gateway";
import { APP_CONFIG, LOGGER } from "./telephony/tokens";

/**
 * Node's default connection pool closes idle sockets after four seconds. A caller who
 * talks for five costs a fresh TCP and TLS handshake on both the LLM and the TTS
 * request, and every barge-in destroys a socket outright. From Nigeria to US-hosted
 * APIs that handshake is a real fraction of the turn: consecutive live calls measured
 * 959ms cold against 468ms warm for the same TTS request.
 *
 * Deliberately not HTTP/2: it changes the wire protocol for every outbound request in a
 * system whose only working cancellation path is an HTTP/1.1 abort.
 */
setGlobalDispatcher(
  new Agent({ keepAliveTimeout: 60_000, keepAliveMaxTimeout: 600_000, connections: 16 }),
);

const bootstrap = async (): Promise<void> => {
  // Nest's own logger is off: every line this process writes is structured JSON from
  // @ansa/shared, so a call can be reconstructed from logs alone.
  // Nest's logger stays off — ours is the structured one. But its startup errors are
  // the only thing that explains a failed boot, so they are surfaced explicitly: with
  // `logger: false` alone, a missing provider export exits 1 and prints nothing at all,
  // which is an hour of bisecting to find a one-line fix.
  const app = await NestFactory.create(AppModule, { logger: ["error", "warn"] });
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
