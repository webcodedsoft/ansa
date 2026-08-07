import "reflect-metadata";

import { createLogger } from "@ansa/shared";
import { NestFactory } from "@nestjs/core";

import { AppModule } from "./app.module";

const log = createLogger({ component: "api" });

async function bootstrap(): Promise<void> {
  // Nest's own logger is off: every line this process writes is structured JSON from
  // @ansa/shared, so a call can be reconstructed from logs alone.
  const app = await NestFactory.create(AppModule, { logger: false });
  const port = Number(process.env.PORT ?? 3000);
  await app.listen(port);
  log.info("api listening", { port });
}

bootstrap().catch((error: unknown) => {
  log.error("api failed to start", { error: String(error) });
  process.exitCode = 1;
});
