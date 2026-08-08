import { Module } from "@nestjs/common";

import { EventsModule } from "./events/events.module";
import { HealthController } from "./health.controller";
import { RetentionModule } from "./retention/retention.module";
import { TelephonyModule } from "./telephony/telephony.module";

@Module({
  imports: [TelephonyModule, RetentionModule, EventsModule],
  controllers: [HealthController],
})
export class AppModule {}
