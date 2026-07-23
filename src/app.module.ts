import { MiddlewareConsumer, Module, NestModule } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { JwtModule } from '@nestjs/jwt';
import { APP_GUARD } from '@nestjs/core';
import { validateEnv } from './config/env.validation';
import { CorrelationIdMiddleware } from './api/correlation-id.middleware';
import { JwtAuthGuard } from './api/auth/jwt-auth.guard';
import { RolesGuard } from './api/auth/roles.guard';
import { PersistenceModule } from './infrastructure/persistence/persistence.module';
import { SharedInfrastructureModule } from './infrastructure/shared-infrastructure.module';
import { RiskModule } from './api/risk/risk.module';
import { KycModule } from './api/kyc/kyc.module';
import { AmlModule } from './api/aml/aml.module';
import { WebhooksModule } from './api/webhooks/webhooks.module';
import { DataErasureModule } from './api/data-erasure/data-erasure.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, envFilePath: '.env', validate: validateEnv }),
    JwtModule.registerAsync({
      global: true,
      useFactory: (config: ConfigService) => ({
        secret: config.get<string>('JWT_SECRET'),
        signOptions: { expiresIn: config.get<string>('JWT_EXPIRES_IN') },
      }),
      inject: [ConfigService],
    }),
    PersistenceModule,
    SharedInfrastructureModule,
    RiskModule,
    KycModule,
    AmlModule,
    WebhooksModule,
    DataErasureModule,
  ],
  providers: [
    { provide: APP_GUARD, useClass: JwtAuthGuard },
    { provide: APP_GUARD, useClass: RolesGuard },
  ],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(CorrelationIdMiddleware).forRoutes('*');
  }
}
