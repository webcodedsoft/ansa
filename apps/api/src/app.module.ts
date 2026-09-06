import { Module } from "@nestjs/common";

import { ApiModule } from "./api/api.module";
import { OutboundModule } from "./outbound/outbound.module";
import { EventsModule } from "./events/events.module";
import { HealthController } from "./health.controller";
import { RetentionModule } from "./retention/retention.module";
import { SummaryModule } from "./summary/summary.module";
import { TelephonyModule } from "./telephony/telephony.module";

@Module({
  imports: [TelephonyModule, RetentionModule,
    SummaryModule, EventsModule, ApiModule, OutboundModule],
  controllers: [HealthController],
})
export class AppModule {}
