import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: '.env',
    }),
    // Feature modules (Kyc, Aml, Audit, Risk, DataErasure, Webhooks) are
    // registered here starting Day 5 once the API layer exists.
  ],
})
export class AppModule {}
