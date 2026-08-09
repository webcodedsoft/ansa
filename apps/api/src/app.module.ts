import { Module } from "@nestjs/common";

import { ApiModule } from "./api/api.module";
import { EventsModule } from "./events/events.module";
import { HealthController } from "./health.controller";
import { RetentionModule } from "./retention/retention.module";
import { TelephonyModule } from "./telephony/telephony.module";

@Module({
  imports: [TelephonyModule, RetentionModule, EventsModule, ApiModule],
  controllers: [HealthController],
})
export class AppModule {}
