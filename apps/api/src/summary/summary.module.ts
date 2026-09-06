import { Module } from "@nestjs/common";

import { TelephonyModule } from "../telephony/telephony.module";
import { CallSummarySweeper } from "./call-summary.sweeper";

/**
 * Its own module, importing the telephony one for the database, logger and model provider it
 * already exports — the same arrangement `RetentionModule` uses, and for the same reason.
 *
 * Summarising is not telephony. It runs on a timer with no call in sight, and it uses the same
 * model as the orchestrator only because there is no reason yet for it to use a different one.
 * Keeping it out of the call path's module is what makes that separable: the day a cheaper
 * model is right for finished calls, one provider changes here and nothing on the phone line
 * notices.
 */
@Module({
  imports: [TelephonyModule],
  providers: [CallSummarySweeper],
})
export class SummaryModule {}
