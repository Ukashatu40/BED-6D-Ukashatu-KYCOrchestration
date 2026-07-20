import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { validateEnv } from './config/env.validation';
import { RiskModule } from './api/risk/risk.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: '.env',
      validate: validateEnv,
    }),
    RiskModule,
    // KycModule, AmlModule, AuditModule, DataErasureModule, WebhooksModule
    // are added here as each is built out below.
  ],
})
export class AppModule {}
