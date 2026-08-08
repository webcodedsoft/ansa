import { Module } from "@nestjs/common";

import { TelephonyModule } from "../telephony/telephony.module";
import { AudioRetentionSweeper } from "./audio-retention";

/**
 * Its own module, importing the telephony one purely for the config, logger and database
 * it already exports. Retention is not telephony — it runs on a timer with no call in
 * sight — and putting it here keeps the call path's module about the call path.
 */
@Module({
  imports: [TelephonyModule],
  providers: [AudioRetentionSweeper],
})
export class RetentionModule {}
