import { MiddlewareConsumer, Module, NestModule } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { JwtModule } from '@nestjs/jwt';
import { APP_GUARD } from '@nestjs/core';
import { validateEnv } from './config/env.validation';
import { CorrelationIdMiddleware } from './api/correlation-id.middleware';
import { JwtAuthGuard } from './api/auth/jwt-auth.guard';
import { RolesGuard } from './api/auth/roles.guard';
import { PersistenceModule } from './infrastructure/persistence/persistence.module';
import { RiskModule } from './api/risk/risk.module';

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
    RiskModule,
  ],
  providers: [
    // Applied globally — every endpoint requires a valid JWT and passes
    // through role checking unless explicitly marked @Public(). This is
    // what makes "authenticate (JWT), authorise (role check)" true for
    // every controller by construction, rather than something each new
    // controller has to remember to re-declare.
    { provide: APP_GUARD, useClass: JwtAuthGuard },
    { provide: APP_GUARD, useClass: RolesGuard },
  ],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(CorrelationIdMiddleware).forRoutes('*');
  }
}
