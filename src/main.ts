import 'reflect-metadata';
import { Logger, ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import helmet from 'helmet';
import { AppModule } from './app.module';
import { getEnv } from './config/env';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule);
  const env = getEnv();

  app.setGlobalPrefix('api');
  app.use(helmet());
  app.enableCors({
    origin: env.CORS_ORIGIN.split(',').map((o) => o.trim()),
    // round 6: the panel authenticates with the HttpOnly session cookie, so
    // cross-origin dev requests must be allowed to carry credentials.
    credentials: true,
  });
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );

  // Interactive API docs (Bearer-auth protected routes marked accordingly)
  const swaggerConfig = new DocumentBuilder()
    .setTitle('AbrIT Ticketing API')
    .setDescription('AI-powered Telegram ticketing system — admin REST API')
    .setVersion('0.1.0')
    .addBearerAuth()
    .build();
  const document = SwaggerModule.createDocument(app, swaggerConfig);
  SwaggerModule.setup('api/docs', app, document);

  await app.listen(env.PORT);
  Logger.log(`AbrIT API listening on http://localhost:${env.PORT}/api (docs: /api/docs)`, 'Bootstrap');
}

// Round 6 fix #1: a failed bootstrap (bad Telegram token in production, DB
// unreachable, config error) must EXIT the process — a supervisor/container
// restarts it, and health tooling never sees a half-alive service.
bootstrap().catch((e: unknown) => {
  Logger.error(`Fatal bootstrap error: ${(e as Error)?.message ?? e}`, 'Bootstrap');
  process.exit(1);
});
