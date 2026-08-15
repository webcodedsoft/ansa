import { Module } from "@nestjs/common";

import { TelephonyModule } from "../telephony/telephony.module";
import { EventDeliverySweeper } from "./delivery.sweeper";

/**
 * Its own module, importing the telephony one purely for the config, logger, database and
 * organization registry it already exports — the same arrangement as `RetentionModule`, for the
 * same reason.
 *
 * Event delivery is not telephony. It runs on a timer with no call in sight, and keeping it
 * out of the call path's module is the cheapest way of making that structural rather than
 * merely intended.
 */
@Module({
  imports: [TelephonyModule],
  providers: [EventDeliverySweeper],
})
export class EventsModule {}
