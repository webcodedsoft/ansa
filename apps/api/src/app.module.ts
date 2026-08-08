import { Module } from "@nestjs/common";

import { HealthController } from "./health.controller";
import { RetentionModule } from "./retention/retention.module";
import { TelephonyModule } from "./telephony/telephony.module";

@Module({
  imports: [TelephonyModule, RetentionModule],
  controllers: [HealthController],
})
export class AppModule {}
