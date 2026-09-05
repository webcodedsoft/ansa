import { Module } from "@nestjs/common";

import { ApiModule } from "../api/api.module";
import { TelephonyModule } from "../telephony/telephony.module";
import { OutboundDialer } from "./dialer.sweeper";

/**
 * The dialler's own module, for the reason `EventsModule` gives about itself.
 *
 * Placing a campaign call is not telephony's job and not the dashboard's: it runs on a timer
 * with no call in sight and no request behind it. Keeping it out of both makes that structural
 * rather than merely intended.
 *
 * It imports `ApiModule` for `ORIGINATION` alone — the one door with the consent gate on it.
 * Reaching for the telephony provider directly would be quicker and would be the second
 * origination path `origination.ts` warns about, which is how the check ends up on one route
 * and not the other.
 */
@Module({
  imports: [TelephonyModule, ApiModule],
  providers: [OutboundDialer],
})
export class OutboundModule {}
