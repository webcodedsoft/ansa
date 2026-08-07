import { Module } from "@nestjs/common";

import { HealthController } from "./health.controller";
import { TelephonyModule } from "./telephony/telephony.module";

@Module({
  imports: [TelephonyModule],
  controllers: [HealthController],
})
export class AppModule {}
