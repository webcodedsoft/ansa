import { resolve } from "node:path";

import { ConfigModule } from "@nestjs/config";

/**
 * The environment, loaded the way Nest loads it.
 *
 * `ConfigModule.forRoot` reads the file into `process.env` when this module is evaluated,
 * which is before any provider factory runs — so `loadConfig`, which reads `process.env`
 * and refuses to boot on a missing value, sees the file's values without knowing a file
 * exists. The real environment wins: a key already set is left alone, so `PORT=4000` on
 * the command line and a deployment's own secrets override whatever the working copy holds.
 *
 * The repo-root `.env`, from either `src/` or `dist/`: both sit four levels below the root.
 * A missing file is not an error — a deployed process takes everything from its real
 * environment, and that is the intended shape, not a fallback.
 *
 * Imported by both `AppModule` and `ApiModule`, because the API boots on its own in tests
 * and in the dashboard-only deployment. Loading twice is harmless: the second read changes
 * nothing that is already set.
 */
export const EnvModule = ConfigModule.forRoot({
  isGlobal: true,
  envFilePath: [resolve(__dirname, "../../../../.env")],
});
