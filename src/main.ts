import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, NestFastifyApplication } from '@nestjs/platform-fastify';
import { ValidationPipe } from '@nestjs/common';
import { SwaggerModule, DocumentBuilder } from '@nestjs/swagger';
import { AppModule } from './app.module';
import { DomainExceptionFilter } from './api/domain-exception.filter';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create<NestFastifyApplication>(
    AppModule,
    new FastifyAdapter({ logger: true }),
  );

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
      exceptionFactory: (validationErrors) => {
        // Shapes class-validator's default output into the spec's
        // VALIDATION_ERROR envelope (p.39) rather than Nest's default array.
        return {
          getStatus: () => 400,
          getResponse: () => ({
            error: {
              code: 'VALIDATION_ERROR',
              message: 'Request validation failed',
              details: validationErrors.map((e) => ({
                field: e.property,
                reason: Object.values(e.constraints ?? {}).join(', '),
              })),
            },
          }),
        };
      },
    }),
  );

  app.useGlobalFilters(new DomainExceptionFilter());

  const config = new DocumentBuilder()
    .setTitle('KYC/AML Orchestration Service')
    .setDescription('BED-6D — Vendor-agnostic KYC/AML orchestration for QuickLend')
    .setVersion('0.1.0')
    .addBearerAuth()
    .build();
  const document = SwaggerModule.createDocument(app, config);
  SwaggerModule.setup('docs', app, document);

  const port = process.env.PORT ?? 3000;
  await app.listen(port, '0.0.0.0');
}

void bootstrap();
