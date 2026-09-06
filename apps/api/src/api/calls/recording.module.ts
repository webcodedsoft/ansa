import { Module } from "@nestjs/common";

import { createLogger } from "@ansa/shared";

import { loadApiConfig } from "../api-config";
import { createRecordingLinks } from "./recording-links";
import { RecordingController } from "./recording.controller";
import { RECORDING_CONFIG, RECORDING_LINKS, RECORDING_LOGGER } from "./tokens";

/**
 * The pair that serves a call's audio: one endpoint mints a ticket, one spends it.
 *
 * Its own module because the two halves sit on different surfaces and must share one map.
 * `POST /calls/:callId/recording` is on the authenticated API, where the capability is checked
 * and the access is logged; `GET /recordings/:token` is not, because an `<audio>` element
 * cannot send an authorization header and the URL is therefore the only credential it can
 * carry. Providing the registry twice would give them two maps and a link that never works.
 *
 * It reads the API's own config rather than the call path's `APP_CONFIG`. Injecting that would
 * make the dashboard's module import the telephony module — the whole media stack pulled into
 * the API's dependency graph so that one endpoint can read one directory name.
 *
 * `RecordingController` is not in `API_CONTROLLERS` on purpose, and `routes.test.ts` was right
 * to refuse it: it declares no `@Endpoint` and lives outside the `/api/v1` prefix, which is
 * exactly what that guard exists to catch.
 */
@Module({
  controllers: [RecordingController],
  providers: [
    { provide: RECORDING_LINKS, useFactory: () => createRecordingLinks() },
    { provide: RECORDING_CONFIG, useFactory: () => loadApiConfig() },
    /* Its own, rather than the call path's. Reaching for that token is the import this module
       exists to avoid, and a recording fetch is not a call. */
    { provide: RECORDING_LOGGER, useFactory: () => createLogger({ component: "recordings" }) },
  ],
  exports: [RECORDING_LINKS, RECORDING_CONFIG],
})
export class RecordingModule {}
